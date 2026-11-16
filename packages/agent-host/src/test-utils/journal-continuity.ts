import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { itemDigest, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import { expect } from 'vitest';

import { groupItems, mergedRow, type TimelineItem } from '../journal-items.js';
import { planPublication, type PublicationPlan } from '../journal-reconcile.js';
import { attachScripted, boundary, item, ScriptedSession, untilReal as until } from './journal-scripted-session.js';

/** What one native session produced: everything it emitted while it ran, and what the adapter returns after it is reopened. */
export interface ContinuityRun {
  /** History at open, then live observations, in order; each says which it is in `delivery`. */
  live: readonly ProviderObservation[];
  /** The history observations of the same native session opened again. A provider that reads only the latest page returns only the newest items. */
  reread: readonly ProviderObservation[];
}

const SENTINEL = 'continuity:sentinel';

/**
 * The items a journal would hold for these observations: they go through a real agent manager, history before its boundary
 * and live observations after it, so the rows are the ones the Controller keeps, including the interaction items the
 * manager builds from `interaction_resolved`. Every row must carry an item identity, and no key may use the prefix the Controller reserves for its own items.
 */
export async function itemsOf(observations: readonly ProviderObservation[]): Promise<TimelineItem[]> {
  const session = new ScriptedSession('continuity', 'continuity', [...observations.filter(observation => observation.delivery === 'history'), boundary()]);
  const manager = await attachScripted(session, 'continuity');
  let breached = false;
  const subscription = manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { breached = true; } });
  try {
    for (const observation of observations.filter(observation => observation.delivery === 'live')) session.push(observation);
    // Live observations are applied in order after this call returns; the last one says when they all were.
    session.push(item('live', SENTINEL, ''));
    await until(() => manager.timelineRows().some(row => row.identity?.key === SENTINEL), 'the observations to reach the timeline');
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    const rows = manager.timelineRows().filter(row => row.identity?.key !== SENTINEL);
    const bare = rows.filter(row => row.identity === undefined);
    if (bare.length > 0) {
      throw new Error(`${bare.length} timeline row(s) carry no item identity, for example the one from ${bare[0]!.sourceKey}; a journal-capable adapter gives every observation that becomes a row one, including the interaction_resolved observations the manager turns into interaction items.`);
    }
    if (breached) {
      throw new Error('An observation broke the item identity contract: its key is empty, longer than 4096 characters or starts with the reserved "controller:" prefix, or a timeline or interaction_resolved observation lacks an identity.');
    }
    return groupItems(rows);
  } finally {
    subscription.release();
    await manager.close();
  }
}

const digest = (timelineItem: TimelineItem): Promise<string> => itemDigest(mergedRow(timelineItem).item);

/** The index a journal would hold after publishing the live run: every item, complete ones with their digest. */
async function journalOf(items: readonly TimelineItem[]): Promise<JournalIndexEntry[]> {
  const index: JournalIndexEntry[] = [];
  for (const [at, timelineItem] of items.entries()) {
    index.push({
      itemKey: timelineItem.key, seqStart: at + 1, seqEnd: at + 1, state: timelineItem.complete ? 'complete' : 'open', ...(timelineItem.complete ? { digest: await digest(timelineItem) } : {}),
      liveOnly: timelineItem.liveOnly, revision: at + 1, resident: true,
    });
  }
  return index;
}

/** What the Controller would publish to the journal of the live run, when the session is reopened and read again. */
export async function continuityPlan(run: ContinuityRun): Promise<PublicationPlan> {
  const live = await itemsOf(run.live);
  const reread = await itemsOf(run.reread.map(observation => ({ ...observation, delivery: 'history' as const })));
  const open = reread.filter(entry => !entry.complete).map(entry => entry.key);
  if (open.length > 0) throw new Error(`History must complete every item it returns; these are not complete: ${open.join(', ')}.`);
  return planPublication(await journalOf(live), reread, digest);
}

/** Describes a plan that is not empty, naming the operations it would publish. */
const describePlan = (plan: PublicationPlan): string => plan.kind === 'gap' ? 'a gap'
  : `${plan.kind}${plan.kind === 'replace' ? ` (${plan.reason})` : ''}: ${[...plan.ops, ...(plan.kind === 'continue' ? plan.older : [])].map(({ op }) => op.op).join(', ') || 'nothing'}`;

/**
 * Proves continuity: the items of the reread have the keys and the content of the items the live run built, so
 * reconciling publishes no row, and the epoch continues. Fails with the operations it would have published.
 * Every reconcile restates the outcome of each background it holds, which changes nothing in a journal that has it, so
 * outcome entries do not count against continuity.
 */
export async function expectContinuity(run: ContinuityRun): Promise<void> {
  const plan = await continuityPlan(run);
  const publishes = plan.kind !== 'continue' || plan.ops.some(({ op }) => op.op !== 'outcome') || plan.older.length > 0 || plan.refused.length > 0;
  expect(publishes, `Reconciling would publish ${describePlan(plan)}.`).toBe(false);
}
