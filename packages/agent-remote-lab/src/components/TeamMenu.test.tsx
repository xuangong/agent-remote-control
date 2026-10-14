import { act } from 'react';
import { render, unmount } from '../test/setup.js';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Team, TeamSource } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
const fixture=vi.hoisted(()=>({teams:[] as any[],attached:[] as string[],actions:[] as any[],failure:'',listFailure:''}));
vi.mock('@orchardworks/agent-remote-web/headless',async importOriginal=>({...await importOriginal<typeof import('@orchardworks/agent-remote-web/headless')>(),RemoteTeamClient:class{async list(){if(fixture.listFailure)throw new Error(fixture.listFailure);return structuredClone(fixture.teams);}async action(input:unknown){fixture.actions.push(input);if(fixture.failure)throw new Error(fixture.failure);return fixture.teams[0];}}}));
vi.mock('../directory-client.js',()=>({SessionDirectoryClient:class{async attach(_:string,id:string){fixture.attached.push(id);return {agentId:id};}}}));
vi.mock('../hooks/useConversationSession.js',()=>({useConversationSession:()=>({state:undefined,sessionState:undefined,status:'connected',actions:{},questions:{},setQuestions:()=>{}})}));
vi.mock('./LabWorkbench.js',()=>({LabWorkbench:(props:any)=><div data-testid="standard-session-view">{props.conversationPath}<textarea aria-label="Message" /></div>}));
import { TeamMenu } from './TeamMenu.js';
import { SessionTrackingMenu } from './SessionTrackingMenu.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
const team:Team={id:'team',operationId:'create',revision:1,title:'Cross-platform diagnosis',status:'active',source:{hostId:'mac',providerId:'fixture',nativeSessionId:'source',title:'Main project'},members:[
  {id:'leader',hostId:'mac',providerId:'fixture',nativeSessionId:'leader-session',role:'leader',name:'Leader',responsibility:'Coordinate',creation:'ready',activity:'idle',summary:'',updatedAt:1},
  {id:'worker',hostId:'win',providerId:'fixture',nativeSessionId:'worker-session',role:'member',name:'Windows',responsibility:'Verify',creation:'ready',activity:'idle',summary:'',updatedAt:1},
],messages:[],createdAt:1,updatedAt:1};
function App(){return <TeamMenu baseUrl="https://team.test" enabled hosts={[]} onOpen={async team=>{fixture.attached.push(team.id);return true;}} onOpenSession={async target=>{fixture.attached.push(target.nativeSessionId);return true;}}/>;}
afterEach(()=>{localStorage.clear();sessionStorage.clear();fixture.attached=[];fixture.teams=[];fixture.actions=[];fixture.failure='';fixture.listFailure='';});
it('shares the loaded Team roster with Track even when the Team menu is hidden', async () => {
  fixture.teams = [structuredClone(team)];
  const sessions = [
    ...team.members.map(member => ({ ...member, nativeSessionId: member.nativeSessionId!, title: member.name, starredAt: 1 })),
    { ...team.source, starredAt: 1 },
    { ...team.source, hostId: 'other', nativeSessionId: 'leader-session', title: 'Unrelated', starredAt: 1 },
  ];
  const tracking = { sessions, backgroundSessions: sessions, observations: {} } as unknown as SessionTracking;
  const open = vi.fn();
  function SharedMenu() {
    const [teams, setTeams] = useState<Team[]>([]);
    const [receive] = useState(() => (_scope: string, teams: Team[]) => setTeams(teams));
    return <><TeamMenu baseUrl="https://team.test" enabled visible={false} hosts={[]} onTeamsChange={receive} onOpen={async () => true} onOpenSession={async () => true} />
      <SessionTrackingMenu tracking={tracking} teams={teams} busy={false} inert={false} onOpen={open} /></>;
  }
  const view = await render(<SharedMenu />);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
  const rows = [...view.querySelectorAll<HTMLButtonElement>('.lab-tracked-row button')];
  expect(rows.map(row => row.querySelector('.lab-tracked-main')?.textContent)).toEqual(['Main: Main project', 'Main: Main project', undefined, undefined]);
  await act(async () => rows[0]!.click());
  expect(open).toHaveBeenCalledWith(sessions[0]);
  expect(fixture.attached).toEqual([]);
});
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent)?.includes(text))!;
it('groups Teams and requests a layout without mounting another workspace',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App/>);
  await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain('Main project');await act(async()=>button(view,'Cross-platform diagnosis').click());
  expect(fixture.attached).toEqual(['team']);expect(view.querySelectorAll('[data-testid="standard-session-view"]')).toHaveLength(0);
});
it('keeps archived Team management in the grouped floating menu',async()=>{
  fixture.teams=[{...structuredClone(team),status:'archived'}];const view=await render(<App/>);await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain('Archived');expect(view.textContent).toContain('Main project');
  await act(async()=>button(view,'Restore').click());expect(fixture.actions).toEqual([{teamId:'team',action:'restore'}]);expect(fixture.attached).toEqual([]);
});
it('manages archive, recovery and member navigation without opening a Team layout',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App/>);await act(async()=>button(view,'Teams').click());
  await act(async()=>button(view,'Archive').click());expect(fixture.actions).toEqual([{teamId:'team',action:'archive'}]);
  await act(async()=>button(view,'Windows').click());expect(fixture.attached).toEqual(['worker-session']);
});
it('preserves a failed action notice across successful list refreshes',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App/>);
  await act(async()=>button(view,'Teams').click());
  fixture.failure='Archive was not accepted';await act(async()=>button(view,'Archive').click());
  expect(view.textContent).toContain(fixture.failure);
  await act(async()=>button(view,'Teams').click());await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain(fixture.failure);
});

it('switches compact Team sessions in both directions through ordinary session navigation', async () => {
  fixture.teams = [structuredClone(team)];
  const opened = vi.fn(async (_target: TeamSource) => true);
  function CompactApp() {
    const [current, setCurrent] = useState<TeamSource>({ hostId: 'mac', providerId: 'fixture', nativeSessionId: 'leader-session', title: 'Leader' });
    return <TeamMenu baseUrl="https://team.test" enabled compact currentSession={current} hosts={[{ id: 'win', name: 'Office Windows', online: false }]}
      onOpen={async () => true} onOpenSession={async target => { await opened(target); setCurrent(target); return true; }} />;
  }
  const view = await render(<CompactApp />);
  await act(async () => button(view, 'Teams').click());
  const navigation = () => view.querySelector<HTMLElement>('nav[aria-label="Cross-platform diagnosis sessions"]')!;
  expect(navigation()).not.toBeNull();
  expect(navigation().closest('details')).toBeNull();
  expect(button(navigation(), 'Leader').getAttribute('aria-current')).toBe('page');
  expect(navigation().textContent).toContain('Office Windows');
  await act(async () => button(navigation(), 'Windows').click());
  expect(opened).toHaveBeenLastCalledWith({ hostId: 'win', providerId: 'fixture', nativeSessionId: 'worker-session', title: 'Windows' });
  expect(view.querySelector('section[aria-label="Teams"]')).toBeNull();
  await act(async () => button(view, 'Teams').click());
  expect(button(navigation(), 'Windows').getAttribute('aria-current')).toBe('page');
  expect(button(navigation(), 'Leader').hasAttribute('aria-current')).toBe(false);
  await act(async () => button(navigation(), 'Leader').click());
  expect(opened).toHaveBeenLastCalledWith({ hostId: 'mac', providerId: 'fixture', nativeSessionId: 'leader-session', title: 'Leader' });
});

it('keeps compact member navigation available after failure and disables unfinished slots', async () => {
  fixture.teams = [{ ...structuredClone(team), members: [...team.members,
    { ...team.members[1]!, id: 'pending', name: 'Linux', creation: 'reserved', nativeSessionId: undefined },
    { ...team.members[1]!, id: 'removed', name: 'Abandoned', creation: 'abandoned' },
  ] }];
  const opened = vi.fn(async () => false);
  const view = await render(<TeamMenu baseUrl="https://team.test" enabled compact hosts={[]}
    currentSession={{ hostId: 'other-host', providerId: 'fixture', nativeSessionId: 'worker-session' }}
    onOpen={async () => true} onOpenSession={opened} />);
  await act(async () => button(view, 'Teams').click());
  const navigation = view.querySelector<HTMLElement>('nav[aria-label="Cross-platform diagnosis sessions"]')!;
  expect(navigation).not.toBeNull();
  expect(navigation.querySelector('[aria-current]')).toBeNull();
  expect(button(navigation, 'Linux').disabled).toBe(true);
  expect(navigation.textContent).not.toContain('Abandoned');
  await act(async () => button(navigation, 'Linux').click());
  expect(opened).not.toHaveBeenCalled();
  await act(async () => button(navigation, 'Windows').click());
  expect(view.querySelector('section[aria-label="Teams"]')).not.toBeNull();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain('The session could not be opened');
  expect(button(navigation, 'Windows').disabled).toBe(false);
});

it('keeps wide Team navigation as a dock layout preset', async () => {
  fixture.teams = [structuredClone(team)];
  const view = await render(<App />);
  await act(async () => button(view, 'Teams').click());
  expect(view.querySelector('nav[aria-label="Cross-platform diagnosis sessions"]')).toBeNull();
  await act(async () => button(view, 'Cross-platform diagnosis').click());
  expect(fixture.attached).toEqual(['team']);
});

function connectionPool() {
  const closes: string[] = [];
  const connect = vi.fn<RemoteAgentTransport['connect']>(id => ({ close: () => { closes.push(id); }, send: () => {} }));
  const transport: RemoteAgentTransport = { connect, fetchSnapshot: async () => { throw new Error('Unexpected snapshot'); }, fetchTimeline: async () => { throw new Error('Unexpected history'); }, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  return { connections: new ConversationConnections(transport), connect, closes };
}

it('retains opened leaders across menu hiding, access restoration and catalog failures, then releases archived leaders', async () => {
  const f = connectionPool();
  fixture.teams = [structuredClone(team)];
  let setEnabled!: (value: boolean) => void, setVisible!: (value: boolean) => void;
  function Harness() {
    const [enabled, enable] = useState(true), [visible, show] = useState(true); setEnabled = enable; setVisible = show;
    return <ConversationConnectionScope.Provider value={f.connections}><TeamMenu baseUrl="https://team.test" enabled={enabled} visible={visible} hosts={[]} onOpen={async () => true} onOpenSession={async () => true} /></ConversationConnectionScope.Provider>;
  }
  try {
    const view = await render(<Harness />);
    expect(f.connect).not.toHaveBeenCalled();
    const leader = f.connections.acquire('leader', new AgentReplica(), { ...team.members[0]!, nativeSessionId: 'leader-session' });
    const member = f.connections.acquire('member', new AgentReplica(), { ...team.members[1]!, nativeSessionId: 'worker-session' });
    await act(async () => { leader.release(); member.release(); });
    expect(f.closes).toEqual(['member']);
    await act(async () => { setVisible(false); setEnabled(false); });
    expect(f.closes).toEqual(['member']);
    fixture.listFailure = 'Catalog temporarily unavailable';
    await act(async () => setEnabled(true));
    expect(f.closes).toEqual(['member']);
    await act(async () => setVisible(true));
    await act(async () => button(view, 'Teams').click());
    expect(view.textContent).toContain(fixture.listFailure);
    expect(f.closes).toEqual(['member']);
    fixture.listFailure = '';
    await act(async () => button(view, 'Teams').click());
    await act(async () => button(view, 'Teams').click());
    fixture.teams = [{ ...structuredClone(team), status: 'archived' }];
    await act(async () => button(view, 'Archive').click());
    expect(f.closes).toEqual(['member', 'leader']);
    expect(f.connections.agentIds).toEqual([]);
  } finally { f.connections.clear(); }
});

it('reconciles removed Teams and releases only the Team retention reason on unmount', async () => {
  const f = connectionPool();
  fixture.teams = [structuredClone(team)];
  try {
    const view = await render(<ConversationConnectionScope.Provider value={f.connections}><App /></ConversationConnectionScope.Provider>);
    const leader = f.connections.acquire('leader', new AgentReplica(), { ...team.members[0]!, nativeSessionId: 'leader-session' });
    await act(async () => leader.release());
    expect(f.closes).toEqual([]);
    fixture.teams = [];
    await act(async () => button(view, 'Teams').click());
    expect(f.closes).toEqual(['leader']);
    fixture.teams = [structuredClone(team)];
    await act(async () => button(view, 'Teams').click());
    const again = f.connections.acquire('leader', new AgentReplica(), { ...team.members[0]!, nativeSessionId: 'leader-session' });
    f.connections.retainSessions('tracked', [{ ...team.members[0]!, nativeSessionId: 'leader-session' }]);
    await act(async () => again.release());
    await unmount(view);
    expect(f.closes).toEqual(['leader']);
    f.connections.retainSessions('tracked', []);
    expect(f.closes).toEqual(['leader', 'leader']);
  } finally { f.connections.clear(); }
});
