import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { replicaState } from '../test/fixtures.js';
import { RemoteSessionClient, type RemoteAgentTransport, type RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import type { HistoryPage, AgentStreamMessage } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { useSessionCatchUp } from './useSessionCatchUp.js';

function page(seq: number, epoch = 'epoch'): HistoryPage {
  return { protocolVersion: '1.5.0', type: 'timeline_page', payload: {
    requestId: 'history', agentId: 'agent', direction: 'tail', epoch, reset: false, staleCursor: false, gap: false, error: null,
    window: { minSeq: seq ? 1 : 0, maxSeq: seq, nextSeq: seq + 1 },
    startCursor: seq ? { epoch, seq: 1 } : null, endCursor: seq ? { epoch, seq } : null,
    hasOlder: false, hasNewer: false,
    entries: seq ? [{ providerId: 'recorded', seqStart: 1, seqEnd: seq, sourceSeqRanges: [{ startSeq: 1, endSeq: seq }], collapsed: [], resources: [],
      timestamp: '2026-09-20T00:00:00Z', item: { type: 'assistant_message', text: 'Cached content' } }] : [],
  } };
}
function live(seq: number, epoch = 'epoch'): AgentStreamMessage {
  return { protocolVersion: '1.5.0', type: 'agent_stream', payload: {
    agentId: 'agent', epoch, seq, timestamp: '2026-09-20T00:00:00Z',
    event: { type: 'timeline', providerId: 'recorded', resources: [], item: { type: 'assistant_message', text: 'More' } },
  } };
}
async function fixture() {
  let hook!: ReturnType<typeof useSessionCatchUp>;
  function Fixture() { hook = useSessionCatchUp(); return null; }
  await render(<Fixture />);
  return { get hook() { return hook; } };
}
it('does not close for buffered messages or elapsed time, and closes synchronously once the gap is filled', async () => {
  const f = await fixture(), replica = new AgentReplica();
  replica.applyHistory(page(1));
  await act(async () => f.hook.begin(replica, { epoch: 'epoch', seq: 3 }));
  await act(async () => { replica.applyStream(live(3)); });
  expect(f.hook.value).toMatchObject({ state: 'catching_up', progress: 0 });
  vi.useFakeTimers();
  try {
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(f.hook.value?.state).toBe('catching_up');
    await act(async () => { replica.applyHistory(page(2)); });
    expect(f.hook.value).toMatchObject({ state: 'complete', progress: 1 });
    await act(async () => replica.replaceTimeline('new-epoch'));
    expect(f.hook.value?.state).toBe('complete');
  } finally { vi.useRealTimers(); }
});
it('waits for the target epoch when cached history belongs to an older incarnation', async () => {
  const f = await fixture(), replica = new AgentReplica();
  replica.applyHistory(page(20, 'old'));
  await act(async () => f.hook.begin(replica, { epoch: 'epoch', seq: 3 }));
  expect(f.hook.value?.state).toBe('catching_up');
  await act(async () => { replica.applyHistory(page(2)); });
  expect(f.hook.value?.progress).toBeCloseTo(2 / 3);
  await act(async () => { replica.applyStream(live(3)); });
  expect(f.hook.value?.state).toBe('complete');
});
it('completes immediately from caught-up cache, but requires an initialized empty timeline for a zero cursor', async () => {
  const f = await fixture(), replica = new AgentReplica();
  await act(async () => f.hook.begin(replica, { epoch: 'epoch', seq: 0 }));
  expect(f.hook.value?.state).toBe('catching_up');
  await act(async () => { replica.applyHistory(page(0)); });
  expect(f.hook.value?.state).toBe('complete');
  replica.applyHistory(page(7));
  await act(async () => f.hook.begin(replica, { epoch: 'epoch', seq: 3 }));
  expect(f.hook.value).toMatchObject({ state: 'complete', progress: 1 });
});
it('ignores previous windows after switching and never claims completion for a replaced target', async () => {
  const f = await fixture(), first = new AgentReplica(), second = new AgentReplica();
  first.applyHistory(page(1)); second.applyHistory(page(1));
  await act(async () => f.hook.begin(first, { epoch: 'epoch', seq: 2 }));
  await act(async () => f.hook.begin(second, { epoch: 'epoch', seq: 3 }));
  await act(async () => { first.applyStream(live(2)); });
  expect(f.hook.value?.state).toBe('catching_up');
  await act(async () => second.replaceTimeline('replacement'));
  expect(f.hook.value?.state).toBe('unavailable');
  await act(async () => f.hook.begin(second));
  expect(f.hook.value).toBeUndefined();
});


it('closes at the frozen boundary while the full session continues fetching newer history before Ready', async () => {
  const f = await fixture(), replica = new AgentReplica(); replica.applyHistory(page(1));
  let release!: (page: HistoryPage) => void;
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('Unexpected snapshot fetch'); },
    fetchTimeline: () => new Promise(resolve => { release = resolve; }),
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect: (_agentId, listener) => {
      queueMicrotask(() => listener.onOpen());
      return { close: () => {}, send: message => {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
          listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: 'agent' } });
        } else if (message.type === 'timeline_subscription') {
          listener.onMessage({ protocolVersion: '1.5.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: ['agent'] } });
        }
      } };
    },
  };
  const client = new RemoteSessionClient('agent', transport, replica);
  let status: RemoteSessionStatus = 'idle'; client.subscribeStatus(value => { status = value; });
  try {
    await act(async () => { f.hook.begin(replica, { epoch: 'epoch', seq: 3 }); client.start(); });
    const first = page(3);
    await act(async () => release({ ...first, payload: { ...first.payload, direction: 'after', hasNewer: true, window: { minSeq: 1, maxSeq: 5, nextSeq: 6 } } }));
    expect(f.hook.value).toMatchObject({ state: 'complete', progress: 1 });
    expect(status).toBe('catching_up');
    const last = page(5);
    await act(async () => release({ ...last, payload: { ...last.payload, direction: 'after' } }));
    expect(status).toBe('ready');
  } finally { await act(async () => client.stop()); }
});

it.each([false, true])('cancels an unreachable activity epoch when the first fresh history has another epoch (cached: %s)', async cached => {
  const f = await fixture(), replica = new AgentReplica();
  if (cached) replica.applyHistory(page(20, 'cached'));
  await act(async () => f.hook.begin(replica, { epoch: 'replaced-before-entry', seq: 3 }));
  expect(f.hook.value?.state).toBe('catching_up');
  await act(async () => { replica.applyHistory(page(4, cached ? 'cached' : 'replacement')); });
  expect(f.hook.value?.state).toBe('unavailable');
});

it('clears the old target when focus moves to another already-open window without changing its subscription', async () => {
  const f = await fixture(), first = new AgentReplica(), second = new AgentReplica();
  first.applyHistory(page(1));
  await act(async () => f.hook.begin(first, { epoch: 'epoch', seq: 2 }));
  await act(async () => f.hook.focus(second));
  await act(async () => { first.applyStream(live(2)); });
  expect(f.hook.value).toBeUndefined();
});

it('keeps waiting through old-epoch buffered traffic instead of treating it as fresh authoritative history', async () => {
  const f = await fixture(), replica = new AgentReplica(); replica.applyHistory(page(20, 'old'));
  await act(async () => f.hook.begin(replica, { epoch: 'epoch', seq: 3 }));
  await act(async () => { replica.applyStream(live(22, 'old')); });
  expect(f.hook.value?.state).toBe('catching_up');
  await act(async () => { replica.applyHistory(page(3)); });
  expect(f.hook.value?.state).toBe('complete');
});

it('recovers the fixed target when an older in-flight history response arrives before the target epoch', async () => {
  const f = await fixture(), replica = new AgentReplica(); replica.applyHistory(page(20, 'old'));
  await act(async () => f.hook.begin(replica, { epoch: 'epoch', seq: 3 }));
  await act(async () => { replica.applyHistory(page(21, 'old')); });
  expect(f.hook.value?.state).not.toBe('complete');
  await act(async () => { replica.applyHistory(page(2)); });
  expect(f.hook.value).toMatchObject({ state: 'catching_up', progress: 2 / 3 });
  await act(async () => { replica.applyStream(live(3)); });
  expect(f.hook.value).toMatchObject({ state: 'complete', progress: 1 });
});

it('does not hide progress for an older-page response from the cached epoch', async () => {
  const f = await fixture(), replica = new AgentReplica(); replica.applyHistory(page(20, 'old'));
  await act(async () => f.hook.begin(replica, { epoch: 'epoch', seq: 3 }));
  const older = page(20, 'old');
  await act(async () => { replica.applyHistory({ ...older, payload: { ...older.payload, direction: 'before' } }); });
  expect(f.hook.value?.state).toBe('catching_up');
});
