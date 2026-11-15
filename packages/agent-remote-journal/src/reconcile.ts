import type { JournalIndexEntry } from './types.js';

/** One item of a reread of native history, oldest first. */
export interface ReconcileCandidate {
  itemKey: string;
  digest: string;
}

export type ReconcilePlan =
  | { kind: 'continue'; append: string[]; correct: string[]; abandon: string[] }
  | { kind: 'replace'; reason: 'missing' | 'reordered' | 'inserted' }
  | { kind: 'gap' };

/**
 * Compares a reread of native history with the journal inside the reread's window. The reread's oldest item is the
 * anchor; journal items older than it are outside the window and stay. Live-only items have no native copy and take
 * no part. Open items the reread lacks were never kept natively and are abandoned rather than treated as a rewrite.
 */
export function planReconcile(index: readonly JournalIndexEntry[], reread: readonly ReconcileCandidate[]): ReconcilePlan {
  const known = index.filter(({ liveOnly }) => !liveOnly);
  const position = new Map(known.map(({ itemKey }, at) => [itemKey, at] as const));
  const append: string[] = [];
  const correct: string[] = [];
  const abandon: string[] = [];
  const first = reread[0];
  let next = 0;
  if (first !== undefined && known.length > 0) {
    const anchor = position.get(first.itemKey);
    if (anchor === undefined) {
      return reread.some(({ itemKey }) => position.has(itemKey)) ? { kind: 'replace', reason: 'inserted' } : { kind: 'gap' };
    }
    next = anchor;
  }
  for (const candidate of reread) {
    const at = position.get(candidate.itemKey);
    if (at === undefined) {
      append.push(candidate.itemKey);
      continue;
    }
    if (append.length > 0) return { kind: 'replace', reason: 'inserted' };
    if (at < next) return { kind: 'replace', reason: 'reordered' };
    for (let skipped = next; skipped < at; skipped += 1) {
      const passed = known[skipped] as JournalIndexEntry;
      if (passed.state !== 'open') return { kind: 'replace', reason: 'missing' };
      abandon.push(passed.itemKey);
    }
    const matched = known[at] as JournalIndexEntry;
    if (matched.state === 'open' || matched.digest !== candidate.digest) correct.push(candidate.itemKey);
    next = at + 1;
  }
  for (let rest = next; rest < known.length; rest += 1) {
    const remaining = known[rest] as JournalIndexEntry;
    if (remaining.state !== 'open') return { kind: 'replace', reason: 'missing' };
    abandon.push(remaining.itemKey);
  }
  return { kind: 'continue', append, correct, abandon };
}
