import { createRoot } from 'react-dom/client';
import type { AgentReplicaState, RemoteTransportListener } from '@orchardworks/agent-remote-web';
import { PROTOCOL_VERSION, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { App, type LabTransport } from '../../src/App.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

function entry(seq: number): ProjectedTimelineEntry {
  return { providerId: 'recorded', turnId: 'turn-inspect', seqStart: seq, seqEnd: seq, timestamp: '2026-09-17T07:00:00Z',
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
    item: { type: 'assistant_message', messageId: `message-${seq}`, text: `Message ${seq}. ${'Readable task context. '.repeat(22)}` },
  };
}
const command: ProjectedTimelineEntry = { ...entry(12), collapsed: ['tool_lifecycle'], item: {
  type: 'tool_call', callId: 'test-call', name: 'run_tests', status: 'running', error: null,
  detail: { type: 'shell', command: 'pnpm test --testTimeout=10000', cwd: '/workspace/example' },
} };
const initial: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false, nextSeq: 31,
  entries: [...Array.from({ length: 11 }, (_, index) => entry(index + 1)), command, ...Array.from({ length: 18 }, (_, index) => entry(index + 13))],
} };

let timeline = initial.timeline;
const timelineListeners = new Set<RemoteTransportListener>();
const transport: LabTransport = {
  listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded Provider' }],
  createAgent: async () => { throw new Error('Not used by this fixture'); },
  resumeAgent: async () => { throw new Error('Not used by this fixture'); },
  fetchSnapshot: async () => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: initial.agent! }),
  fetchTimeline: async (_agentId, direction) => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'fixture-history', agentId: 'agent-1', epoch: timeline.epoch!, direction,
    reset: false, staleCursor: false, gap: false, hasOlder: false, hasNewer: false, error: null,
    window: { minSeq: 1, maxSeq: timeline.nextSeq - 1, nextSeq: timeline.nextSeq },
    startCursor: { epoch: timeline.epoch!, seq: 1 }, endCursor: { epoch: timeline.epoch!, seq: timeline.nextSeq - 1 }, entries: [...timeline.entries],
  } }),
  onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect: (_agentId, target) => {
    let activityOnly = false;
    queueMicrotask(() => {
      target.onOpen();
      if (!activityOnly) target.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: initial.agent! });
    });
    return { close: () => { timelineListeners.delete(target); }, send: message => {
      if (message.type === 'negotiate' && message.observation === 'activity') {
        activityOnly = true;
        queueMicrotask(() => target.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity',
          payload: { agentId: 'agent-1', status: 'idle' },
        }));
      }
      if (message.type === 'timeline_subscription') {
        timelineListeners.add(target);
        queueMicrotask(() => target.onMessage({
          protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: ['agent-1'] },
        }));
      }
    } };
  },
};

function emit(item: ProjectedTimelineEntry['item']) {
  const seq = timeline.nextSeq;
  timeline = { ...timeline, nextSeq: seq + 1 };
  for (const listener of timelineListeners) listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: {
    agentId: 'agent-1', epoch: timeline.epoch!, seq, timestamp: '2026-09-17T07:01:00Z',
    event: { type: 'timeline', providerId: 'recorded', turnId: 'turn-inspect', item, resources: [] },
  } });
}

function Fixture() {
  return <>
    <nav aria-label="Fixture controls" style={{ position: 'fixed', right: 4, bottom: 2, zIndex: 200, display: 'flex', gap: 4 }}>
      <button onClick={() => emit(entry(timeline.nextSeq).item)}>Append event</button>
      <button onClick={() => emit({ ...command.item as Extract<typeof command.item, { type: 'tool_call' }>, status: 'completed', error: null,
        result: { durationMs: 1200, exitCode: 0, content: [{ type: 'text', text: 'All tests passed.\n' + 'Detailed test output. '.repeat(400) }] },
      })}>Complete tool</button>
      <button onClick={() => {
        timeline = { ...initial.timeline, epoch: 'epoch-two' };
        for (const listener of timelineListeners) listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: 'agent-1', epoch: 'epoch-two' } });
      }}>Replace timeline</button>
    </nav>
    <App transport={transport} />
  </>;
}

window.history.replaceState(null, '', `${window.location.pathname}?agent=agent-1`);
createRoot(document.getElementById('root')!).render(<Fixture />);
