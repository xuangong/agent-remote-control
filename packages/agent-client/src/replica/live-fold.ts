/** The stream-driven part of the replica: live rows, buffering while a page is awaited, and the epoch change of a replacement or a restore. */
import { mergeBackgroundActivity, mergeRowIntoEntry } from '@orchardworks/agent-remote-protocol';
import { reduceSessionState, } from '@orchardworks/agent-remote-protocol';
import type {
  AgentSnapshot,
  AgentStreamMessage,
  ProjectedTimelineEntry,
} from '@orchardworks/agent-remote-protocol';

import type {
  AgentReplicaState,
  TimelineReduction,
  TimelineStreamMessage,
} from './types.js';
import { clone, unique, sortEntries, mergeRanges, mergeResources, isTimelineMessage, sameContext } from './entry-algebra.js';
import { createReplicaState, applyBackgroundOutcome, applyBackgroundEntries } from './snapshot-apply.js';

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

export function applyNonTimelineEvent(state: AgentReplicaState, message: AgentStreamMessage): AgentReplicaState {
  const event = message.payload.event;
  if (event.type === 'timeline') return state;
  if (event.type === 'background_activity_updated') return applyBackgroundOutcome(state, event.background);
  if (!state.agent) return state;
  return { ...state, agent: reduceSessionState(state.agent, event, message.payload.timestamp) };
}

export function bufferLive(state: AgentReplicaState, message: TimelineStreamMessage): AgentReplicaState {
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

export function drainPending(state: AgentReplicaState): TimelineReduction {
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

export function appendLive(state: AgentReplicaState, message: TimelineStreamMessage): AgentReplicaState {
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

export function liveEntry(message: TimelineStreamMessage): ProjectedTimelineEntry {
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

export function coalesceEntry(
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

export function extendEntry(
  target: ProjectedTimelineEntry,
  incoming: ProjectedTimelineEntry,
  collapse?: ProjectedTimelineEntry['collapsed'][number],
): void {
  target.seqEnd = Math.max(target.seqEnd, incoming.seqEnd);
  target.sourceSeqRanges = mergeRanges([...target.sourceSeqRanges, ...incoming.sourceSeqRanges]);
  target.resources = mergeResources(target.resources, incoming.resources);
  if (collapse && !target.collapsed.includes(collapse)) target.collapsed.push(collapse);
}
