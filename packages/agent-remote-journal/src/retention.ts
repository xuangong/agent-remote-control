import type { JournalItem } from './types.js';

/**
 * Where the retained window starts: an index into `items`. The window is the latest `keepLatestTurns` turns or the latest
 * `keepLatestItems` items, whichever reaches further back. Consecutive items of one turn form one unit; a late item of an
 * earlier turn forms a unit of its own, as does an item without a turn.
 */
export function retainedFrom(items: readonly JournalItem[], keepLatestTurns: number, keepLatestItems = 0): number {
  if (!Number.isSafeInteger(keepLatestTurns) || keepLatestTurns < 0) throw new Error('Journal turns to keep must be a non-negative integer.');
  if (!Number.isSafeInteger(keepLatestItems) || keepLatestItems < 0) throw new Error('Journal items to keep must be a non-negative integer.');
  let units = 0;
  let turnStart = items.length;
  let previous: JournalItem | undefined;
  const starts: number[] = [];
  items.forEach((item, at) => {
    if (previous && item.turnId !== undefined && previous.turnId === item.turnId) { previous = item; return; }
    starts.push(at);
    units += 1;
    previous = item;
  });
  if (keepLatestTurns > 0) turnStart = starts[Math.max(0, units - keepLatestTurns)] ?? items.length;
  return Math.min(turnStart, Math.max(0, items.length - keepLatestItems));
}

/** Whether an item's body may be evicted: complete, resident, not live-only and carrying a digest to fill it back from. */
export const evictable = (item: JournalItem): boolean => item.state === 'complete' && item.digest !== undefined && item.body !== null && !item.liveOnly;

/**
 * Items whose bodies may be evicted: complete, resident, not live-only and carrying a digest, outside the retained window
 * (see `retainedFrom`). An item without a digest, such as a sealed one, has no native copy to fill from and is never evicted.
 */
export function evictableItems(items: readonly JournalItem[], keepLatestTurns: number, keepLatestItems = 0): string[] {
  return items.slice(0, retainedFrom(items, keepLatestTurns, keepLatestItems)).filter(evictable).map(({ itemKey }) => itemKey);
}
