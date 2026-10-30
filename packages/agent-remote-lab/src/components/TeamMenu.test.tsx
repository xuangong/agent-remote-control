import { act } from 'react';
import { render, unmount } from '../test/setup.js';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Team, TeamSource } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
const fixture=vi.hoisted(()=>({teams:[] as any[],attached:[] as string[],actions:[] as any[],deleted:[] as string[],failure:'',listFailure:'',create:undefined as ((input:unknown)=>Promise<Team>)|undefined}));
vi.mock('@orchardworks/agent-remote-web/headless',async importOriginal=>({...await importOriginal<typeof import('@orchardworks/agent-remote-web/headless')>(),RemoteTeamClient:class{async create(input:unknown){return fixture.create!(input);}async list(){if(fixture.listFailure)throw new Error(fixture.listFailure);return structuredClone(fixture.teams);}async action(input:unknown){fixture.actions.push(input);if(fixture.failure)throw new Error(fixture.failure);return fixture.teams[0];}async delete(teamId:string){fixture.deleted.push(teamId);}}}));
vi.mock('../directory-client.js',()=>({SessionDirectoryClient:class{async attach(_:string,id:string){fixture.attached.push(id);return {agentId:id};}}}));
vi.mock('../hooks/useConversationSession.js',()=>({useConversationSession:()=>({state:undefined,sessionState:undefined,status:'connected',actions:{},questions:{},setQuestions:()=>{}})}));
vi.mock('./LabWorkbench.js',()=>({LabWorkbench:(props:any)=><div data-testid="standard-session-view">{props.conversationPath}<textarea aria-label="Message" /></div>}));
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowLayoutContext } from '../window-workspace-context.js';
import { TeamMenu } from './TeamMenu.js';
import { SessionTrackingMenu } from './SessionTrackingMenu.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
const team:Team={id:'team',operationId:'create',revision:1,title:'Cross-platform diagnosis',status:'active',source:{hostId:'mac',providerId:'fixture',nativeSessionId:'source',title:'Main project'},members:[
  {id:'leader',hostId:'mac',providerId:'fixture',nativeSessionId:'leader-session',role:'leader',name:'Leader',responsibility:'Coordinate',creation:'ready',activity:'idle',summary:'',updatedAt:1},
  {id:'worker',hostId:'win',providerId:'fixture',nativeSessionId:'worker-session',role:'member',name:'Windows',responsibility:'Verify',creation:'ready',activity:'idle',summary:'',updatedAt:1},
],messages:[],createdAt:1,updatedAt:1};
function App(){return <TeamMenu baseUrl="https://team.test" enabled hosts={[]} onOpen={async team=>{fixture.attached.push(team.id);return true;}} onOpenSession={async target=>{fixture.attached.push(target.nativeSessionId);return true;}}/>;}
afterEach(()=>{localStorage.clear();sessionStorage.clear();fixture.attached=[];fixture.teams=[];fixture.actions=[];fixture.deleted=[];fixture.failure='';fixture.listFailure='';fixture.create=undefined;});
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
it('deletes an archived support group and drops it from the menu', async () => {
  const support: Team = { ...structuredClone(team), id: 'group', title: 'Cross review', status: 'archived',
    members: [{ ...team.members[0]!, name: 'Coordinator', access: 'read_only', workspace: { kind: 'shared' } }, { ...team.members[1]!, id: 'requester', hostId: 'mac', nativeSessionId: 'source', role: 'requester', name: 'Worker' }],
    callForSupport: { role: 'Cross review', description: '', coordinator: { providerId: 'fixture' }, status: 'active', ledger: { text: '', revision: 0 }, usage: { tokens: 0 }, calls: [],
      mandate: { supporters: [{ providerId: 'fixture', model: 'm' }], maxSupporters: 1, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' } } };
  fixture.teams = [support]; const view = await render(<App />); await act(async () => button(view, 'Teams').click());
  await act(async () => button(view, 'Delete').click());
  await act(async () => button(view, 'Confirm deletion').click());
  expect(fixture.deleted).toEqual(['group']);
  expect(view.querySelector('[aria-label="Support role Cross review"]')).toBeNull();
});
it('reveals an attribution target without opening sessions and accepts repeated requests', async () => {
  fixture.teams = [structuredClone(team)];
  let reveal!: (requestId: string) => void;
  function Harness() {
    const [request, setRequest] = useState<{ teamId: string; requestId: string }>();
    reveal = requestId => setRequest({ teamId: team.id, requestId });
    return <TeamMenu baseUrl="https://team.test" enabled hosts={[]} reveal={request}
      onOpen={async value => { fixture.attached.push(value.id); return true; }}
      onOpenSession={async value => { fixture.attached.push(value.nativeSessionId); return true; }} />;
  }
  const view = await render(<Harness />);
  expect(view.querySelector('section[aria-label="Teams"]')).toBeNull();
  await act(async () => reveal('first'));
  const target = button(view, 'Cross-platform diagnosis');
  expect(target.getAttribute('aria-current')).toBe('true');
  expect(document.activeElement).toBe(target);
  expect(fixture.attached).toEqual([]);
  expect(fixture.actions).toEqual([]);
  await act(async () => button(view, 'Close Teams').click());
  expect(view.querySelector('section[aria-label="Teams"]')).toBeNull();
  await act(async () => reveal('second'));
  expect(view.querySelector('section[aria-label="Teams"]')).not.toBeNull();
  expect(document.activeElement).toBe(button(view, 'Cross-platform diagnosis'));
  expect(fixture.attached).toEqual([]);
});
it('reveals an archived Team once its roster arrives and keeps compact navigation unchanged', async () => {
  fixture.teams = [{ ...structuredClone(team), status: 'archived' }];
  const opened = vi.fn(async () => true);
  const view = await render(<TeamMenu baseUrl="https://team.test" enabled compact hosts={[]}
    currentSession={{ hostId: 'other-host', providerId: 'fixture', nativeSessionId: 'elsewhere' }}
    reveal={{ teamId: team.id, requestId: 'archived-target' }} onOpen={opened} onOpenSession={opened} />);
  const target = button(view, 'Cross-platform diagnosis');
  expect(target.getAttribute('aria-current')).toBe('true');
  expect(target.closest('details')?.open).toBe(true);
  expect(document.activeElement).toBe(target);
  expect(opened).not.toHaveBeenCalled();
  expect(view.querySelectorAll('.lab-team-session-navigation [aria-current]')).toHaveLength(0);
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
  expect(opened).toHaveBeenLastCalledWith({ teamId: 'team', teamMemberId: 'worker', hostId: 'win', providerId: 'fixture', nativeSessionId: 'worker-session', title: 'Windows' });
  expect(view.querySelector('section[aria-label="Teams"]')).toBeNull();
  await act(async () => button(view, 'Teams').click());
  expect(button(navigation(), 'Windows').getAttribute('aria-current')).toBe('page');
  expect(button(navigation(), 'Leader').hasAttribute('aria-current')).toBe(false);
  await act(async () => button(navigation(), 'Leader').click());
  expect(opened).toHaveBeenLastCalledWith({ teamId: 'team', teamMemberId: 'leader', hostId: 'mac', providerId: 'fixture', nativeSessionId: 'leader-session', title: 'Leader' });
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


it.each(['Confirm received', 'Confirm not executed'])('offers %s for accepted input without native disposition', async label => {
  fixture.teams = [{ ...structuredClone(team), messages: [{ id: 'uncertain', from: 'leader', to: 'worker', text: 'Inspect once', status: 'accepted', createdAt: 1 }] }];
  const view = await render(<App />);
  await act(async () => button(view, 'Teams').click());
  expect(view.querySelector('.lab-team-recovery')?.textContent).toContain('Inspect once');
  await act(async () => button(view, label).click());
  expect(fixture.actions).toEqual([{ teamId: 'team', action: 'resolve_message', messageId: 'uncertain', outcome: label === 'Confirm received' ? 'accepted' : 'rejected' }]);
  expect(fixture.attached).toEqual([]);
});


it.each(['Confirm received', 'Confirm not executed'])('discovers compact uncertainty and offers %s without the original body', async label => {
  fixture.teams = [{ ...structuredClone(team), unresolvedReceipts: [{ id: 'legacy', from: 'leader', to: 'worker', status: 'accepted', createdAt: 1 }] }];
  const view = await render(<App />);
  await act(async () => button(view, 'Teams').click());
  expect(view.querySelector('.lab-team-recovery')?.textContent).toContain('Original message body is unavailable.');
  expect(view.querySelector('.lab-team-recovery')?.textContent).toContain('Delivery legacy to Windows');
  await act(async () => button(view, label).click());
  expect(fixture.actions).toEqual([{ teamId: 'team', action: 'resolve_message', messageId: 'legacy', outcome: label === 'Confirm received' ? 'accepted' : 'rejected' }]);
  expect(fixture.attached).toEqual([]);
});

it.each((['primary', 'dock', 'attached', 'float'] as const).flatMap(placement =>
  (['selected-another-view', 'rebound', 'closed', 'another-window'] as const).map(change => ({ placement, change }))))('keeps Team creation source in $placement fixed after $change', async ({ placement, change }) => {
  const binding = { ...team.source };
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'origin', revision: 0, title: 'Window', selectedPrimaryViewId: placement === 'primary' ? 'b' : 'a', selectedViewId: 'b',
    views: [createWindowView('a', binding, 'primary'), { ...createWindowView('b', binding, placement), ...(placement === 'attached' ? { attachedTo: 'a' } : {}) }] };
  let finish!: (value: Team) => void, refresh!: () => void;
  const requests: unknown[] = [], opened = vi.fn(async () => true), catalog = vi.fn();
  fixture.create = input => { requests.push(input); return new Promise(resolve => { finish = resolve; }); };
  function Harness() {
    const [, update] = useState(0); refresh = () => update(value => value + 1);
    const selected = window.views.find(view => view.id === window.selectedViewId)!;
    return <WindowLayoutContext.Provider value={{ window, operate() {} }}><TeamMenu baseUrl="https://team.test" enabled
      hosts={[{ id: 'mac', name: 'Mac', online: true, teamManagement: true }]} source={selected.binding}
      sourceViewId={`${window.id}/${selected.id}`} onOpen={opened} onOpenSession={async () => true} onTeamsChange={catalog} /></WindowLayoutContext.Provider>;
  }
  const view = await render(<Harness />);
  await act(async () => button(view, 'Teams').click());
  await act(async () => button(view, 'New team').click());
  await act(async () => {
    if (change === 'another-window') window = { ...window, id: 'destination' };
    if (change === 'selected-another-view' || change === 'closed') window = { ...window, selectedPrimaryViewId: 'a', selectedViewId: 'a',
      views: change === 'closed' ? window.views.filter(value => value.id !== 'b') : window.views };
    if (change === 'rebound') window = { ...window, views: window.views.map(value => value.id === 'b' ? { ...value, binding: { ...binding, nativeSessionId: 'replacement' } } : value) };
    refresh();
  });
  await act(async () => { finish(structuredClone(team)); });
  await vi.waitFor(() => expect(catalog).toHaveBeenLastCalledWith('https://team.test', [team]));
  expect(requests).toEqual([{ operationId: expect.any(String), source: team.source }]);
  if (change === 'selected-another-view') expect(opened).toHaveBeenCalledWith(team, 'origin/b');
  else expect(opened).not.toHaveBeenCalled();
});

it('retries an uncertain Team creation with its original source and operation identity after selection changes', async () => {
  let source = structuredClone(team.source), refresh!: () => void;
  const requests: unknown[] = [], opened = vi.fn(async () => true);
  fixture.create = async input => { requests.push(input); if (requests.length === 1) throw new Error('Receipt lost'); return structuredClone(team); };
  function Harness() {
    const [, update] = useState(0); refresh = () => update(value => value + 1);
    return <TeamMenu baseUrl="https://team.test" enabled hosts={[{ id: 'mac', name: 'Mac', online: true, teamManagement: true }]}
      source={source} sourceViewId="origin/b" onOpen={opened} onOpenSession={async () => true} />;
  }
  const view = await render(<Harness />);
  await act(async () => button(view, 'Teams').click());
  await act(async () => button(view, 'New team').click());
  expect(view.textContent).toContain('Receipt lost');
  await act(async () => { source = { ...source, nativeSessionId: 'replacement', title: 'Replacement primary' }; refresh(); });
  expect(view.querySelector('[data-creation-source]')?.textContent).toContain('Main project');
  await act(async () => button(view, 'Check previous creation').click());
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]).toEqual({ operationId: expect.any(String), source: team.source });
  expect(opened).toHaveBeenCalledWith(team, 'origin/b');
});
