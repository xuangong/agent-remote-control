/** Folding a history page into the held timeline: a tail absorbs by item key, earlier and later pages merge by sequence. */
import type {
  HistoryPage,
  ProjectedTimelineEntry,
  TimelineResourceBindingReplacement,
} from '@orchardworks/agent-remote-protocol';

import type {
  AgentReplicaState,
  TimelineReduction,
} from './types.js';
import { absorbWindow, updateInPlace } from './window-absorption.js';
import { timelineEntryKey } from './timeline-entry-key.js';
import { clone, unique, sortEntries, rangesOverlap } from './entry-algebra.js';
import { replaceResourceBinding, applyBackgroundEntries } from './snapshot-apply.js';
import { applyTimelineReplacement, drainPending } from './live-fold.js';

export function applyHistoryPage(state: AgentReplicaState, page: HistoryPage, options?: { preserveLive?: boolean }): TimelineReduction {
  const payload = page.payload;
  const timeline = state.timeline;
  if (payload.reset || payload.staleCursor || payload.gap) {
    if (state.retiredEpochs.includes(payload.epoch)) return { status: 'stale_epoch', state };
    return { status: 'replaced', state: applyTimelineReplacement(state, payload.epoch), epoch: payload.epoch };
  }
  const epochChanged = timeline.epoch !== null && timeline.epoch !== payload.epoch;
  if (epochChanged && state.retiredEpochs.includes(payload.epoch)) return { status: 'stale_epoch', state };
  if (timeline.pendingEpoch !== undefined) {
    // While a replacement is pending only the tail of its epoch applies. A page of another epoch retargets it; the rest waits for the tail.
    if (payload.direction === 'tail' && payload.epoch === timeline.pendingEpoch) return absorbTail(state, page);
    if (payload.epoch !== timeline.pendingEpoch && payload.epoch !== timeline.epoch) return { status: 'replaced', state: applyTimelineReplacement(state, payload.epoch), epoch: payload.epoch };
    return { status: 'duplicate', state };
  }
  if (payload.direction === 'tail') return absorbTail(state, page);
  if (epochChanged) return { status: 'replaced', state: applyTimelineReplacement(state, payload.epoch), epoch: payload.epoch };

  const base = timeline.initialized ? timeline.entries : [];
  const entries = mergePage(base, page, options?.preserveLive === true);
  const nextSeq = options?.preserveLive
    ? Math.max(timeline.nextSeq, nextSequenceForPage(state, page))
    : nextSequenceForPage(state, page);
  // A page that reads forward from the held position confirms rows restored from the device; one that reads older rows says nothing about them.
  const { restoredFromDevice: _restored, ...confirmed } = timeline;
  const prepared: AgentReplicaState = {
    ...state,
    timeline: {
      ...(payload.direction === 'before' ? timeline : confirmed),
      epoch: payload.epoch,
      initialized: true,
      entries: applyBackgroundEntries(entries, timeline.backgroundActivities),
      nextSeq,
      hasOlder: payload.direction === 'before' ? payload.hasOlder : payload.hasOlder || timeline.hasOlder,
      pendingLive: timeline.pendingLive
        .filter((message) => message.payload.epoch === payload.epoch)
        .sort((left, right) => left.payload.seq - right.payload.seq),
    },
  };
  return drainPending(prepared);
}

/**
 * The tail of an epoch is the newest window of its timeline. It replaces what the replica holds without an empty state in
 * between: a held row whose key and content are in the window stays as it is (only its sequence changes), a row the window lacks
 * leaves (including rows older than the window, which `loadOlder` reads again), and a new row is inserted in the window's order.
 * The old epoch retires here, and the frames buffered for the new epoch are applied after the item window.
 */
export function absorbTail(state: AgentReplicaState, page: HistoryPage): TimelineReduction {
  const payload = page.payload;
  const timeline = state.timeline;
  const entries = absorbWindow(timeline.entries, payload.entries);
  const retiredEpochs = unique([...state.retiredEpochs, ...[timeline.epoch, timeline.pendingEpoch].filter((epoch): epoch is string => !!epoch && epoch !== payload.epoch)]);
  const prepared: AgentReplicaState = {
    ...state,
    retiredEpochs,
    timeline: {
      epoch: payload.epoch,
      backgroundActivities: timeline.backgroundActivities,
      initialized: true,
      entries: applyBackgroundEntries(entries, timeline.backgroundActivities),
      nextSeq: nextSequenceForPage(state, page),
      hasOlder: payload.hasOlder,
      pendingLive: timeline.pendingLive
        .filter((message) => message.payload.epoch === payload.epoch)
        .sort((left, right) => left.payload.seq - right.payload.seq),
    },
  };
  return drainPending(prepared);
}

/**
 * A page of the epoch the replica holds, other than its tail. Keyed entries are one row per key: an `after` page updates a held row in
 * place and inserts the others; a `before` page drops every key already held, so an item updated above the window cannot appear twice.
 * Entries without keys keep the older rule of replacing the rows whose source sequences they overlap.
 */
export function mergePage(held: readonly ProjectedTimelineEntry[], page: HistoryPage, preserveLive: boolean): ProjectedTimelineEntry[] {
  const incoming = page.payload.entries;
  const keyed = incoming.filter((entry) => entry.itemKey !== undefined);
  const unkeyed = incoming.filter((entry) => entry.itemKey === undefined);
  const position = new Map(held.map((entry, index) => [timelineEntryKey(entry), index]));
  const next = held.slice();
  const inserted: ProjectedTimelineEntry[] = [];
  const first = held[0]?.seqStart;
  for (const entry of keyed) {
    const index = position.get(timelineEntryKey(entry));
    if (index === undefined) {
      // A row above the first held row is older history that a `before` page brings, in its place; adding it here would hide
      // the rows between (the journal keeps an updated item's first sequence).
      if (page.payload.direction === 'after' && held.length > 0 && entry.seqStart < (first as number)) continue;
      inserted.push(clone(entry));
      continue;
    }
    if (page.payload.direction === 'before') continue;
    const current = next[index]!;
    if (preserveLive && current.seqEnd > entry.seqEnd) continue;
    next[index] = updateInPlace(current, entry);
  }
  const accepted = preserveLive ? unkeyed.filter((candidate) => !held.some((existing) =>
    existing.seqEnd > candidate.seqEnd && rangesOverlap(existing.sourceSeqRanges, candidate.sourceSeqRanges))) : unkeyed;
  return sortEntries([...(accepted.length ? mergeAuthoritative(next, accepted) : next), ...inserted]);
}

export function mergeAuthoritative(
  existing: readonly ProjectedTimelineEntry[],
  authoritative: readonly ProjectedTimelineEntry[],
): ProjectedTimelineEntry[] {
  const replaced = existing.filter((entry) => (
    !authoritative.some((candidate) => rangesOverlap(entry.sourceSeqRanges, candidate.sourceSeqRanges))
  ));
  return sortEntries([...replaced, ...authoritative.map(clone)]);
}

export function nextSequenceForPage(state: AgentReplicaState, page: HistoryPage): number {
  if (page.payload.direction === 'before') return state.timeline.nextSeq;
  if (page.payload.hasNewer && page.payload.endCursor) return page.payload.endCursor.seq + 1;
  return page.payload.window.nextSeq;
}

export function applyTimelineResourceBindingReplacement(
  state: AgentReplicaState,
  message: TimelineResourceBindingReplacement,
): AgentReplicaState {
  const { epoch, seq, previous, replacement } = message.payload;
  if (state.timeline.epoch !== epoch) return state;
  const entries = state.timeline.entries.map((entry) => {
    if (!entry.sourceSeqRanges.some((range) => range.startSeq <= seq && seq <= range.endSeq)) return entry;
    const resources = replaceResourceBinding(entry.resources, previous, replacement);
    return resources === entry.resources ? entry : { ...entry, resources };
  });
  const pendingLive = state.timeline.pendingLive.map((pending) => {
    if (pending.payload.epoch !== epoch || pending.payload.seq !== seq) return pending;
    const resources = replaceResourceBinding(pending.payload.event.resources, previous, replacement);
    if (resources === pending.payload.event.resources) return pending;
    return {
      ...pending,
      payload: {
        ...pending.payload,
        event: { ...pending.payload.event, resources },
      },
    };
  });
  if (
    entries.every((entry, index) => entry === state.timeline.entries[index])
    && pendingLive.every((pending, index) => pending === state.timeline.pendingLive[index])
  ) return state;
  return { ...state, timeline: { ...state.timeline, entries, pendingLive } };
}
