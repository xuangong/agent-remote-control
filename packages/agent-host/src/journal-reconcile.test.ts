import type { CanonicalTimelineRow } from '@orchardworks/agent-timeline';
import { describe, expect, it } from 'vitest';

import { digestOf, groupItems, MESSAGE_BUDGET_BYTES } from './journal-items.js';
import { outcomeOps, rebindOps, windowOp } from './journal-reconcile.js';

let seq = 0;
const row = (key: string, text: string, extra: Partial<CanonicalTimelineRow> = {}): CanonicalTimelineRow => ({
  epoch: 'e', seq: ++seq, providerId: 'fake', sourceKey: `source:${seq}`, occurredAt: 1_725_000_000_000 + seq, timestamp: new Date(1_725_000_000_000 + seq).toISOString(),
  turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key }, resources: [], identity: { key, completes: true }, ...extra,
});
const items = (...rows: CanonicalTimelineRow[]) => groupItems(rows);

describe('what a Controller says when it opens a journal', () => {
  it('sends the newest items that fit one message as one window, oldest first, complete ones with their digest and open ones without', async () => {
    const timeline = items(row('a', 'x'.repeat(Math.floor(MESSAGE_BUDGET_BYTES * 0.6))), row('b', 'x'.repeat(Math.floor(MESSAGE_BUDGET_BYTES * 0.5))), row('c', 'Three', { identity: { key: 'c' } }));
    const { op, count, refused } = await windowOp(timeline);
    expect(refused).toEqual([]);
    expect(count).toBe(2);
    expect(op.op).toMatchObject({ op: 'window' });
    const window = op.op as Extract<typeof op.op, { op: 'window' }>;
    expect(window.items.map(({ row: { itemKey }, digest }) => [itemKey, digest === undefined])).toEqual([['b', false], ['c', true]]);
    expect(window.items[0]!.digest).toBe(await digestOf(timeline[1]!));
  });

  it('names the items the wire refuses and leaves them out', async () => {
    const long = 'k'.repeat(4097);
    const { count, refused } = await windowOp(items(row('a', 'One'), row(long, 'Too long')));
    expect(count).toBe(1);
    expect(refused).toEqual([long]);
  });

  it('says the outcome of every background of the items again, with the strongest status', () => {
    const first = row('a', 'a', { item: { type: 'assistant_message', text: 'a', messageId: 'a', background: { id: 'review-1', kind: 'review', status: 'visible' } } });
    const second = row('b', 'b', { item: { type: 'assistant_message', text: 'b', messageId: 'b', background: { id: 'review-1', kind: 'review', status: 'pending' } } });
    const ops = outcomeOps(items(first, second, row('c', 'No background'))).map(({ op }) => op);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'outcome', background: { id: 'review-1', status: 'visible' } });
  });

  it('says the settled bindings of the items again, and leaves a pending one to the event that settles it', () => {
    const settled = { locator: 'a.png', resourceId: 'r1', status: 'available' as const };
    const pending = { locator: 'b.png', resourceId: 'r2', status: 'pending' as const };
    const ops = rebindOps(items(row('a', 'a', { resources: [settled] }), row('b', 'b', { resources: [pending] }))).map(({ op }) => op);
    expect(ops).toEqual([{ op: 'rebind', itemKey: 'a', previous: settled, replacement: settled }]);
  });
});
