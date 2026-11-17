import { itemDigest } from '@orchardworks/agent-remote-journal';
import { JOURNAL_PUBLISH_MAX_ENTRIES } from '@orchardworks/agent-remote-protocol';
import type { CanonicalTimelineRow } from '@orchardworks/agent-timeline';
import { describe, expect, it } from 'vitest';

import { blocksOf, chunkOps, entryBytes, groupItems, mergedRow, MESSAGE_BUDGET_BYTES, newestItems, sizedItems, type PublishOp, type SizedItem } from './journal-items.js';

let seq = 0;
const row = (key: string | undefined, text: string, extra: Partial<CanonicalTimelineRow> = {}): CanonicalTimelineRow => ({
  epoch: 'e', seq: ++seq, providerId: 'fake', sourceKey: `source:${seq}`, occurredAt: 1_725_000_000_000 + seq, timestamp: new Date(1_725_000_000_000 + seq).toISOString(),
  turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key ?? 'none' }, resources: [], ...(key === undefined ? {} : { identity: { key } }), ...extra,
});
const digest = (item: { rows: CanonicalTimelineRow[] }) => itemDigest(mergedRow({ key: 'k', rows: item.rows, complete: true, liveOnly: false }).item);

describe('items of the Controller timeline', () => {
  it('groups rows by item key in the order the items first appear, and tells complete from open', () => {
    const items = groupItems([
      row('a', 'Hel'), row('b', 'Other'), row('a', 'lo', { identity: { key: 'a', completes: true } }),
      row('c', 'Never finished'),
    ]);
    expect(items.map(({ key, complete, liveOnly, rows }) => [key, complete, liveOnly, rows.length])).toEqual([['a', true, false, 2], ['b', false, false, 1], ['c', false, false, 1]]);
  });

  it('reopens a complete item when a later row adds content, as the journal does', () => {
    const [reopened, closed] = groupItems([
      row('a', 'Done', { identity: { key: 'a', completes: true } }), row('a', ' and more', { identity: { key: 'a' } }),
      row('b', 'Done', { identity: { key: 'b' } }), row('b', ' now', { identity: { key: 'b', completes: true } }),
    ]);
    expect([reopened?.complete, closed?.complete]).toEqual([false, true]);
  });

  it('gives a row without identity a key of its own, completes it at once and keeps it live-only', () => {
    const [item] = groupItems([row(undefined, 'Made by the Controller')]);
    expect(item).toMatchObject({ key: expect.stringMatching(/^controller:source:\d+$/), complete: true, liveOnly: true });
  });

  it('keeps every item under the reserved controller key prefix live-only, whatever the row says', () => {
    const [item] = groupItems([row('controller:question-1', 'Asked', { identity: { key: 'controller:question-1', completes: true } })]);
    expect(item).toMatchObject({ key: 'controller:question-1', complete: true, liveOnly: true });
  });

  it('marks an item live-only when any of its rows says so', () => {
    const [item] = groupItems([row('a', 'x'), row('a', 'y', { identity: { key: 'a', liveOnly: true } })]);
    expect(item?.liveOnly).toBe(true);
  });

  it('merges the rows of an item the way the journal merges them, so live deltas and a reread have one digest', async () => {
    const live = groupItems([row('a', 'Hel'), row('a', 'lo, '), row('a', 'world', { identity: { key: 'a', completes: true } })])[0]!;
    const reread = groupItems([row('a', 'Hello, world', { identity: { key: 'a', completes: true } })])[0]!;
    expect(mergedRow(live).item).toEqual({ type: 'assistant_message', text: 'Hello, world', messageId: 'a' });
    expect(await digest(live)).toBe(await digest(reread));
  });

  it('takes the time, source and turn of the first row, and the resources of all of them', () => {
    const merged = mergedRow(groupItems([
      row('a', 'x', { resources: [{ locator: 'one.md', resourceId: 'r1', status: 'pending' }] }),
      row('a', 'y', { resources: [{ locator: 'two.md', resourceId: 'r2', status: 'pending' }] }),
    ])[0]!);
    expect(merged).toMatchObject({ itemKey: 'a', providerId: 'fake', turnId: 'turn-1', resources: [{ resourceId: 'r1' }, { resourceId: 'r2' }] });
    expect(merged.sourceKey).toMatch(/^source:\d+$/);
  });

  it('keeps the time, source, turn and live-only mark of the first row, whatever the later rows say', () => {
    const first = row('a', 'x', { turnId: 'turn-first', identity: { key: 'a', liveOnly: true } });
    const last = row('a', 'y', { turnId: 'turn-last', identity: { key: 'a', completes: true } });
    const merged = mergedRow(groupItems([first, last])[0]!);
    expect(merged).toMatchObject({ sourceKey: first.sourceKey, occurredAt: first.occurredAt, turnId: 'turn-first', liveOnly: true });
    expect(mergedRow(groupItems([row('b', 'plain')])[0]!)).not.toHaveProperty('liveOnly');
  });
});

describe('what the wire accepts', () => {
  it('measures an entry, and refuses one the schema or the limits do not allow', () => {
    const fine: PublishOp = { op: 'append', row: mergedRow(groupItems([row('a', 'Hello')])[0]!) };
    expect(entryBytes(fine)).toBeGreaterThan(100);
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), turnId: 't'.repeat(513) } })).toBeUndefined();
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), sourceKey: 's'.repeat(4097) } })).toBeUndefined();
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), occurredAt: -1 } })).toBeUndefined();
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), resources: Array.from({ length: 257 }, (_, at) => ({ locator: `f${at}`, resourceId: `r${at}`, status: 'pending' as const })) } })).toBeUndefined();
    expect(entryBytes({ op: 'seal', itemKey: 'k'.repeat(4097) })).toBeUndefined();
  });

  it('sizes items for a message and names the ones it refuses', async () => {
    const items = groupItems([row('a', 'Hello', { identity: { key: 'a', completes: true } }), row('b'.repeat(4097), 'Too long a key', { identity: { key: 'b'.repeat(4097), completes: true } })]);
    const { accepted, refused } = await sizedItems(items, digest);
    expect(accepted.map(({ item }) => item.row.itemKey)).toEqual(['a']);
    expect(refused).toEqual(['b'.repeat(4097)]);
    expect(accepted[0]!.item.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives an item that is still open no digest', async () => {
    const { accepted } = await sizedItems(groupItems([row('a', 'Streaming', { identity: { key: 'a' } })]), digest);
    expect(accepted[0]!.item).not.toHaveProperty('digest');
  });

  it('cuts items into blocks that each fit one message and keep their order', () => {
    const big = (key: string, bytes: number): SizedItem => ({ item: { row: { itemKey: key, providerId: 'fake', sourceKey: key, occurredAt: 1, item: { type: 'assistant_message', text: '' } }, digest: 'd' }, bytes });
    const blocks = blocksOf([big('a', 3_000_000), big('b', 1_000_000), big('c', 3_000_000), big('d', 10_000_000), big('e', 10)]);
    expect(blocks.map(block => block.map(({ row: { itemKey } }) => itemKey))).toEqual([['a', 'b'], ['c'], ['d'], ['e']]);
  });

  it('takes the newest items that fit one message, at least one', async () => {
    const items = groupItems(Array.from({ length: 6 }, (_, at) => row(`k${at}`, 'x'.repeat(1_200_000), { identity: { key: `k${at}`, completes: true } })));
    const { block } = await newestItems(items, digest);
    expect(block.map(({ row: { itemKey } }) => itemKey)).toEqual(['k3', 'k4', 'k5']);
    expect((await newestItems(items.slice(0, 1), digest)).block).toHaveLength(1);
  });

  it('counts an entry by its own bytes, so 3,000 short replies fit one block', async () => {
    const items = groupItems(Array.from({ length: 3000 }, (_, at) => row(`k${at}`, 'Fine.', { identity: { key: `k${at}`, completes: true } })));
    const { block } = await newestItems(items, digest);
    expect(block).toHaveLength(3000);
    expect(entryBytes({ op: 'append', row: mergedRow(groupItems([row('a', 'Hi')])[0]!) })).toBeLessThan(1000);
  });

  it('refuses an item that only fits the wire under a short session key', () => {
    const text = 'x'.repeat(8 * 1024 * 1024 - 1000);
    expect(entryBytes({ op: 'append', row: mergedRow(groupItems([row('a', text)])[0]!) })).toBeUndefined();
    expect(entryBytes({ op: 'append', row: mergedRow(groupItems([row('a', 'x'.repeat(8 * 1024 * 1024 - 20_000))])[0]!) })).toBeGreaterThan(8 * 1024 * 1024 - 21_000);
  });

  it('chunks operations by entry count and bytes, keeping their order', () => {
    const op = (at: number): PublishOp => ({ op: 'seal', itemKey: `k${at}` });
    const many = Array.from({ length: JOURNAL_PUBLISH_MAX_ENTRIES + 5 }, (_, at) => ({ op: op(at), bytes: 100 }));
    const chunks = chunkOps(many);
    expect(chunks.map(chunk => chunk.ops.length)).toEqual([JOURNAL_PUBLISH_MAX_ENTRIES, 5]);
    const heavy = chunkOps([{ op: op(1), bytes: MESSAGE_BUDGET_BYTES }, { op: op(2), bytes: 1 }, { op: op(3), bytes: MESSAGE_BUDGET_BYTES + 10 }]);
    expect(heavy.map(chunk => chunk.ops.map(entry => 'itemKey' in entry ? entry.itemKey : '?'))).toEqual([['k1'], ['k2'], ['k3']]);
    expect(heavy[2]!.bytes).toBe(MESSAGE_BUDGET_BYTES + 10);
    expect(chunkOps([])).toEqual([]);
  });
});
