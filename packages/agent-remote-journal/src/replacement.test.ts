import { describe, expect, it } from 'vitest';

import { replacementOrder } from './replacement.js';
import type { CompleteItemInput, JournalItem } from './types.js';

/** An old item; a trailing `*` marks it live-only and a trailing `~` open. */
const old = (name: string): JournalItem => ({
  itemKey: name.replace(/[*~]$/, ''), providerId: 'codex', seqStart: 1, seqEnd: 1, sourceSeqRanges: [],
  state: name.endsWith('~') ? 'open' : 'complete', liveOnly: name.endsWith('*'), revision: 1, body: null,
});
const read = (key: string): CompleteItemInput => ({
  row: { itemKey: key, providerId: 'codex', sourceKey: key, occurredAt: 0, item: { type: 'reasoning', text: key } },
  digest: key,
});

/** Reread items are shown by key; carried items with a trailing `*`. */
function order(previous: string[], reread: string[]): string[] {
  return replacementOrder(previous.map(old), reread.map(read))
    .map(entry => entry.kind === 'reread' ? entry.complete.row.itemKey : `${entry.item.itemKey}*`);
}

describe('replacementOrder', () => {
  it.each([
    ['a live-only item between items', ['m1', 'a*', 'm2'], ['m1', 'm2'], ['m1', 'a*', 'm2']],
    ['a live-only item first', ['a*', 'm1', 'm2'], ['m1', 'm2'], ['a*', 'm1', 'm2']],
    ['a live-only item last', ['m1', 'm2', 'a*'], ['m1', 'm2'], ['m1', 'm2', 'a*']],
    ['consecutive live-only items', ['m1', 'a*', 'b*', 'm2'], ['m1', 'm2'], ['m1', 'a*', 'b*', 'm2']],
    ['a live-only item after a dropped item', ['m1', 'm2', 'a*'], ['m1'], ['m1', 'a*']],
    ['a live-only item after a dropped item with a survivor before it', ['m1', 'm2', 'a*', 'm3'], ['m1', 'm3'], ['m1', 'a*', 'm3']],
    ['no preceding item surviving', ['m1', 'a*', 'm2'], ['m2'], ['a*', 'm2']],
    ['an empty reread', ['m1', 'a*', 'b*'], [], ['a*', 'b*']],
    ['only live-only items', ['a*', 'b*'], ['m1'], ['a*', 'b*', 'm1']],
    ['a reordered reread', ['m1', 'a*', 'm2', 'b*'], ['m2', 'm1'], ['m2', 'b*', 'm1', 'a*']],
    ['a live-only key that the reread contains', ['m1', 'a*', 'm2'], ['m1', 'a', 'm2'], ['m1', 'a', 'm2']],
    ['an open item the reread lacks', ['m1', 'x~', 'm2'], ['m1', 'm2'], ['m1', 'x*', 'm2']],
    ['an open item first that the reread lacks', ['x~', 'm1'], ['m1'], ['x*', 'm1']],
    ['an open item that the reread contains', ['m1', 'x~', 'm2'], ['m1', 'x', 'm2'], ['m1', 'x', 'm2']],
    ['a live-only item after a live-only item the reread contains', ['m1', 'a*', 'b*'], ['m1', 'a'], ['m1', 'a', 'b*']],
  ])('%s', (_name, previous, reread, expected) => {
    expect(order(previous, reread)).toEqual(expected);
  });
});

describe('replacementOrder carried open items', () => {
  it('seals an open item the reread lacks and leaves the old item untouched', () => {
    const open = old('x~');
    const [carried] = replacementOrder([open], []);
    expect(carried).toMatchObject({ kind: 'carried', item: { itemKey: 'x', state: 'complete', liveOnly: true } });
    expect((carried as { item: JournalItem }).item.digest).toBeUndefined();
    expect(open).toMatchObject({ state: 'open', liveOnly: false });
  });

  it('carries an open live-only item as it is, still open', () => {
    const open = { ...old('x~'), liveOnly: true };
    const [carried] = replacementOrder([open], []);
    expect(carried).toMatchObject({ kind: 'carried', item: { itemKey: 'x', state: 'open', liveOnly: true } });
  });
});
