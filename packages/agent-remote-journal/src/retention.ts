import type { JournalItem } from './types.js';

/**
 * Items whose bodies may be evicted: complete, resident, not live-only and carrying a digest, outside the latest turns.
 * An item without a digest, such as a sealed one, has no native copy to fill from and is never evicted. Consecutive
 * items of one turn form one unit; a late item of an earlier turn forms a unit of its own, as does an item without a
 * turn.
 */
export function evictableItems(items: readonly JournalItem[], keepLatestTurns: number): string[] {
  if (!Number.isSafeInteger(keepLatestTurns) || keepLatestTurns < 0) throw new Error('Journal turns to keep must be a non-negative integer.');
  const units: JournalItem[][] = [];
  for (const item of items) {
    const unit = units.at(-1);
    if (unit && item.turnId !== undefined && unit[0]?.turnId === item.turnId) unit.push(item);
    else units.push([item]);
  }
  return units.slice(0, Math.max(0, units.length - keepLatestTurns)).flat()
    .filter(item => item.state === 'complete' && item.digest !== undefined && item.body !== null && !item.liveOnly)
    .map(({ itemKey }) => itemKey);
}
