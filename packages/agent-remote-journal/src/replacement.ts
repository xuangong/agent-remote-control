import type { JournalItem, JournalItemInput } from './types.js';

type ReplacementEntry =
  | { kind: 'reread'; complete: JournalItemInput }
  | { kind: 'carried'; item: JournalItem };

/**
 * The order of a new epoch: the reread items, with every old item the reread cannot reproduce, which is a live-only
 * item, kept right after the nearest preceding old item that
 * survives, or before the first reread item when none does. Carried items keep their relative order.
 */
export function replacementOrder(previous: readonly JournalItem[], reread: readonly JournalItemInput[]): ReplacementEntry[] {
  const rereadKeys = new Set(reread.map(({ row }) => row.itemKey));
  const carriedAfter = new Map<string | null, JournalItem[]>();
  let anchor: string | null = null;
  for (const item of previous) {
    if (rereadKeys.has(item.itemKey)) {
      anchor = item.itemKey;
    } else if (item.liveOnly) {
      const carried = carriedAfter.get(anchor);
      if (carried) carried.push(item);
      else carriedAfter.set(anchor, [item]);
    }
  }
  const carried = (key: string | null): ReplacementEntry[] =>
    (carriedAfter.get(key) ?? []).map(item => ({ kind: 'carried', item }));
  return [
    ...carried(null),
    ...reread.flatMap((complete): ReplacementEntry[] => [{ kind: 'reread', complete }, ...carried(complete.row.itemKey)]),
  ];
}
