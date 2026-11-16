import { describe, expect, it } from 'vitest';

import { decodeServerMessage } from '@orchardworks/agent-remote-protocol';

import { indexOf, openJournal, text } from './journal.test-fixture.js';
import type { JournalRowInput } from './types.js';
import { SessionJournal } from './session-journal.js';

const toolCall = (itemKey: string, sourceKey: string): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey, occurredAt: 0,
  item: { type: 'tool_call', callId: itemKey, name: 'shell', status: 'running', error: null, detail: { type: 'shell', command: 'ls' } },
});

function pagesAfter(journal: SessionJournal, limit: number): string[][] {
  const pages: string[][] = [];
  let cursor = { epoch: journal.epoch, seq: 0 };
  for (let guard = 0; guard < 1000; guard += 1) {
    const result = journal.page({ requestId: 'r', agentId: 'a', direction: 'after', cursor, limit }, { olderBeyondJournal: false });
    if (result.kind !== 'page') throw new Error('expected a page');
    pages.push(result.page.payload.entries.map(({ item }) => (item.type === 'assistant_message' ? item.messageId ?? '' : (item as { callId: string }).callId)));
    if (!result.page.payload.hasNewer) return pages;
    cursor = result.page.payload.endCursor as typeof cursor;
  }
  throw new Error('paging did not end');
}

function decodes(result: ReturnType<SessionJournal['page']>): void {
  if (result.kind !== 'page') throw new Error('expected a page');
  expect(decodeServerMessage(JSON.stringify(result.page)).status).toBe('ok');
}


function fiveItems() {
  const { journal, publish } = openJournal();
  for (const key of ['m1', 'm2', 'm3', 'm4', 'm5']) journal.append(publish(), text(key, `d-${key}`, key));
  return journal;
}
const request = { requestId: 'request-1', agentId: 'agent-1', limit: 2 };
const keys = (result: ReturnType<ReturnType<typeof fiveItems>['page']>) =>
  result.kind === 'page' ? result.page.payload.entries.map(({ item }) => (item.type === 'assistant_message' ? item.messageId : item.type)) : result.itemKeys;

describe('journal pages', () => {
  it('serves the tail with its cursors, window and neighbours', () => {
    const result = fiveItems().page({ ...request, direction: 'tail' }, { olderBeyondJournal: false });
    expect(keys(result)).toEqual(['m4', 'm5']);
    if (result.kind !== 'page') throw new Error('expected a page');
    expect(result.page.payload).toMatchObject({
      epoch: 'epoch-1', reset: false, gap: false, hasOlder: true, hasNewer: false,
      startCursor: { epoch: 'epoch-1', seq: 4 }, endCursor: { epoch: 'epoch-1', seq: 5 },
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
    });
  });

  it('serves pages before and after a cursor', () => {
    const journal = fiveItems();
    expect(keys(journal.page({ ...request, direction: 'before', cursor: { epoch: 'epoch-1', seq: 4 } }, { olderBeyondJournal: false }))).toEqual(['m2', 'm3']);
    expect(keys(journal.page({ ...request, limit: 10, direction: 'after', cursor: { epoch: 'epoch-1', seq: 3 } }, { olderBeyondJournal: false }))).toEqual(['m4', 'm5']);
  });

  it('resets a cursor of a retired epoch and reports a cursor ahead of history as a gap', () => {
    const journal = fiveItems();
    const stale = journal.page({ ...request, direction: 'after', cursor: { epoch: 'retired', seq: 2 } }, { olderBeyondJournal: false });
    expect(stale.kind === 'page' && stale.page.payload).toMatchObject({ reset: true, staleCursor: true, entries: [] });
    const ahead = journal.page({ ...request, direction: 'after', cursor: { epoch: 'epoch-1', seq: 9 } }, { olderBeyondJournal: false });
    expect(ahead.kind === 'page' && ahead.page.payload).toMatchObject({ gap: true, entries: [] });
  });

  it('reports older history the Host still has beyond the journal', () => {
    const result = fiveItems().page({ ...request, limit: 10, direction: 'tail' }, { olderBeyondJournal: true });
    expect(result.kind === 'page' && result.page.payload.hasOlder).toBe(true);
    const complete = fiveItems().page({ ...request, limit: 10, direction: 'tail' }, { olderBeyondJournal: false });
    expect(complete.kind === 'page' && complete.page.payload.hasOlder).toBe(false);
  });

  it('pages after a cursor by sequence end when item ranges overlap', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), toolCall('A', 'a1'));
    for (const key of ['B', 'C', 'D']) journal.append(publish(), text(key, key, key));
    journal.append(publish(), toolCall('A', 'a2'));
    journal.append(publish(), text('E', 'E', 'E'));
    expect(indexOf(journal)[0]).toMatchObject({ itemKey: 'A', seqStart: 1, seqEnd: 5 });
    const delivered = pagesAfter(journal, 1).flat();
    expect([...delivered].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('delivers every item when a tool call stays open across a hundred sequences', () => {
    const { journal, publish } = openJournal();
    for (let n = 1; n <= 99; n += 1) journal.append(publish(), text(`m${n}`, `m${n}`, 'x'));
    journal.append(publish(), toolCall('X', 'x1'));
    for (let n = 1; n <= 5; n += 1) journal.append(publish(), text(`y${n}`, `y${n}`, 'y'));
    journal.append(publish(), toolCall('X', 'x2'));
    const delivered = pagesAfter(journal, 100).flat();
    expect(delivered).toHaveLength(105);
    expect(new Set(delivered).size).toBe(105);
  });

  it('reports the missing bodies of before and after pages', () => {
    const { journal, publish } = openJournal();
    for (const key of ['m1', 'm2', 'm3']) {
      journal.append(publish(), text(key, key, key, `turn-${key}`));
      journal.complete(publish(), key, `digest-${key}`);
    }
    journal.evict(1);
    const base = { requestId: 'r', agentId: 'a', limit: 10 };
    expect(journal.page({ ...base, direction: 'before', cursor: { epoch: 'epoch-1', seq: 3 } }, { olderBeyondJournal: false }))
      .toEqual({ kind: 'missing', itemKeys: ['m1', 'm2'] });
    expect(journal.page({ ...base, direction: 'after', cursor: { epoch: 'epoch-1', seq: 0 } }, { olderBeyondJournal: false }))
      .toEqual({ kind: 'missing', itemKeys: ['m1', 'm2'] });
  });

  it('produces pages the protocol schema accepts', () => {
    const journal = fiveItems();
    const options = { olderBeyondJournal: true };
    for (const direction of ['tail', 'before', 'after'] as const) {
      decodes(journal.page({ ...request, direction, cursor: { epoch: 'epoch-1', seq: 3 } }, options));
    }
    decodes(journal.page({ ...request, direction: 'after', cursor: { epoch: 'retired', seq: 2 } }, options));
    decodes(journal.page({ ...request, direction: 'after', cursor: { epoch: 'epoch-1', seq: 9 } }, options));
    const { journal: older, publish } = openJournal();
    older.append(publish(), text('m3', 'd3', 'now'));
    older.prepend(publish(), [{ row: text('m1', 'h1', 'a'), digest: 'd1' }, { row: text('m2', 'h2', 'b'), digest: 'd2' }]);
    for (const direction of ['tail', 'before'] as const) {
      decodes(older.page({ ...request, limit: 10, direction, cursor: { epoch: 'epoch-1', seq: 1 } }, options));
    }
  });
  it('pages over a very large selection', () => {
    const count = 200_000;
    const source = openJournal().journal.state();
    const items = Array.from({ length: count }, (_, offset) => {
      const seq = offset + 1;
      return {
        itemKey: `k${seq}`, providerId: 'codex', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        state: 'complete' as const, liveOnly: false, digest: `d${seq}`,
        body: { item: { type: 'assistant_message' as const, text: 'x', messageId: `k${seq}` }, timestamp: '2025-01-01T00:00:00.000Z', collapsed: [], resources: [] },
      };
    });
    const journal = new SessionJournal({ meta: { ...source.meta, nextSeq: count + 1 }, items });
    const result = journal.page({ requestId: 'r', agentId: 'a', direction: 'tail', limit: count }, { olderBeyondJournal: false });
    expect(result.kind === 'page' && result.page.payload.endCursor).toEqual({ epoch: 'epoch-1', seq: count });
  });
});
