import { createRoot } from 'react-dom/client';
import { AgentReplica, RemoteSessionClient, type RemoteAgentTransport, type RemoteTransportListener } from '@agent-remote-controller/agent-remote-web/headless';
import { useAgentReplica } from '@agent-remote-controller/agent-remote-web/react';
import type { ClientMessage, HistoryPage } from '@agent-remote-controller/agent-remote-protocol';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@agent-remote-controller/agent-remote-web/styles.css';

const replica = new AgentReplica();
const snapshot = { protocolVersion: '1.4.0', type: 'agent_snapshot', payload: replicaState.agent! } as const;
const history: HistoryPage = { protocolVersion: '1.4.0', type: 'timeline_page', payload: {
  requestId: 'history', agentId: snapshot.payload.id, epoch: 'delivery', direction: 'tail', reset: false, staleCursor: false, gap: false,
  window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [], error: null,
} };
replica.applySnapshot(snapshot); replica.applyHistory(history);
let listener: RemoteTransportListener;
let submitted: Extract<ClientMessage, { type: 'send_message' }> | undefined;
const transport: RemoteAgentTransport = {
  connect: (_agent, callbacks) => { listener = callbacks; return { send: message => { if (message.type === 'send_message') submitted = message; }, close: () => {} }; },
  fetchSnapshot: async () => snapshot, fetchTimeline: async () => history,
  onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
};
const client = new RemoteSessionClient(snapshot.payload.id, transport, replica, { operationTimeoutMs: 60_000 });
client.start();
function acknowledge() {
  if (submitted) listener.onMessage({ protocolVersion: '1.4.0', type: 'command_acknowledged', payload: {
    requestId: submitted.payload.requestId, agentId: snapshot.payload.id, command: 'send_message',
  } });
}
function echo() {
  if (submitted) listener.onMessage({ protocolVersion: '1.4.0', type: 'agent_stream', payload: {
    agentId: snapshot.payload.id, epoch: 'delivery', seq: replica.getState().timeline.nextSeq, timestamp: new Date().toISOString(),
    event: { type: 'timeline', providerId: snapshot.payload.providerId, item: { type: 'user_message', text: submitted.payload.text }, resources: [] },
  } });
}
function View() {
  const state = useAgentReplica(replica);
  return <div style={{ height: '100dvh', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
    <nav aria-label="Delivery controls"><button onClick={acknowledge}>Acknowledge send</button><button onClick={echo}>Deliver message</button></nav>
    <LabWorkbench state={state} sessionStatus="ready" actions={{ sendMessage: async (text, options) => { await client.sendMessage(text, options); } }} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<View />);
