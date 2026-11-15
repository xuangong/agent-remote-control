import { describe, expect, it } from 'vitest';

import { openJournal, text } from './journal.test-fixture.js';

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
});
