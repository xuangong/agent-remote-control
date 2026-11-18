import { mergeBackgroundActivity, mergeRowIntoEntry } from '@orchardworks/agent-remote-protocol';
import { reduceSessionState, withSessionInteractions } from '@orchardworks/agent-remote-protocol';
import type {
  BackgroundActivity,
  AgentInteractionRequest,
  AgentSnapshot,
  AgentStreamMessage,
  AgentUpdateMessage,
  HistoryPage,
  InteractionRequestedMessage,
  InteractionInvalidatedMessage,
  InteractionResolvedMessage,
  ProjectedTimelineEntry,
  ResourceResponse,
  ResourceUpdate,
  TimelineResourceBindingReplacement,
} from '@orchardworks/agent-remote-protocol';

import type {
  AgentReplicaState,
  SnapshotApplicationOptions,
  TimelineReduction,
  TimelineStreamMessage,
} from './types.js';
import { absorbWindow, updateInPlace } from './window-absorption.js';
import { timelineEntryKey } from './timeline-entry-key.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createReplicaState(): AgentReplicaState {
  return {
    agent: null,
    timeline: {
      epoch: null,
      initialized: false,
      entries: [],
      nextSeq: 1,
      hasOlder: false,
      pendingLive: [],
    },
    pendingInteractions: [],
    interactionRevision: 0,
    interactionChanges: {},
    resources: {},
    diagnostics: [],
    retiredEpochs: [],
  };
}

export function applyAgentSnapshot(
  state: AgentReplicaState,
  snapshot: AgentSnapshot | AgentUpdateMessage,
  options: SnapshotApplicationOptions = {},
): AgentReplicaState {
  if (snapshot.payload.attention?.background) state = applyBackgroundOutcome(state, snapshot.payload.attention.background);
  const baseline = options.interactionBaseline ?? state.interactionRevision;
  const snapshotRequests = new Map(
    snapshot.payload.pendingInteractions.map((request) => [request.requestId, clone(request)]),
  );
  for (const [requestId, change] of Object.entries(state.interactionChanges)) {
    if (change.revision <= baseline) continue;
    if (change.request) snapshotRequests.set(requestId, clone(change.request));
    else snapshotRequests.delete(requestId);
  }

  const interactionChanges = { ...state.interactionChanges };
  for (const request of snapshot.payload.pendingInteractions) {
    const current = interactionChanges[request.requestId];
    if (!current || current.revision <= baseline) {
      interactionChanges[request.requestId] = { revision: baseline, request: clone(request) };
    }
  }

  return {
    ...state,
    agent: withSessionInteractions(clone(snapshot.payload), [...snapshotRequests.values()]),
    pendingInteractions: [...snapshotRequests.values()],
    interactionChanges,
  };
}

export function applyInteractionRequested(
  state: AgentReplicaState,
  request: AgentInteractionRequest,
): AgentReplicaState {
  const revision = state.interactionRevision + 1;
  const requests = new Map(state.pendingInteractions.map((current) => [current.requestId, current]));
  requests.set(request.requestId, clone(request));
  return {
    ...state,
    agent: state.agent ? reduceSessionState(state.agent, { type: 'interaction_requested', request }, state.agent.updatedAt) : null,
    pendingInteractions: [...requests.values()],
    interactionRevision: revision,
    interactionChanges: {
      ...state.interactionChanges,
      [request.requestId]: { revision, request: clone(request) },
    },
  };
}

export function applyInteractionResolved(state: AgentReplicaState, requestId: string): AgentReplicaState {
  const revision = state.interactionRevision + 1;
  return {
    ...state,
    agent: state.agent ? reduceSessionState(state.agent, { type: 'interaction_resolved', requestId }, state.agent.updatedAt) : null,
    pendingInteractions: state.pendingInteractions.filter((request) => request.requestId !== requestId),
    interactionRevision: revision,
    interactionChanges: { ...state.interactionChanges, [requestId]: { revision } },
  };
}

export function applyInteractionInvalidated(state: AgentReplicaState, requestId: string): AgentReplicaState {
  return applyInteractionResolved(state, requestId);
}

export function applyResourceResponse(state: AgentReplicaState, response: ResourceResponse): AgentReplicaState {
  return {
    ...state,
    resources: {
      ...state.resources,
      [response.payload.resourceId]: clone(response.payload.state),
    },
  };
}

export function applyResourceUpdate(state: AgentReplicaState, update: ResourceUpdate): AgentReplicaState {
  const resourceId = update.payload.resourceId;
  const status = update.payload.state.status;
  const previous = state.resources[resourceId];
  const metadata = update.payload.state;
  const resource = metadata.status === 'available' && previous?.status === 'available'
    && previous.sha256 === metadata.sha256 && 'contentBase64' in previous
    ? { ...metadata, contentBase64: previous.contentBase64 } : metadata;
  return {
    ...state,
    resources: {
      ...state.resources,
      [resourceId]: clone(resource),
    },
    timeline: mapTimelineResources(state.timeline, (resources) => updateResourceStatus(resources, resourceId, status)),
  };
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

/**
 * Records that the timeline continues in another epoch, or that the held one must be read again (a gap or a stale cursor names the
 * epoch the replica holds): `pendingEpoch` may equal `epoch`, so one rule covers both. The held entries stay on screen: the tail of the new epoch is merged
 * into them by key when it is read (`absorbTail`). Before any content was read there is nothing to keep, so the replica
 * takes the epoch at once.
 */
export function applyTimelineReplacement(state: AgentReplicaState, epoch: string): AgentReplicaState {
  const timeline = state.timeline;
  if (timeline.pendingEpoch === epoch) return state;
  const retired = (...epochs: Array<string | null | undefined>) => unique([...state.retiredEpochs, ...epochs.filter((value): value is string => !!value && value !== epoch)]);
  if (!timeline.initialized) {
    return {
      ...state,
      retiredEpochs: retired(timeline.epoch, timeline.pendingEpoch),
      timeline: { ...timeline, epoch, entries: [], nextSeq: 1, hasOlder: false, pendingEpoch: undefined,
        pendingLive: timeline.pendingLive.filter((message) => message.payload.epoch === epoch) },
    };
  }
  return {
    ...state,
    retiredEpochs: retired(timeline.pendingEpoch),
    timeline: { ...timeline, pendingEpoch: epoch, pendingLive: timeline.pendingLive.filter((message) => message.payload.epoch === epoch) },
  };
}

/**
 * Seeds a replica that has read nothing with what this device last read of the session: its display Snapshot and the newest rows at the journal position they
 * ended. The connection's first page asks for what came after that position; a position the Relay does not hold becomes a replacement, merged by key.
 */
export function restoreFromDevice(state: AgentReplicaState, session: { snapshot: AgentSnapshot['payload']; epoch: string; nextSeq: number; hasOlder: boolean; entries: readonly ProjectedTimelineEntry[] }): AgentReplicaState {
  if (state.agent || state.timeline.initialized || state.timeline.epoch !== null) return state;
  return {
    ...state,
    agent: session.snapshot,
    timeline: { epoch: session.epoch, initialized: true, entries: session.entries, nextSeq: session.nextSeq, hasOlder: session.hasOlder, pendingLive: [], restoredFromDevice: true },
  };
}

/** The timeline starts over in `epoch`, with no row held and the old epoch retired: a recording's reset, as an observer saw it. */
export function resetTimeline(state: AgentReplicaState, epoch: string): AgentReplicaState {
  const retired = state.timeline.epoch && state.timeline.epoch !== epoch ? unique([...state.retiredEpochs, state.timeline.epoch]) : state.retiredEpochs;
  return { ...state, retiredEpochs: retired, timeline: { ...createReplicaState().timeline, epoch } };
}

export function applyInteractionRequestedMessage(
  state: AgentReplicaState,
  message: InteractionRequestedMessage,
): AgentReplicaState {
  return applyInteractionRequested(state, message.payload.request);
}

export function applyInteractionResolvedMessage(
  state: AgentReplicaState,
  message: InteractionResolvedMessage,
): AgentReplicaState {
  return applyInteractionResolved(state, message.payload.requestId);
}

export function applyInteractionInvalidatedMessage(
  state: AgentReplicaState,
  message: InteractionInvalidatedMessage,
): AgentReplicaState {
  return applyInteractionInvalidated(state, message.payload.requestId);
}

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
  const entries = mergePage(timeline.epoch, base, page, options?.preserveLive === true);
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
function absorbTail(state: AgentReplicaState, page: HistoryPage): TimelineReduction {
  const payload = page.payload;
  const timeline = state.timeline;
  const entries = absorbWindow(timeline.entries, timeline.epoch, payload.epoch, payload.entries);
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
function mergePage(epoch: string | null, held: readonly ProjectedTimelineEntry[], page: HistoryPage, preserveLive: boolean): ProjectedTimelineEntry[] {
  const incoming = page.payload.entries;
  const keyed = incoming.filter((entry) => entry.itemKey !== undefined);
  const unkeyed = incoming.filter((entry) => entry.itemKey === undefined);
  const position = new Map(held.map((entry, index) => [timelineEntryKey(epoch, entry), index]));
  const next = held.slice();
  const inserted: ProjectedTimelineEntry[] = [];
  const first = held[0]?.seqStart;
  for (const entry of keyed) {
    const index = position.get(timelineEntryKey(epoch, entry));
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

export function reduceTimelineEvent(state: AgentReplicaState, message: AgentStreamMessage): TimelineReduction {
  if (!isTimelineMessage(message)) {
    return { status: 'applied', state: applyNonTimelineEvent(state, message) };
  }
  const payload = message.payload;
  const epoch = payload.epoch;
  if (state.retiredEpochs.includes(epoch)) return { status: 'stale_epoch', state };
  const { pendingEpoch } = state.timeline;
  if (pendingEpoch !== undefined) {
    if (epoch === pendingEpoch) return { status: 'buffered', state: bufferLive(state, message) };
    // Frames of the epoch being replaced are ignored: the tail of the pending epoch replaces what they would change.
    if (epoch === state.timeline.epoch) return { status: 'duplicate', state };
  }
  if (state.timeline.epoch && state.timeline.epoch !== epoch || pendingEpoch !== undefined) {
    return { status: 'replaced', state: bufferLive(applyTimelineReplacement(state, epoch), message), epoch };
  }
  if (!state.timeline.initialized) {
    const withEpoch = state.timeline.epoch === null
      ? { ...state, timeline: { ...state.timeline, epoch } }
      : state;
    return { status: 'buffered', state: bufferLive(withEpoch, message) };
  }
  if (payload.seq < state.timeline.nextSeq) return { status: 'duplicate', state };
  if (payload.seq > state.timeline.nextSeq) {
    return {
      status: 'gap',
      state: bufferLive(state, message),
      expectedSeq: state.timeline.nextSeq,
    };
  }
  return {
    status: 'applied',
    state: appendLive(state, message),
  };
}

function applyNonTimelineEvent(state: AgentReplicaState, message: AgentStreamMessage): AgentReplicaState {
  const event = message.payload.event;
  if (event.type === 'timeline') return state;
  if (event.type === 'background_activity_updated') return applyBackgroundOutcome(state, event.background);
  if (!state.agent) return state;
  return { ...state, agent: reduceSessionState(state.agent, event, message.payload.timestamp) };
}


/** Preserve explicit outcomes across later ordinary turns and delayed history pages. */
function applyBackgroundOutcome(state: AgentReplicaState, background: BackgroundActivity): AgentReplicaState {
  const previous = state.timeline.backgroundActivities?.[background.id];
  const merged = mergeBackgroundActivity(previous, background);
  if (previous?.status === merged.status && previous?.summary === merged.summary) return state;
  const outcomes = { ...state.timeline.backgroundActivities, [background.id]: merged };
  const ids = Object.keys(outcomes);
  if (ids.length > 2048) delete outcomes[ids[0]!];
  return { ...state, timeline: { ...state.timeline, backgroundActivities: outcomes,
    entries: applyBackgroundEntries(state.timeline.entries, outcomes) } };
}

function applyBackgroundEntries(entries: readonly ProjectedTimelineEntry[], outcomes: AgentReplicaState['timeline']['backgroundActivities']): readonly ProjectedTimelineEntry[] {
  if (!outcomes) return entries;
  return entries.map(entry => {
    const background = entry.item.background;
    const outcome = background && outcomes[background.id];
    if (!background || !outcome) return entry;
    const merged = mergeBackgroundActivity(background, outcome);
    return merged === background ? entry : { ...entry, item: { ...entry.item, background: clone(merged) } };
  });
}

function bufferLive(state: AgentReplicaState, message: TimelineStreamMessage): AgentReplicaState {
  if (state.timeline.pendingLive.some((current) => (
    'seq' in current.payload && current.payload.seq === message.payload.seq
    && 'epoch' in current.payload && current.payload.epoch === message.payload.epoch
  ))) return state;
  return {
    ...state,
    timeline: {
      ...state.timeline,
      pendingLive: [...state.timeline.pendingLive, clone(message)],
    },
  };
}

function drainPending(state: AgentReplicaState): TimelineReduction {
  let current = state;
  let applied = false;
  while (true) {
    const pending = current.timeline.pendingLive;
    const candidate = pending.find((message) => message.payload.seq === current.timeline.nextSeq);
    if (!candidate) break;
    current = appendLive(current, candidate);
    applied = true;
  }
  const pendingLive = current.timeline.pendingLive.filter((message) => message.payload.seq >= current.timeline.nextSeq);
  if (pendingLive.length !== current.timeline.pendingLive.length) {
    current = { ...current, timeline: { ...current.timeline, pendingLive } };
  }
  const nextPending = pendingLive[0];
  if (nextPending && nextPending.payload.seq > current.timeline.nextSeq) {
    return { status: 'gap', state: current, expectedSeq: current.timeline.nextSeq };
  }
  return { status: applied || state.timeline.initialized ? 'applied' : 'buffered', state: current };
}

function appendLive(state: AgentReplicaState, message: TimelineStreamMessage): AgentReplicaState {
  const payload = message.payload;
  const projected = applyBackgroundEntries([liveEntry(message)], state.timeline.backgroundActivities)[0]!;
  return {
    ...state,
    timeline: {
      ...state.timeline,
      entries: coalesceEntry(state.timeline.entries, projected, state.timeline.hasOlder),
      nextSeq: payload.seq + 1,
      pendingLive: state.timeline.pendingLive.filter((current) => current.payload.seq !== payload.seq),
    },
  };
}

function liveEntry(message: TimelineStreamMessage): ProjectedTimelineEntry {
  const payload = message.payload;
  return {
    providerId: payload.event.providerId,
    ...(payload.event.itemKey === undefined ? {} : { itemKey: payload.event.itemKey }),
    item: clone(payload.event.item),
    ...(payload.event.turnId === undefined ? {} : { turnId: payload.event.turnId }),
    timestamp: payload.timestamp,
    seqStart: payload.event.itemSeqStart ?? payload.seq,
    seqEnd: payload.seq,
    sourceSeqRanges: [{ startSeq: payload.seq, endSeq: payload.seq }],
    collapsed: [],
    resources: clone(payload.event.resources),
  };
}

function coalesceEntry(
  entries: readonly ProjectedTimelineEntry[],
  incoming: ProjectedTimelineEntry,
  hasOlder = false,
): ProjectedTimelineEntry[] {
  if (incoming.itemKey !== undefined) {
    // A keyed row continues the one row that holds its key, in place, through the fold the journal and the pages use.
    const index = entries.map((entry) => entry.itemKey).lastIndexOf(incoming.itemKey);
    if (index < 0) {
      // An item updated above the window keeps its first sequence: it is older history, which the next older page brings in its place.
      const first = entries[0];
      if (hasOlder && first && incoming.seqStart < first.seqStart) return entries.slice();
      return sortEntries([...entries, incoming]);
    }
    const held = entries[index]!;
    // The fold changes the item, its collapse marks, its sequence ranges and its resources, and nothing else.
    const merged: ProjectedTimelineEntry = { ...held, item: { ...held.item }, collapsed: [...held.collapsed],
      sourceSeqRanges: held.sourceSeqRanges.map((range) => ({ ...range })), resources: [...held.resources] };
    mergeRowIntoEntry(merged, { seq: incoming.seqEnd, item: incoming.item, resources: incoming.resources });
    return entries.map((entry, at) => at === index ? merged : entry);
  }
  const next = entries.slice();
  const incomingItem = incoming.item;
  if (incomingItem.type === 'assistant_message') {
    const previous = next.at(-1);
    if (
      previous?.item.type === 'assistant_message'
      && sameContext(previous, incoming)
      && previous.item.messageId === incomingItem.messageId
    ) {
      const updated = { ...previous, item: { ...previous.item, text: previous.item.text + incomingItem.text, ...(incomingItem.background ? { background: mergeBackgroundActivity(previous.item.background, incomingItem.background) } : {}) }, collapsed: [...previous.collapsed] };
      extendEntry(updated, incoming, 'assistant_merge');
      next[next.length - 1] = updated;
      return next;
    }
  } else if (incomingItem.type === 'reasoning') {
    const previous = next.at(-1);
    if (previous?.item.type === 'reasoning' && sameContext(previous, incoming)) {
      const updated = { ...previous, item: { ...previous.item, text: previous.item.text + incomingItem.text, ...(incomingItem.background ? { background: mergeBackgroundActivity(previous.item.background, incomingItem.background) } : {}) }, collapsed: [...previous.collapsed] };
      extendEntry(updated, incoming, 'reasoning_merge');
      next[next.length - 1] = updated;
      return next;
    }
  } else if (incomingItem.type === 'tool_call') {
    const existing = next.find((entry) => (
      entry.providerId === incoming.providerId
      && entry.item.type === 'tool_call'
      && entry.item.callId === incomingItem.callId
    ));
    if (existing) {
      const updated = { ...existing, item: { ...incomingItem, ...(incomingItem.background ? { background: mergeBackgroundActivity(existing.item.background, incomingItem.background) } : {}) }, collapsed: [...existing.collapsed] };
      extendEntry(updated, incoming, 'tool_lifecycle');
      next[next.indexOf(existing)] = updated;
      return sortEntries(next);
    }
  } else if (incomingItem.type === 'compaction' && incomingItem.status !== 'loading') {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const candidate = next[index];
      if (candidate?.item.type !== 'compaction' || !sameContext(candidate, incoming)) continue;
      if (candidate.item.status !== 'loading') break;
      const updated = { ...candidate, item: { ...candidate.item, ...incomingItem }, collapsed: [...candidate.collapsed] };
      extendEntry(updated, incoming);
      next[index] = updated;
      return sortEntries(next);
    }
  } else if (incomingItem.type === 'todo') {
    let existing: ProjectedTimelineEntry | undefined;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const candidate = next[index];
      if (candidate?.item.type === 'todo' && sameContext(candidate, incoming)) {
        existing = candidate;
        break;
      }
    }
    if (existing) {
      const updated = { ...existing, item: { ...incomingItem, ...(incomingItem.background ? { background: mergeBackgroundActivity(existing.item.background, incomingItem.background) } : {}) }, collapsed: [...existing.collapsed] };
      extendEntry(updated, incoming);
      next[next.indexOf(existing)] = updated;
      return sortEntries(next);
    }
  }
  next.push(incoming);
  return sortEntries(next);
}

function extendEntry(
  target: ProjectedTimelineEntry,
  incoming: ProjectedTimelineEntry,
  collapse?: ProjectedTimelineEntry['collapsed'][number],
): void {
  target.seqEnd = Math.max(target.seqEnd, incoming.seqEnd);
  target.sourceSeqRanges = mergeRanges([...target.sourceSeqRanges, ...incoming.sourceSeqRanges]);
  target.resources = mergeResources(target.resources, incoming.resources);
  if (collapse && !target.collapsed.includes(collapse)) target.collapsed.push(collapse);
}

function sameContext(left: ProjectedTimelineEntry, right: ProjectedTimelineEntry): boolean {
  return left.providerId === right.providerId && left.turnId === right.turnId && left.item.background?.id === right.item.background?.id;
}

function mergeAuthoritative(
  existing: readonly ProjectedTimelineEntry[],
  authoritative: readonly ProjectedTimelineEntry[],
): ProjectedTimelineEntry[] {
  const replaced = existing.filter((entry) => (
    !authoritative.some((candidate) => rangesOverlap(entry.sourceSeqRanges, candidate.sourceSeqRanges))
  ));
  return sortEntries([...replaced, ...authoritative.map(clone)]);
}

function rangesOverlap(
  left: ProjectedTimelineEntry['sourceSeqRanges'],
  right: ProjectedTimelineEntry['sourceSeqRanges'],
): boolean {
  return left.some((a) => right.some((b) => a.startSeq <= b.endSeq && b.startSeq <= a.endSeq));
}

function mergeRanges(ranges: ProjectedTimelineEntry['sourceSeqRanges']): ProjectedTimelineEntry['sourceSeqRanges'] {
  const sorted = ranges.map(clone).sort((left, right) => left.startSeq - right.startSeq);
  const merged: ProjectedTimelineEntry['sourceSeqRanges'] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startSeq <= previous.endSeq + 1) previous.endSeq = Math.max(previous.endSeq, range.endSeq);
    else merged.push(range);
  }
  return merged;
}

function mergeResources(
  existing: ProjectedTimelineEntry['resources'],
  incoming: ProjectedTimelineEntry['resources'],
): ProjectedTimelineEntry['resources'] {
  const resources = new Map(existing.map((resource) => [resource.resourceId, clone(resource)]));
  for (const resource of incoming) resources.set(resource.resourceId, clone(resource));
  return [...resources.values()];
}

function mapTimelineResources(
  timeline: AgentReplicaState['timeline'],
  mapResources: (resources: ProjectedTimelineEntry['resources']) => ProjectedTimelineEntry['resources'],
): AgentReplicaState['timeline'] {
  const entries = timeline.entries.map((entry) => {
    const resources = mapResources(entry.resources);
    return resources === entry.resources ? entry : { ...entry, resources };
  });
  const pendingLive = timeline.pendingLive.map((pending) => {
    const resources = mapResources(pending.payload.event.resources);
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
    entries.every((entry, index) => entry === timeline.entries[index])
    && pendingLive.every((pending, index) => pending === timeline.pendingLive[index])
  ) return timeline;
  return { ...timeline, entries, pendingLive };
}

function updateResourceStatus(
  resources: ProjectedTimelineEntry['resources'],
  resourceId: string,
  status: ProjectedTimelineEntry['resources'][number]['status'],
): ProjectedTimelineEntry['resources'] {
  let changed = false;
  const updated = resources.map((resource) => {
    if (resource.resourceId !== resourceId || resource.status === status) return resource;
    changed = true;
    return { ...resource, status };
  });
  return changed ? updated : resources;
}

function replaceResourceBinding(
  resources: ProjectedTimelineEntry['resources'],
  previous: ProjectedTimelineEntry['resources'][number],
  replacement: ProjectedTimelineEntry['resources'][number],
): ProjectedTimelineEntry['resources'] {
  let changed = false;
  const updated = resources.map((resource) => {
    if (resource.locator !== previous.locator || resource.resourceId !== previous.resourceId) return resource;
    changed = true;
    return clone(replacement);
  });
  return changed ? updated : resources;
}

function sortEntries(entries: ProjectedTimelineEntry[]): ProjectedTimelineEntry[] {
  return entries.sort((left, right) => left.seqStart - right.seqStart || left.seqEnd - right.seqEnd);
}

function nextSequenceForPage(state: AgentReplicaState, page: HistoryPage): number {
  if (page.payload.direction === 'before') return state.timeline.nextSeq;
  if (page.payload.hasNewer && page.payload.endCursor) return page.payload.endCursor.seq + 1;
  return page.payload.window.nextSeq;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isTimelineMessage(message: AgentStreamMessage): message is TimelineStreamMessage {
  return message.payload.event.type === 'timeline';
}
