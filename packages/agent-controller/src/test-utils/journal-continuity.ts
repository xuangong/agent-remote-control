import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { SessionJournal, type JournalItemInput, type ReplacementReason, type SyncResult } from '@orchardworks/agent-remote-journal';

import { digestOf, groupItems, mergedRow, type TimelineItem } from '../publisher/journal-items.js';
import { attachScripted, boundary, item, ScriptedSession, untilReal as until } from './journal-scripted-session.js';
import { sequentialEpochs } from '@orchardworks/agent-remote-journal/testing';

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

/** The items as a Controller's window carries them: complete ones with their digest, open ones without. */
const windowOf = (items: readonly TimelineItem[]): Promise<JournalItemInput[]> =>
  Promise.all(items.map(async item => ({ row: mergedRow(item), ...(item.complete ? { digest: await digestOf(item) } : {}) })));

/** What the Relay's journal did with a window: left it, appended, or replaced itself for a reason. */
export type ContinuityOutcome = { outcome: 'unchanged' | 'appended' } | { outcome: 'replaced'; reason: ReplacementReason };

const outcomeOf = (result: SyncResult): ContinuityOutcome => result.outcome === 'replaced' ? { outcome: 'replaced', reason: result.reason } : { outcome: result.outcome };

/**
 * A Relay journal built from what a live run produced, which meets the windows a Controller would send when the session is
 * opened again and read again. Items the reread leaves open (a tool with no completion) are allowed: they are sent without a digest.
 */
export async function journalOfRun(live: readonly ProviderObservation[]) {
  const journal = SessionJournal.create('host-1:continuity', 'epoch-1', sequentialEpochs());
  const { generation } = journal.claim('controller-1');
  const roomBytes = Number.MAX_SAFE_INTEGER;
  let sequence = 0;
  const meet = async (items: readonly TimelineItem[]): Promise<ContinuityOutcome> => {
    sequence += 1;
    return outcomeOf(journal.sync({ publisherId: 'controller-1', generation, sequence }, await windowOf(items), { roomBytes }));
  };
  await meet(await itemsOf(live));
  return {
    /** The window of a reread of native history. */
    async reread(observations: readonly ProviderObservation[]): Promise<ContinuityOutcome> {
      return meet(await itemsOf(observations.map(observation => ({ ...observation, delivery: 'history' as const }))));
    },
    /** The window of the newest `count` items of a reread. */
    async newest(observations: readonly ProviderObservation[], count: number): Promise<ContinuityOutcome> {
      return meet((await itemsOf(observations.map(observation => ({ ...observation, delivery: 'history' as const })))).slice(-count));
    },
    keys: (): string[] => journal.state().items.map(({ itemKey }) => itemKey),
    openKeys: (): string[] => journal.state().items.filter(({ state }) => state === 'open').map(({ itemKey }) => itemKey),
    liveOnlyKeys: (): string[] => journal.state().items.filter(({ liveOnly }) => liveOnly).map(({ itemKey }) => itemKey),
    /** The status of every compaction item, in order. */
    compactionStatuses: (): string[] => journal.state().items.flatMap(({ body }) => body?.item.type === 'compaction' ? [body.item.status] : []),
  };
}

/** What the Relay's journal does with the reread of a session: a journal built from the live run meets the window the Controller would send. */
export async function continuityOutcome(run: ContinuityRun): Promise<ContinuityOutcome> {
  return (await journalOfRun(run.live)).reread(run.reread);
}
