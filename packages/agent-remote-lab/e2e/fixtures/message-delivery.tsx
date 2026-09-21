import { createRoot } from 'react-dom/client';
import { AgentReplica, RemoteSessionClient, type RemoteAgentTransport, type RemoteTransportListener } from '@orchardworks/agent-remote-web/headless';
import { useAgentReplica } from '@orchardworks/agent-remote-web/react';
import type { ClientMessage, HistoryPage } from '@orchardworks/agent-remote-protocol';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

const replica = new AgentReplica();
const snapshot = { protocolVersion: '1.5.0', type: 'agent_snapshot', payload: replicaState.agent! } as const;
const history: HistoryPage = { protocolVersion: '1.5.0', type: 'timeline_page', payload: {
  requestId: 'history', agentId: snapshot.payload.id, epoch: 'delivery', direction: 'tail', reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: 'delivery', seq: 1 }, endCursor: { epoch: 'delivery', seq: 1 },
  hasOlder: false, hasNewer: false, error: null, entries: [{ providerId: snapshot.payload.providerId,
    seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
    timestamp: '2026-09-20T00:00:00Z', item: { type: 'compaction', status: 'completed' } }],
} };
replica.applySnapshot(snapshot); replica.applyHistory(history);
let listener: RemoteTransportListener;
let submitted: Extract<ClientMessage, { type: 'send_message' }> | undefined;
const transport: RemoteAgentTransport = {
  connect: (_agent, callbacks) => {
    listener = callbacks;
    queueMicrotask(() => callbacks.onOpen());
    return { send: message => {
      if (message.type === 'negotiate') {
        callbacks.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
        callbacks.onMessage(snapshot);
      } else if (message.type === 'timeline_subscription') {
        callbacks.onMessage({ protocolVersion: '1.5.0', type: 'timeline_subscribed', payload: {
          requestId: message.payload.requestId, agentIds: [snapshot.payload.id],
        } });
      } else if (message.type === 'send_message') submitted = message;
    }, close: () => {} };
  },
  fetchSnapshot: async () => snapshot, fetchTimeline: async () => history,
  onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
};
const client = new RemoteSessionClient(snapshot.payload.id, transport, replica, { scheduleReconnect: () => () => {} });
client.start();
function acknowledge() {
  if (submitted) listener.onMessage({ protocolVersion: '1.5.0', type: 'command_acknowledged', payload: {
    requestId: submitted.payload.requestId, agentId: snapshot.payload.id, command: 'send_message',
  } });
}
function disconnect() {
  listener.onDisconnect();
}
function echo() {
  if (submitted) listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_stream', payload: {
    agentId: snapshot.payload.id, epoch: 'delivery', seq: replica.getState().timeline.nextSeq, timestamp: new Date().toISOString(),
    event: { type: 'timeline', providerId: snapshot.payload.providerId, item: { type: 'user_message', text: 'text' in submitted.payload ? submitted.payload.text : '' }, resources: [] },
  } });
}
function View() {
  const state = useAgentReplica(replica);
  return <div style={{ height: '100dvh', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
    <nav aria-label="Delivery controls"><button onClick={acknowledge}>Acknowledge send</button><button onClick={disconnect}>Disconnect before acknowledgement</button><button onClick={echo}>Deliver message</button></nav>
    <LabWorkbench state={state} sessionStatus="ready" actions={{ sendMessage: async (text, options) => { await client.sendMessage(text, options); } }} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<View />);
