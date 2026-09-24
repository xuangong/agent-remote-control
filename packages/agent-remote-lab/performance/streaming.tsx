import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import { LabWorkbench } from '../src/components/LabWorkbench.js';
import { replicaState } from '../src/test/fixtures.js';
import '../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

const count = Number(new URLSearchParams(location.search).get('count') || 100);
const paragraph = 'The session keeps its workspace and native runtime. Review the implementation and preserve the current reading position. ';
const entries = Array.from({ length: count }, (_, i) => ({
  providerId: 'recorded', seqStart: i + 1, seqEnd: i + 1, timestamp: '2026-09-24T00:00:00Z',
  sourceSeqRanges: [{ startSeq: i + 1, endSeq: i + 1 }], collapsed: [], resources: [],
  item: i % 3 === 0 ? { type: 'user_message' as const, text: `Review step ${i}.`, messageId: `u${i}` }
    : { type: 'assistant_message' as const, text: `### Review ${i}\n\n${paragraph.repeat(5)}\n\n- Check the implementation.\n- Preserve reading position.`, messageId: `a${i}` },
}));
const replica = new AgentReplica();
const agent = replicaState.agent!;
replica.applySnapshot({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: agent });
replica.applyHistory({ protocolVersion: '1.5.0', type: 'timeline_page', payload: {
  requestId: 'benchmark', agentId: agent.id, direction: 'tail', epoch: 'stream-benchmark', entries,
  reset: false, staleCursor: false, gap: false, hasOlder: false, hasNewer: false, error: null,
  window: { minSeq: 1, maxSeq: count, nextSeq: count + 1 },
  startCursor: { epoch: 'stream-benchmark', seq: 1 }, endCursor: { epoch: 'stream-benchmark', seq: count },
} });
const subscribe = (listener: () => void) => replica.subscribe(listener);
const snapshot = () => replica.getState();
const actions = { sendMessage: async () => {} };
let running = false;
Object.assign(window, { startStream: async () => {
  if (running) throw new Error('Stream already started');
  running = true;
  for (let i = 0; i < 40; i++) {
    replica.applyStream({ protocolVersion: '1.5.0', type: 'agent_stream', payload: {
      agentId: agent.id, epoch: 'stream-benchmark', seq: count + i + 1, timestamp: '2026-09-24T00:00:01Z',
      event: { type: 'timeline', providerId: 'recorded', resources: [],
        item: { type: 'assistant_message', messageId: `a${count - 1}`, text: ` Update ${i}.` } },
    } });
    await new Promise(resolve => setTimeout(resolve, 75));
  }
} });
function Fixture() {
  const state = useSyncExternalStore(subscribe, snapshot);
  return <div style={{ height: '100dvh' }} data-next-seq={state.timeline.nextSeq}>
    <LabWorkbench state={state} sessionStatus="ready" actions={actions} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
