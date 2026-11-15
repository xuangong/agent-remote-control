import type { CompleteItemInput, JournalItem } from './types.js';

export type ReplacementEntry =
  | { kind: 'reread'; complete: CompleteItemInput }
  | { kind: 'carried'; item: JournalItem };

/** An open item that native history lacks, closed: it is relay-only and keeps what was received. Other items stay as they are. */
function sealedCopy(item: JournalItem): JournalItem {
  if (item.state !== 'open' || item.liveOnly) return item;
  const { digest: _digest, ...rest } = item;
  return { ...rest, state: 'complete', liveOnly: true };
}

/**
 * The order of a new epoch: the reread items, with every old item the reread cannot reproduce, which is a live-only
 * item or an open one (carried sealed), kept right after the nearest preceding old item that survives, or before the
 * first reread item when none does. Carried items keep their relative order.
 */
export function replacementOrder(previous: readonly JournalItem[], reread: readonly CompleteItemInput[]): ReplacementEntry[] {
  const rereadKeys = new Set(reread.map(({ row }) => row.itemKey));
  const carriedAfter = new Map<string | null, JournalItem[]>();
  let anchor: string | null = null;
  for (const item of previous) {
    if (rereadKeys.has(item.itemKey)) {
      anchor = item.itemKey;
    } else if (item.liveOnly || item.state === 'open') {
      const carried = carriedAfter.get(anchor);
      if (carried) carried.push(sealedCopy(item));
      else carriedAfter.set(anchor, [sealedCopy(item)]);
    }
  }
  const carried = (key: string | null): ReplacementEntry[] =>
    (carriedAfter.get(key) ?? []).map(item => ({ kind: 'carried', item }));
  return [
    ...carried(null),
    ...reread.flatMap((complete): ReplacementEntry[] => [{ kind: 'reread', complete }, ...carried(complete.row.itemKey)]),
  ];
}
