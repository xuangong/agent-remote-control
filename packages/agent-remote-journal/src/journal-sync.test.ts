import { describe, expect, it } from 'vitest';

import { openJournal, PUBLISHER } from './journal.test-fixture.js';
import { MemoryJournalStore } from './journal-store.js';
import { SessionJournal } from './session-journal.js';
import { utf8ByteLength } from './utf8-size.js';
import type { JournalItemInput, JournalRowInput } from './types.js';

const ROOM = 1_000_000;
const row = (key: string, text: string, extra: Partial<JournalRowInput> = {}): JournalRowInput => ({
  itemKey: key, providerId: 'codex', sourceKey: `source-${key}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text, messageId: key }, ...extra,
});
/** A complete item: its digest follows its text. */
const done = (key: string, text = key, extra: Partial<JournalRowInput> = {}): JournalItemInput => ({ row: row(key, text, extra), digest: `digest:${key}:${text}` });
const open = (key: string, text = key, extra: Partial<JournalRowInput> = {}): JournalItemInput => ({ row: row(key, text, extra) });
const live = (key: string): JournalItemInput => done(key, key, { liveOnly: true });
const size = (item: JournalItemInput): number => utf8ByteLength(JSON.stringify(item));

function seeded(window: readonly JournalItemInput[] = []) {
  const { journal, publish } = openJournal();
  const sync = (next: readonly JournalItemInput[], roomBytes = ROOM) => journal.sync(publish(), next, { roomBytes });
  if (window.length > 0) sync(window);
  journal.takeChanges();
  return { journal, publish, sync };
}
const keys = (journal: SessionJournal): string[] => journal.state().items.map(({ itemKey }) => itemKey);

describe('what sync decides', () => {
  it('builds an empty journal from the window as a replacement', () => {
    const { journal, sync } = seeded();
    expect(sync([done('a'), done('b')])).toMatchObject({ outcome: 'replaced', trimmed: 0 });
    expect(keys(journal)).toEqual(['a', 'b']);
  });

  it('leaves a journal that already holds the window as it is, and writes nothing but the watermark', () => {
    const { journal, sync } = seeded([done('a'), done('b')]);
    const epoch = journal.epoch;
    expect(sync([done('a'), done('b')])).toEqual({ outcome: 'unchanged' });
    expect(journal.epoch).toBe(epoch);
    const changes = journal.takeChanges();
    expect(changes).toMatchObject({ upsert: [], removed: [], replaced: false });
  });

  it('treats a publication that was already applied as unchanged, and a repeated key as an error', () => {
    const { journal, publish } = openJournal();
    const publication = publish();
    expect(journal.sync(publication, [done('a')], { roomBytes: ROOM }).outcome).toBe('replaced');
    expect(journal.sync(publication, [done('a'), done('b')], { roomBytes: ROOM })).toEqual({ outcome: 'unchanged' });
    expect(keys(journal)).toEqual(['a']);
    expect(() => journal.sync(publish(), [done('a'), done('a')], { roomBytes: ROOM })).toThrow(/repeats item a/);
  });

  it('appends the items a window adds at the end, one sequence each, and keeps the epoch', () => {
    const { journal, sync } = seeded([done('a')]);
    const epoch = journal.epoch;
    const result = sync([done('a'), done('b'), open('c')]);
    expect(result).toMatchObject({ outcome: 'appended' });
    if (result.outcome !== 'appended') throw new Error('expected an append');
    expect(result.rows.map(({ itemKey, seq, epoch: rowEpoch }) => [itemKey, seq, rowEpoch])).toEqual([['b', 2, epoch], ['c', 3, epoch]]);
    const items = journal.state().items;
    expect(items.map(({ itemKey, state }) => [itemKey, state])).toEqual([['a', 'complete'], ['b', 'complete'], ['c', 'open']]);
    expect(journal.epoch).toBe(epoch);
    expect(sync([done('a'), done('b'), open('c')])).toEqual({ outcome: 'unchanged' });
  });

  it('replaces when a complete item has another digest, is missing, moved, or sits inside the window as a new item', () => {
    for (const next of [
      [done('a', 'changed'), done('b'), done('c')],
      [done('a'), done('c')],
      [done('c'), done('b'), done('a')],
      [done('a'), done('x'), done('b'), done('c')],
      [done('a'), done('b')],
    ]) {
      const { journal, sync } = seeded([done('a'), done('b'), done('c')]);
      const epoch = journal.epoch;
      expect(sync(next)).toMatchObject({ outcome: 'replaced' });
      expect(journal.epoch).not.toBe(epoch);
      expect(keys(journal)).toEqual(next.map(({ row: { itemKey } }) => itemKey));
    }
  });

  it('replaces when a complete item of the journal is open in the window, and the other way round', () => {
    const first = seeded([done('a')]);
    expect(first.sync([open('a')])).toMatchObject({ outcome: 'replaced' });
    const second = seeded([open('a')]);
    expect(second.sync([done('a')])).toMatchObject({ outcome: 'replaced' });
  });

  it('replaces a journal that is missing rows, even when the window equals it', () => {
    const { journal, sync } = seeded([done('a')]);
    journal.markIncomplete();
    expect(sync([done('a')])).toMatchObject({ outcome: 'replaced' });
    expect(journal.incomplete).toBe(false);
  });

  it('replaces a journal that has items when the window is empty, and leaves one that has only live-only items', () => {
    const withItems = seeded([done('a')]);
    expect(withItems.sync([])).toMatchObject({ outcome: 'replaced' });
    expect(keys(withItems.journal)).toEqual([]);
    const liveOnly = seeded([live('l')]);
    expect(liveOnly.sync([])).toEqual({ outcome: 'unchanged' });
    expect(seeded().sync([])).toEqual({ outcome: 'unchanged' });
  });
});

describe('items older than the journal', () => {
  it('does not replace for a window that reaches further back than the journal: older history arrives on request', () => {
    const { journal, sync } = seeded([done('c'), done('d')]);
    const epoch = journal.epoch;
    expect(sync([done('a'), done('b'), done('c'), done('d')])).toEqual({ outcome: 'unchanged' });
    expect(journal.epoch).toBe(epoch);
    expect(keys(journal)).toEqual(['c', 'd']);
  });

  it('does not replace for a long window over a journal that older requests extended downward', () => {
    const { journal, publish, sync } = seeded([done('n'), done('o')]);
    journal.prepend(publish(), [done('l'), done('m')]);
    const epoch = journal.epoch;
    const long = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'].map(key => done(key));
    expect(sync(long)).toEqual({ outcome: 'unchanged' });
    expect(journal.epoch).toBe(epoch);
    expect(keys(journal)).toEqual(['l', 'm', 'n', 'o']);
  });

  it('replaces the same window when a non-live-only item sits before the first shared key', () => {
    const { journal, sync } = seeded([done('x'), done('c'), done('d')]);
    const epoch = journal.epoch;
    expect(sync([done('a'), done('b'), done('c'), done('d')])).toMatchObject({ outcome: 'replaced' });
    expect(journal.epoch).not.toBe(epoch);
    expect(keys(journal)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips leading items when only live-only items precede the first shared key', () => {
    const { journal, sync } = seeded([live('l'), done('c'), done('d')]);
    expect(sync([done('a'), done('b'), done('c'), done('d')])).toEqual({ outcome: 'unchanged' });
    expect(keys(journal)).toEqual(['l', 'c', 'd']);
  });

  it('replaces when the window shares no key with a journal that has items', () => {
    const { journal, sync } = seeded([done('a')]);
    expect(sync([done('x'), done('y')])).toMatchObject({ outcome: 'replaced' });
    expect(keys(journal)).toEqual(['x', 'y']);
  });
});

describe('live-only items', () => {
  it('skips a live-only item that the window lacks, in the middle and at the end, and appends after it', () => {
    const { journal, sync } = seeded([done('a'), live('l'), done('b'), live('z')]);
    const epoch = journal.epoch;
    expect(sync([done('a'), done('b')])).toEqual({ outcome: 'unchanged' });
    expect(sync([done('a'), done('b'), done('c')])).toMatchObject({ outcome: 'appended' });
    expect(keys(journal)).toEqual(['a', 'l', 'b', 'z', 'c']);
    expect(journal.epoch).toBe(epoch);
  });

  it('carries live-only items through a replacement', () => {
    const { journal, sync } = seeded([done('a'), live('l'), done('b')]);
    expect(sync([done('a', 'changed'), done('b')])).toMatchObject({ outcome: 'replaced' });
    expect(keys(journal)).toEqual(['a', 'l', 'b']);
    expect(journal.state().items[1]).toMatchObject({ itemKey: 'l', liveOnly: true });
  });

  it('replaces a live-only copy with the window item of the same key, keeping its alias, and is then stable', () => {
    const { journal, publish, sync } = seeded([{ row: row('u', 'ask', { item: { type: 'user_message', text: 'ask' }, liveOnly: true }), digest: 'du' }, done('b')]);
    journal.alias(publish(), 'u', 'client-1');
    const reread: JournalItemInput = { row: row('u', 'ask', { item: { type: 'user_message', text: 'ask' } }), digest: 'du' };
    expect(sync([reread, done('b')])).toMatchObject({ outcome: 'replaced' });
    const [user] = journal.state().items;
    expect(user).toMatchObject({ itemKey: 'u', liveOnly: false, clientMessageId: 'client-1' });
    expect(keys(journal)).toEqual(['u', 'b']);
    expect(sync([reread, done('b')])).toEqual({ outcome: 'unchanged' });
  });

  it('keeps the live-only mark of an item that completed while the Controller was away', () => {
    const { journal, sync } = seeded([open('l', 'part', { liveOnly: true })]);
    expect(sync([done('l', 'whole', { liveOnly: true })])).toMatchObject({ outcome: 'replaced' });
    expect(journal.state().items[0]).toMatchObject({ itemKey: 'l', liveOnly: true, state: 'complete' });
  });

  it('replaces without a duplicate when a carried live-only item is also at the end of the reread', () => {
    const { journal, sync } = seeded([done('a'), done('b')]);
    // Another window that lacks `a` puts a live-only `q` first; the reread then holds `q` at the end.
    const carried = seeded([live('q'), done('a'), done('b')]);
    expect(keys(carried.journal)).toEqual(['q', 'a', 'b']);
    expect(carried.sync([done('a'), done('b'), done('q')])).toMatchObject({ outcome: 'replaced' });
    expect(keys(carried.journal)).toEqual(['a', 'b', 'q']);
    expect(keys(carried.journal).filter(key => key === 'q')).toHaveLength(1);
    expect(journal.epoch).toBeTruthy();
    expect(sync([done('a'), done('b')])).toEqual({ outcome: 'unchanged' });
  });
});

describe('open items', () => {
  it('counts an open item whose resident content equals the window as unchanged, and a changed one as a replacement', () => {
    const { journal, sync } = seeded([done('a'), open('o', 'streaming')]);
    const epoch = journal.epoch;
    expect(sync([done('a'), open('o', 'streaming')])).toEqual({ outcome: 'unchanged' });
    expect(journal.epoch).toBe(epoch);
    expect(sync([done('a'), open('o', 'streaming more')])).toMatchObject({ outcome: 'replaced' });
    expect(journal.epoch).not.toBe(epoch);
    expect(journal.state().items[1]).toMatchObject({ itemKey: 'o', state: 'open' });
  });

  it('ignores the background and the alias when it compares open content', () => {
    const { journal, publish, sync } = seeded([{ row: row('u', 'ask', { item: { type: 'user_message', text: 'ask' } }) }]);
    journal.alias(publish(), 'u', 'client-1');
    expect(sync([{ row: row('u', 'ask', { item: { type: 'user_message', text: 'ask' } }) }])).toEqual({ outcome: 'unchanged' });
  });

  it('replaces an open item that has no resident body', () => {
    const { journal, sync } = seeded([open('o', 'streaming')]);
    const state = journal.state();
    state.items[0]!.body = null;
    const stripped = new SessionJournal(state);
    const { generation } = stripped.claim(PUBLISHER);
    expect(stripped.sync({ publisherId: PUBLISHER, generation, sequence: (stripped.publisher?.watermark ?? 0) + 1 }, [open('o', 'streaming')], { roomBytes: ROOM }).outcome).toBe('replaced');
    expect(sync([open('o', 'streaming')]).outcome).toBe('unchanged');
  });

  it('does not carry an open item that is not live-only through a replacement', () => {
    const { journal, sync } = seeded([done('a'), open('o', 'partial'), done('b')]);
    expect(sync([done('a', 'changed'), done('b')])).toMatchObject({ outcome: 'replaced' });
    expect(keys(journal)).toEqual(['a', 'b']);
  });
});

describe('the room', () => {
  const items = ['a', 'b', 'c', 'd'].map(key => done(key, key.repeat(200)));

  function fixed(): number {
    const { journal } = seeded();
    return journal.residentBytes();
  }

  it('trims a window to the newest items that fit, counting the meta, and reports how many it dropped', () => {
    const base = fixed();
    const sizes = items.map(size);
    const fits = (count: number) => base + sizes.slice(items.length - count).reduce((a, b) => a + b, 0);
    for (const count of [4, 3, 1]) {
      const { journal, sync } = seeded();
      expect(sync(items, fits(count))).toMatchObject({ outcome: 'replaced', trimmed: items.length - count });
      expect(keys(journal)).toEqual(items.slice(items.length - count).map(({ row: { itemKey } }) => itemKey));
    }
    // A room that fits the items but not the meta trims one more.
    const { journal, sync } = seeded();
    expect(sync(items, fits(3) - 1)).toMatchObject({ outcome: 'replaced', trimmed: 2 });
    expect(keys(journal)).toEqual(['c', 'd']);
  });

  it('is unchanged under a larger room, because the leading items are older history, and under a smaller room', () => {
    const base = fixed();
    const sizes = items.map(size);
    const small = base + sizes[2]! + sizes[3]!;
    const { journal, sync } = seeded();
    expect(sync(items, small)).toMatchObject({ outcome: 'replaced', trimmed: 2 });
    const epoch = journal.epoch;
    expect(sync(items, ROOM)).toEqual({ outcome: 'unchanged' });
    const meta = new SessionJournal({ meta: journal.state().meta, items: [] }).residentBytes();
    expect(sync(items, meta + sizes[3]!)).toEqual({ outcome: 'unchanged' });
    expect(journal.epoch).toBe(epoch);
    expect(keys(journal)).toEqual(['c', 'd']);
  });

  it('replaces instead of appending an extension that does not fit', () => {
    const { journal, sync } = seeded([done('a', 'a'.repeat(200))]);
    const room = journal.residentBytes() + 10;
    const epoch = journal.epoch;
    expect(sync([done('a', 'a'.repeat(200)), done('b', 'b'.repeat(200))], room)).toMatchObject({ outcome: 'replaced', trimmed: 1 });
    expect(journal.epoch).not.toBe(epoch);
  });

  it('keeps the live-only items out of the trim: they are carried and counted first', () => {
    const { journal, sync } = seeded([live('l')]);
    const room = journal.residentBytes() + size(items[3]!);
    expect(sync(items, room)).toMatchObject({ outcome: 'replaced', trimmed: 3 });
    expect(keys(journal)).toEqual(['l', 'd']);
  });
});

describe('no write for a restatement', () => {
  it('writes no item, no removal and no replacement for the same window, outcome and binding again', async () => {
    const background = { id: 'bg-1', kind: 'review' as const, status: 'visible' as const };
    const binding = { locator: 'file:a', resourceId: 'r1', status: 'available' as const };
    const window = [
      done('a', 'a', { resources: [binding], item: { type: 'tool_call', callId: 'a', name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: 'ls' }, background } }),
      open('o', 'streaming'),
    ];
    const store = new MemoryJournalStore();
    const { journal, publish, sync } = seeded();
    sync(window);
    await store.apply(journal.takeChanges()!);
    sync(window);
    expect(journal.outcome(publish(), background)).toBe(false);
    expect(journal.rebind(publish(), 'a', binding, binding)).toBeUndefined();
    const changes = journal.takeChanges();
    expect(changes).toMatchObject({ upsert: [], removed: [], replaced: false });
    expect(changes?.meta.publisher?.watermark).toBe(4);
  });

  it('is unchanged when a journal restored from its state is synced again', () => {
    const { journal, sync } = seeded([done('a'), live('l'), open('o', 'streaming')]);
    sync([done('a'), open('o', 'streaming')]);
    const restored = new SessionJournal(journal.state());
    const { generation, watermark } = restored.claim(PUBLISHER);
    expect(restored.sync({ publisherId: PUBLISHER, generation, sequence: watermark + 1 }, [done('a'), open('o', 'streaming')], { roomBytes: ROOM })).toEqual({ outcome: 'unchanged' });
  });
});

describe('oldestItemKey', () => {
  it('names the first item that is not live-only', () => {
    const { journal, publish } = seeded([live('l'), done('b'), done('c')]);
    expect(journal.oldestItemKey).toBe('b');
    journal.prepend(publish(), [done('a')]);
    expect(journal.oldestItemKey).toBe('a');
    expect(seeded([live('l')]).journal.oldestItemKey).toBeUndefined();
    expect(seeded().journal.oldestItemKey).toBeUndefined();
  });
});
