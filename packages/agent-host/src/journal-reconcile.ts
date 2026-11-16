import { mergeBackgroundActivity, type BackgroundActivity } from '@orchardworks/agent-remote-protocol';

import { digestOf, entryBytes, mergedRow, newestItems, type PublishOp, type SizedOp, type TimelineItem } from './journal-items.js';

/**
 * The newest items that fit one message, as one `window` entry the Relay compares with its journal. Items the wire refuses
 * are left out and named in `refused`. `count` is the number of items the window holds.
 */
export async function windowOp(timeline: readonly TimelineItem[]): Promise<{ op: SizedOp; count: number; refused: string[] }> {
  const { block, refused } = await newestItems(timeline, digestOf);
  const op: PublishOp = { op: 'window', items: block };
  return { op: { op, bytes: entryBytes(op) ?? 0 }, count: block.length, refused };
}

/**
 * One outcome entry for each background of the items, with the strongest status their rows carry. A journal built from a
 * reread has the backgrounds of its rows but not the outcomes the Controller learned about later, so each open
 * says them again; applying an outcome twice changes nothing.
 */
export function outcomeOps(items: readonly TimelineItem[]): SizedOp[] {
  const found = new Map<string, { providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number }>();
  for (const item of items) {
    if (!item.rows.some(row => row.item.background)) continue;
    const row = mergedRow(item);
    const background = row.item.background;
    if (!background) continue;
    const previous = found.get(background.id);
    found.set(background.id, {
      providerId: row.providerId, ...(row.turnId === undefined ? {} : { turnId: row.turnId }), occurredAt: row.occurredAt,
      background: previous ? mergeBackgroundActivity(previous.background, background) : background,
    });
  }
  return [...found.values()].flatMap(outcome => {
    const op: PublishOp = { op: 'outcome', ...outcome };
    const bytes = entryBytes(op);
    return bytes === undefined ? [] : [{ op, bytes }];
  });
}

/**
 * One rebind for each settled binding of the items. A journal built from a reread holds the bindings its rows had when they
 * were published, and a rebind the Controller sent live can be lost with a restart or a lost connection, so each open
 * says the settled bindings again; the journal ignores a rebind that changes nothing.
 */
export function rebindOps(items: readonly TimelineItem[]): SizedOp[] {
  const ops: SizedOp[] = [];
  for (const item of items) {
    for (const binding of mergedRow(item).resources ?? []) {
      if (binding.status === 'pending') continue;
      const op: PublishOp = { op: 'rebind', itemKey: item.key, previous: binding, replacement: binding };
      const bytes = entryBytes(op);
      if (bytes !== undefined) ops.push({ op, bytes });
    }
  }
  return ops;
}
