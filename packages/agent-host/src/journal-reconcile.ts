import { planReconcile } from '@orchardworks/agent-remote-journal';
import type { JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import { mergeBackgroundActivity, type BackgroundActivity } from '@orchardworks/agent-remote-protocol';

import { blocksOf, entryBytes, mergedRow, newestItems, sizedItems, type PublishOp, type SizedOp, type TimelineItem } from './journal-items.js';

/** The digest an item that is still open has in a comparison: it equals no real digest, so a known open item is always corrected. */
const OPEN_DIGEST = 'open';

export type ReplaceReason = 'missing' | 'reordered' | 'inserted' | 'initial' | 'gap' | 'quota';

export type PublicationPlan =
  /**
   * The epoch continues. `ops` are corrections, new items, seals and background outcomes, in the order to publish them;
   * `older` is older history, newest block first, which is published after the head so a long history never delays it.
   * `refused` names the items the wire does not accept; they are left out of the plan and of the comparison.
   */
  | { kind: 'continue'; ops: SizedOp[]; older: SizedOp[]; refused: string[] }
  /** The newest items as a new epoch, with the outcomes of their backgrounds. Older items follow as older history once the journal is opened again. */
  | { kind: 'replace'; reason: ReplaceReason; ops: SizedOp[]; refused: string[] }
  /** None of the reread is in the journal: older history must be read before a decision. */
  | { kind: 'gap'; refused: string[] };

export interface PlanOptions {
  /** Compare only the newest `window` items of the reread. A quota refusal narrows it. */
  window?: number;
  /** Replace without comparing, as a quota refusal asks. */
  forceReplace?: boolean;
}

type Digest = (item: TimelineItem) => Promise<string>;

/** Takes each item's digest once, however many comparisons ask for it. */
function memoized(digest: Digest): Digest {
  const known = new Map<TimelineItem, Promise<string>>();
  return item => {
    let value = known.get(item);
    if (!value) {
      value = digest(item);
      known.set(item, value);
    }
    return value;
  };
}

/**
 * One outcome entry for each background of the items, with the strongest status their rows carry. A journal built from a
 * reread has the backgrounds of its rows but not the outcomes the Controller learned about later, so each reconcile
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

/** A replacement from the newest items that fit one message. With nothing to replace with, which would wipe the journal, nothing is published. */
export async function replacementPlan(timeline: readonly TimelineItem[], digest: Digest, reason: ReplaceReason): Promise<PublicationPlan> {
  const { block, keys, refused } = await newestItems(timeline, digest);
  const op: PublishOp = { op: 'replace', items: block };
  const bytes = block.length === 0 ? undefined : entryBytes(op);
  if (bytes === undefined) return { kind: 'continue', ops: [], older: [], refused };
  const included = new Set(keys);
  return { kind: 'replace', reason, ops: [{ op, bytes }, ...outcomeOps(timeline.filter(item => included.has(item.key)))], refused };
}

/**
 * Compares the Controller's timeline, read again, with the item index the Relay holds and says what to publish. The
 * epoch continues unless native history was genuinely rewritten: unknown items are appended, a known item that is open or
 * whose digest differs is corrected, leading items the journal never saw are older history, and an open item that history
 * no longer holds is sealed. `index` is in journal order; `timeline` is oldest first. Items the wire refuses are taken out
 * of the comparison first and named in `refused`, so that one cannot make every reconcile look like a rewrite.
 */
export async function planPublication(
  index: readonly JournalIndexEntry[], timeline: readonly TimelineItem[], digest: Digest, options: PlanOptions = {},
): Promise<PublicationPlan> {
  const takeDigest = memoized(digest);
  const windowed = options.window === undefined ? [...timeline] : timeline.slice(-options.window);
  const { refused } = await sizedItems(windowed, takeDigest);
  const refusedKeys = new Set(refused);
  const items = windowed.filter(item => !refusedKeys.has(item.key));
  const named = (plan: PublicationPlan): PublicationPlan => ({ ...plan, refused: [...new Set([...refused, ...plan.refused])] }) as PublicationPlan;

  // An empty reread says nothing about the journal; it is never a replacement.
  if (items.length === 0) return named({ kind: 'continue', ops: [], older: [], refused: [] });
  if (options.forceReplace) return named(await replacementPlan(items, takeDigest, 'quota'));
  if (index.length === 0) {
    return named(await replacementPlan(items, takeDigest, 'initial'));
  }
  // The core carries live-only items through a replacement and passes over them when it compares, so their place in the
  // order is not evidence of anything. They are compared by key instead.
  const held = new Map(index.filter(entry => entry.liveOnly).map(entry => [entry.itemKey, entry]));
  const candidates = [];
  for (const item of items) if (!held.has(item.key)) candidates.push({ itemKey: item.key, digest: item.complete ? await takeDigest(item) : OPEN_DIGEST });
  const plan = candidates.length === 0 ? { kind: 'continue' as const, prepend: [], append: [], correct: [], abandon: [] } : planReconcile(index, candidates);
  if (plan.kind === 'gap') return { kind: 'gap', refused };
  if (plan.kind === 'replace') return named(await replacementPlan(items, takeDigest, plan.reason));

  const byKey = new Map(items.map(item => [item.key, item]));
  const revisions = new Map(index.map(entry => [entry.itemKey, entry.revision]));
  const ops: SizedOp[] = [];
  const older: SizedOp[] = [];
  const add = (op: PublishOp): boolean => {
    const bytes = entryBytes(op);
    if (bytes === undefined) return false;
    ops.push({ op, bytes });
    return true;
  };

  // Older history lands below the oldest item, so the block next to it goes first.
  const prepended = await sizedItems(plan.prepend.map(key => byKey.get(key) as TimelineItem), takeDigest);
  const sizeOf = new Map(prepended.accepted.map(sized => [sized.item.row.itemKey, sized.bytes]));
  for (const block of blocksOf(prepended.accepted).reverse()) {
    older.push({ op: { op: 'prepend', items: block }, bytes: block.reduce((sum, { row }) => sum + (sizeOf.get(row.itemKey) ?? 0), 0) });
  }
  const unaccepted = [...prepended.refused];
  for (const item of items) {
    const entry = held.get(item.key);
    if (!entry) continue;
    const current = entry.state === 'complete' && item.complete && entry.digest === await takeDigest(item) && entry.liveOnly === item.liveOnly;
    if (current) continue;
    if (!add({ op: 'correct', row: mergedRow(item), ...(item.complete ? { digest: await takeDigest(item) } : {}), expectedRevision: entry.revision })) unaccepted.push(item.key);
  }
  for (const key of plan.correct) {
    const item = byKey.get(key) as TimelineItem;
    if (!add({ op: 'correct', row: mergedRow(item), ...(item.complete ? { digest: await takeDigest(item) } : {}), expectedRevision: revisions.get(key) as number })) unaccepted.push(key);
  }
  for (const key of plan.append) {
    const item = byKey.get(key) as TimelineItem;
    if (!add({ op: 'append', row: mergedRow(item) })) unaccepted.push(key);
    else if (item.complete && !add({ op: 'complete', itemKey: key, digest: await takeDigest(item) })) unaccepted.push(key);
  }
  for (const key of plan.abandon) if (!add({ op: 'seal', itemKey: key })) unaccepted.push(key);
  ops.push(...outcomeOps(items));
  return named({ kind: 'continue', ops, older, refused: unaccepted });
}
