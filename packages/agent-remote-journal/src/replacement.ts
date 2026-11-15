import type { CompleteItemInput, JournalItem } from './types.js';

export type ReplacementEntry =
  | { kind: 'reread'; complete: CompleteItemInput }
  | { kind: 'carried'; item: JournalItem };

/**
 * The order of a new epoch: the reread items, with every live-only item the reread cannot reproduce kept right after
 * the nearest preceding old item that survives, or before the first reread item when none does. Carried items keep
 * their relative order.
 */
export function replacementOrder(previous: readonly JournalItem[], reread: readonly CompleteItemInput[]): ReplacementEntry[] {
  const rereadKeys = new Set(reread.map(({ row }) => row.itemKey));
  const carriedAfter = new Map<string | null, JournalItem[]>();
  let anchor: string | null = null;
  for (const item of previous) {
    if (rereadKeys.has(item.itemKey)) anchor = item.itemKey;
    else if (item.liveOnly) carriedAfter.set(anchor, [...(carriedAfter.get(anchor) ?? []), item]);
  }
  const carried = (key: string | null): ReplacementEntry[] =>
    (carriedAfter.get(key) ?? []).map(item => ({ kind: 'carried', item }));
  return [
    ...carried(null),
    ...reread.flatMap((complete): ReplacementEntry[] => [{ kind: 'reread', complete }, ...carried(complete.row.itemKey)]),
  ];
}
