import { useCallback, useEffect, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentSnapshot, ClientMessage, HistoryPage, Team } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport, RemoteTransportListener } from '@orchardworks/agent-remote-web';
import { TeamMenu } from '../../src/components/TeamMenu';
import { SessionTrackingMenu } from '../../src/components/SessionTrackingMenu';
import type { SessionTracking } from '../../src/hooks/useSessionTracking';
import { TeamGatherButton } from '../../src/components/TeamGatherButton';
import { SessionDockProvider, SessionDockRail } from '../../src/components/SessionDock';
import { SessionWindow } from '../../src/components/SessionWindow';
import { SessionFamily } from '../../src/components/SessionFamily';
import { useSessionWindows, type SessionWindowTarget } from '../../src/hooks/useSessionWindows';
import { createCompositionDocument, createCompositionSlot, compositionSelection, parseComposition } from '../../src/session-composition';
import { sessionKey } from '../../src/session-tree';
import { teamLayoutTargets } from '../../src/team-layout';
import { sessionViewNavigation } from '../../src/session-view-navigation';
import '../../src/ask.css';
import { DraftStore } from '../../src/draft-store';
import { replicaState } from '../../src/test/fixtures';
import '../../src/session-view-styles';
import '../../src/tpm.css';
const drafts = new DraftStore('team-fixture');
const settingsEnabled = new URLSearchParams(location.search).has('settings');
const permissions = new Map<string, string>();
const children: Record<string, string[]> = {
 source: ['source-child'], leader: ['leader-child', 'leader-other'], member: ['member-child'], 'leader-child': ['leader-grandchild'],
};
const snapshot = (id: string): AgentSnapshot => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
 ...replicaState.agent!, id, providerId: 'codex', capabilities: { ...replicaState.agent!.capabilities, sessionSettings: settingsEnabled }, runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: 'codex', sessionId: id,
 ...(settingsEnabled ? { settings: [{ id: 'approval', category: 'permissions' as const, label: 'Approval policy', value: permissions.get(id) ?? 'ask', mutable: true, scope: 'session' as const,
 options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }] }] } : {}),
 childSessions: new URLSearchParams(location.search).has('children') ? (children[id] ?? []).map(nativeSessionId => ({
 nativeSessionId, title: nativeSessionId, createdAt: '2026-10-13T00:00:00Z', status: 'idle', observation: 'live',
 })) : [], },
} });
const timeline = (id: string): HistoryPage => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
  agentId: id, requestId: 'history', direction: 'tail', epoch: 'epoch', reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: 20, nextSeq: 21 }, startCursor: { epoch: 'epoch', seq: 1 }, endCursor: { epoch: 'epoch', seq: 20 },
  entries: Array.from({ length: 20 }, (_, index) => ({ providerId: 'codex', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-10-12T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { ...(index < 4 ? { background: { id: 'fixture-review', kind: 'review' as const, status: 'silent' as const } } : {}), type: 'assistant_message' as const, text: `Review ${index + 1}: We can keep this session focused on one delivery while checking the main session for progress.\n\nThe acceptance criteria and next steps stay visible in this conversation.` } })),
  hasOlder: false, hasNewer: false, error: null } });
let connections = 0;
const pendingInputs = new Map<string, Extract<ClientMessage, { type: 'send_message' }>>();
const inputListeners = new Map<string, RemoteTransportListener>();
const nextSeq = new Map<string, number>();
function settleInput(id: string, outcome: 'ack' | 'echo' | 'reject') {
 const input = pendingInputs.get(id), listener = inputListeners.get(id);
 if (!input || !listener) throw new Error(`No pending input for ${id}.`);
 if (outcome === 'echo') {
  const seq = nextSeq.get(id) ?? 21; nextSeq.set(id, seq + 1);
  listener.onMessage({ protocolVersion: '1.8.0', type: 'agent_stream', payload: { agentId: id, epoch: 'epoch', seq, timestamp: new Date().toISOString(),
   event: { type: 'timeline', providerId: 'codex', item: { type: 'user_message', text: 'text' in input.payload ? input.payload.text : 'Image input' }, resources: [] } } });
 } else if (outcome === 'ack') {
  listener.onMessage({ protocolVersion: '1.8.0', type: 'command_acknowledged', payload: { agentId: id, requestId: input.payload.requestId, command: 'send_message' } });
 } else listener.onMessage({ protocolVersion: '1.8.0', type: 'protocol_error', payload: { requestId: input.payload.requestId, code: 'agent_busy', message: 'Fixture rejected input.', recoverable: true } });
}
window.addEventListener('fixture:settle-input', event => {
 const { id, outcome } = (event as CustomEvent<{ id: string; outcome: 'ack' | 'echo' | 'reject' }>).detail;
 settleInput(id, outcome);
});
const transport: RemoteAgentTransport = {
  fetchSnapshot: async id => snapshot(id), fetchTimeline: async id => timeline(id), onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect: (id, listener) => {
    inputListeners.set(id, listener);
    document.documentElement.dataset.fixtureConnections = String(++connections);
    queueMicrotask(() => { listener.onOpen(); listener.onMessage(snapshot(id)); });
    return { close: () => {}, send: message => {
      if (message.type === 'negotiate') {
        listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated', sessionControl: true });
        listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
      if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
      if (message.type === 'send_message') {
        pendingInputs.set(id, message); document.documentElement.dataset.fixtureInputTarget = id;
        if (new URLSearchParams(location.search).get('send') !== 'manual') { settleInput(id, 'ack'); settleInput(id, 'echo'); }
      }
      if (message.type === 'set_session_setting') {
        document.documentElement.dataset.fixtureSettingTarget = message.payload.agentId;
        permissions.set(id, message.payload.value);
        listener.onMessage({ protocolVersion: '1.8.0', type: 'command_acknowledged', payload: { agentId: id, requestId: message.payload.requestId, command: 'set_session_setting' } });
        listener.onMessage(snapshot(id));
      }
    } };
  },
};
function Fixture() {
 const [teams, setTeams] = useState<Team[]>([]);
 const receiveTeams = useCallback((_scope: string, teams: Team[]) => setTeams(teams), []);
 const tracked = teams.flatMap(team => [...team.members.filter(member => member.nativeSessionId).map(member => ({ ...member, nativeSessionId: member.nativeSessionId!, title: member.name, starredAt: 1 })), { ...team.source, starredAt: 1 }]);
 const tracking = { sessions: tracked, backgroundSessions: tracked, observations: {} } as unknown as SessionTracking;
 const [compact,setCompact]=useState(window.innerWidth<=1180);
 const [main,setMain]=useState<SessionWindowTarget | undefined>(()=>JSON.parse(sessionStorage.getItem('fixture:main')??'null')??undefined);
 const [document] = useState(() => {
   const saved = sessionStorage.getItem('fixture:composition');
   return saved ? parseComposition(JSON.parse(saved), location.origin) : createCompositionDocument(location.origin);
 });
 const [, render] = useReducer(n => n + 1, 0);
 const windows = useSessionWindows(location.origin, { document,
   save() { sessionStorage.setItem('fixture:composition', JSON.stringify(document)); render(); },
   ensureView(target) {
     let slot = document.slots.find(slot => sessionKey(compositionSelection(slot)) === sessionKey(target));
     if (!slot) { slot = createCompositionSlot(crypto.randomUUID(), target, location.origin); document.slots.push(slot); }
     return slot;
   },
 });
 const hosts=[{id:'mac',name:'Mac',online:true,teamManagement:true as const,providers:[{providerId:'codex',displayName:'Codex'}]},{id:'win',name:'Windows',online:true,teamManagement:true as const,providers:[{providerId:'codex',displayName:'Codex'}]}];
 const navigation: import('../../src/session-view-navigation').SessionViewNavigationFactory=(source,state,actions)=>sessionViewNavigation({source,state,entries:[],...actions});
 const open=async(target:SessionWindowTarget)=>{setMain(target);sessionStorage.setItem('fixture:main',JSON.stringify(target));return true;};
 useEffect(()=>{const resize=()=>setCompact(window.innerWidth<=1180);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 return <SessionDockProvider enabled={!compact} storageScope={location.origin}><main className="lab-shell" style={{display:'flex',flexDirection:'column',height:'100dvh'}}>
 {new URLSearchParams(location.search).has('tracking') ? <SessionTrackingMenu tracking={tracking} teams={teams} busy={false} inert={false} onOpen={target => void open(target)} /> : null}
 <TeamMenu baseUrl={window.location.origin} enabled hosts={hosts} compact={compact} currentSession={main} onTeamsChange={receiveTeams}
 source={{hostId:'mac',providerId:'codex',nativeSessionId:'source',title:'Project'}} onOpenSession={open}
 onOpen={async team=>{const layout=teamLayoutTargets(team,compact);await open(layout.main);windows.open(layout.dock, layout.groupRoot, team.id);return true;}} />
 <SessionDockRail>{main?<SessionFamily key={sessionKey(main)} storageScope={location.origin} baseUrl={location.origin} target={main} hostLabel="Mac" compact={compact} active offline={false} transport={transport} draftStore={drafts} navigation={navigation}/>:<p>Ordinary workspace</p>}</SessionDockRail>
 {windows.entries.map(entry=><SessionWindow key={entry.id} entry={entry} baseUrl={location.origin} visible={!compact} compact={compact} hostLabel={entry.target?.hostId ?? ''} offline={false} transport={transport} draftStore={drafts} navigation={navigation} closeWith={windows.entries.filter(child=>child.closeWith===entry.id).map(child=>child.id)} onFocus={()=>windows.focus(entry.id)} onClose={()=>windows.close(entry.id)} actions={entry.groupId?<TeamGatherButton baseUrl={location.origin} entry={entry} onGather={targets=>windows.gather(entry,targets)}/>:undefined}/>)}
 </main></SessionDockProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
