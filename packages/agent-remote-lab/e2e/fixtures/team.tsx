import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentSnapshot, HistoryPage } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { TeamWorkspace } from '../../src/components/TeamWorkspace';
import { DraftStore } from '../../src/draft-store';
import { replicaState } from '../../src/test/fixtures';
import '../../src/session-view-styles';
import '../../src/tpm.css';
const drafts = new DraftStore('team-fixture');
const children: Record<string, string[]> = {
 source: ['source-child'], leader: ['leader-child', 'leader-other'], member: ['member-child'], 'leader-child': ['leader-grandchild'],
};
const snapshot = (id: string): AgentSnapshot => ({ protocolVersion: '1.7.0', type: 'agent_snapshot', payload: {
 ...replicaState.agent!, id, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: id,
 childSessions: new URLSearchParams(location.search).has('children') ? (children[id] ?? []).map(nativeSessionId => ({
 nativeSessionId, title: nativeSessionId, createdAt: '2026-10-13T00:00:00Z', status: 'idle', observation: 'live',
 })) : [], },
} });
const timeline = (id: string): HistoryPage => ({ protocolVersion: '1.7.0', type: 'timeline_page', payload: {
  agentId: id, requestId: 'history', direction: 'tail', epoch: 'epoch', reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: 20, nextSeq: 21 }, startCursor: { epoch: 'epoch', seq: 1 }, endCursor: { epoch: 'epoch', seq: 20 },
  entries: Array.from({ length: 20 }, (_, index) => ({ providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-10-12T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { ...(index < 4 ? { background: { id: 'fixture-review', kind: 'review' as const, status: 'silent' as const } } : {}), type: 'assistant_message' as const, text: `Review ${index + 1}: We can keep this session focused on one delivery while checking the main session for progress.\n\nThe acceptance criteria and next steps stay visible in this conversation.` } })),
  hasOlder: false, hasNewer: false, error: null } });
let connections = 0;
const transport: RemoteAgentTransport = {
  fetchSnapshot: async id => snapshot(id), fetchTimeline: async id => timeline(id), onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect: (id, listener) => {
    document.documentElement.dataset.fixtureConnections = String(++connections);
    queueMicrotask(() => { listener.onOpen(); listener.onMessage(snapshot(id)); });
    return { close: () => {}, send: message => {
      if (message.type === 'negotiate') {
        listener.onMessage({ protocolVersion: '1.7.0', type: 'negotiated', sessionControl: true });
        listener.onMessage({ protocolVersion: '1.7.0', type: 'session_control', payload: { agentId: id, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: '1.7.0', type: 'session_control', payload: { agentId: id, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
      if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.7.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
    } };
  },
};
function Fixture() {
 const [compact,setCompact]=useState(window.innerWidth<=1180),[mount,setMount]=useState<HTMLDivElement|null>(null),[active,setActive]=useState(false);
 useEffect(()=>{const resize=()=>setCompact(window.innerWidth<=1180);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 return <main className="lab-shell" style={{display:'flex',flexDirection:'column',height:'100dvh'}}>
 <TeamWorkspace baseUrl={window.location.origin} enabled compact={compact} hosts={[{id:'mac',name:'Mac',online:true,teamManagement:true,providers:[{providerId:'codex',displayName:'Codex'}]},{id:'win',name:'Windows',online:true,teamManagement:true,providers:[{providerId:'codex',displayName:'Codex'}]}]}
 source={{hostId:'mac',providerId:'codex',nativeSessionId:'source',title:'Project'}} transport={transport} draftStore={drafts} mount={mount} onModeChange={setActive}/>
 {!active?<p>Ordinary workspace</p>:null}<div ref={setMount} style={{display:'contents'}}/>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
