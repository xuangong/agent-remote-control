// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HistoryPage, type TimelineCursor } from '@orchardworks/agent-remote-protocol';

import { AgentReplica } from '../replica/store.js';
import { buildEntry, buildSnapshot } from '../testing/builders.js';
import { buildTailPage } from '../testing/replica.js';
import { watchMessageEchoes } from './message-echo-sync.js';
import type { RemoteAgentTransport } from './transport.js';

/** The history port of a session: it records each read and answers it when the test says so. */
function stubHistory() {
  const reads: Array<{ direction: string; cursor: TimelineCursor | undefined; limit: number | undefined; signal: AbortSignal | undefined;
    answer(page: HistoryPage): void; fail(): void }> = [];
  const transport = { fetchTimeline: (_agentId: string, direction: string, cursor?: TimelineCursor, limit?: number, options?: { signal?: AbortSignal }) => new Promise<HistoryPage>((resolve, reject) => {
    reads.push({ direction, cursor, limit, signal: options?.signal, answer: resolve, fail: () => reject(new Error('history unavailable')) });
    options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) } as unknown as RemoteAgentTransport;
  return { transport, reads };
}

/** The page of rows after `afterSeq`: one row, which is not the echo, and more beyond it. */
function olderThanEchoPage(afterSeq: number, hasNewer = true): HistoryPage {
  const seq = afterSeq + 1;
  return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: { requestId: 'scan', agentId: 'agent-1', direction: 'after', error: null,
    hasNewer, hasOlder: false, epoch: 'e1', reset: false, staleCursor: false, gap: false, window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 },
    startCursor: { epoch: 'e1', seq }, endCursor: { epoch: 'e1', seq }, entries: [buildEntry(seq)] } };
}

/** A replica holding one accepted message that waits for its echo after row 1. */
function waitingReplica() {
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: buildSnapshot() });
  replica.applyHistory(buildTailPage([buildEntry(1)]));
  replica.acknowledgeMessage(replica.beginMessage('agent-1', 'Ship it', undefined, 'operation'));
  return replica;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('looking for the echo of an accepted message in history', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads nothing before 10 s, then reads forward from the row the message followed, a page at a time', async () => {
    const replica = waitingReplica();
    const history = stubHistory();
    const stop = watchMessageEchoes('agent-1', history.transport, replica, 50);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(history.reads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(history.reads).toMatchObject([{ direction: 'after', cursor: { epoch: 'e1', seq: 1 }, limit: 50 }]);
    stop();
  });

  it('reads at most 8 pages in one scan, and goes on from the last page it read at the next check', async () => {
    const replica = waitingReplica();
    const history = stubHistory();
    const stop = watchMessageEchoes('agent-1', history.transport, replica, 50);
    await vi.advanceTimersByTimeAsync(10_000);
    for (let page = 1; page <= 8; page++) {
      expect(history.reads).toHaveLength(page);
      history.reads[page - 1]!.answer(olderThanEchoPage(page));
      await flush();
    }
    expect(history.reads).toHaveLength(8);
    expect(history.reads.map(read => read.cursor?.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(history.reads).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(history.reads).toHaveLength(9);
    expect(history.reads[8]).toMatchObject({ direction: 'after', cursor: { epoch: 'e1', seq: 9 } });
    expect(replica.getState().outgoingMessages).toMatchObject([{ status: 'awaiting_echo' }]);
    stop();
  });

  it('gives up on a scan whose read has not answered after 15 s, and backs off', async () => {
    const replica = waitingReplica();
    const history = stubHistory();
    const stop = watchMessageEchoes('agent-1', history.transport, replica, 50);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(history.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(history.reads[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(history.reads[0]!.signal?.aborted).toBe(true);
    // The next check is 30 s after the end of the scan, not at once.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(history.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(history.reads).toHaveLength(2);
    expect(replica.getState().outgoingMessages).toMatchObject([{ status: 'awaiting_echo', error: undefined }]);
    stop();
  });

  it('only backs off after a failed read: the message keeps waiting, and the checks go on at 30 s, 60 s and every 60 s', async () => {
    const replica = waitingReplica();
    const history = stubHistory();
    const stop = watchMessageEchoes('agent-1', history.transport, replica, 50);
    await vi.advanceTimersByTimeAsync(10_000);
    let reads = 1;
    for (const delay of [30_000, 60_000, 60_000]) {
      expect(history.reads).toHaveLength(reads);
      history.reads[reads - 1]!.fail();
      await flush();
      expect(replica.getState().outgoingMessages).toMatchObject([{ status: 'awaiting_echo', error: undefined }]);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(history.reads).toHaveLength(reads);
      await vi.advanceTimersByTimeAsync(1);
      expect(history.reads).toHaveLength(++reads);
    }
    expect(history.reads.every(read => read.direction === 'after')).toBe(true);
    stop();
  });
});
