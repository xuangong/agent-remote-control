import { JournalDuplicateItemError, type JournalIndexEntry } from './types.js';

/** One item of a reread of native history, oldest first. */
export interface ReconcileCandidate {
  itemKey: string;
  digest: string;
}

export type ReconcilePlan =
  | { kind: 'continue'; prepend: string[]; append: string[]; correct: string[]; abandon: string[] }
  | { kind: 'replace'; reason: 'missing' | 'reordered' | 'inserted' }
  | { kind: 'gap' };

/**
 * Compares a reread of native history with the journal. A reread that repeats an item key is rejected.
 *
 * Every journal item takes part in positioning, so a reread item may match a live-only one, such as a sealed item
 * that native history now contains; a matched item is corrected when it is open, has no digest or its digest differs.
 * The reread's oldest item is the anchor: journal items older than it are outside the window and stay. When the
 * reread starts with items the journal does not know and its first known item is the journal's first non-live-only
 * item, those leading items are older history and are returned in `prepend`, oldest first; any other known item
 * after unknown ones means native history was rewritten (`replace`), and no known item at all is a `gap`.
 *
 * Journal items passed over inside the window, or left after its last match, are ignored when live-only, abandoned
 * when open (native history never kept them), ignored when complete without a digest, and otherwise mean a complete
 * item went missing (`replace`).
 */
export function planReconcile(index: readonly JournalIndexEntry[], reread: readonly ReconcileCandidate[]): ReconcilePlan {
  const seen = new Set<string>();
  for (const { itemKey } of reread) {
    if (seen.has(itemKey)) throw new JournalDuplicateItemError(itemKey);
    seen.add(itemKey);
  }
  const position = new Map(index.map(({ itemKey }, at) => [itemKey, at] as const));
  const prepend: string[] = [];
  const append: string[] = [];
  const correct: string[] = [];
  const abandon: string[] = [];
  let walkFrom = 0;
  let next = 0;
  if (reread.length > 0 && index.length > 0 && !position.has((reread[0] as ReconcileCandidate).itemKey)) {
    const firstKnown = reread.findIndex(({ itemKey }) => position.has(itemKey));
    if (firstKnown < 0) return { kind: 'gap' };
    const firstJournalItem = index.findIndex(({ liveOnly }) => !liveOnly);
    if (position.get((reread[firstKnown] as ReconcileCandidate).itemKey) !== firstJournalItem) return { kind: 'replace', reason: 'inserted' };
    for (const { itemKey } of reread.slice(0, firstKnown)) prepend.push(itemKey);
    walkFrom = firstKnown;
    next = firstJournalItem;
  } else if (reread.length > 0 && index.length > 0) {
    next = position.get((reread[0] as ReconcileCandidate).itemKey) as number;
  }
  const passOver = (from: number, to: number): ReconcilePlan | undefined => {
    for (let at = from; at < to; at += 1) {
      const passed = index[at] as JournalIndexEntry;
      if (passed.liveOnly) continue;
      if (passed.state === 'open') abandon.push(passed.itemKey);
      else if (passed.digest !== undefined) return { kind: 'replace', reason: 'missing' };
    }
    return undefined;
  };
  for (const candidate of reread.slice(walkFrom)) {
    const at = position.get(candidate.itemKey);
    if (at === undefined) {
      append.push(candidate.itemKey);
      continue;
    }
    if (append.length > 0) return { kind: 'replace', reason: 'inserted' };
    if (at < next) return { kind: 'replace', reason: 'reordered' };
    const broken = passOver(next, at);
    if (broken) return broken;
    const matched = index[at] as JournalIndexEntry;
    if (matched.state === 'open' || matched.digest !== candidate.digest) correct.push(candidate.itemKey);
    next = at + 1;
  }
  const broken = passOver(next, index.length);
  if (broken) return broken;
  return { kind: 'continue', prepend, append, correct, abandon };
}
