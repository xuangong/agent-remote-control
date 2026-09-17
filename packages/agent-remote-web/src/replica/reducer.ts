import type {
  AgentInteractionRequest,
  AgentSnapshot,
  AgentStreamMessage,
  AgentUpdateMessage,
  HistoryPage,
  InteractionRequestedMessage,
  InteractionResolvedMessage,
  ProjectedTimelineEntry,
  ResourceResponse,
  ResourceUpdate,
  TimelineResourceBindingReplacement,
} from '@agent-remote-controller/agent-remote-protocol';

import type {
  AgentReplicaState,
  SnapshotApplicationOptions,
  TimelineReduction,
  TimelineStreamMessage,
} from './types.js';

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
    agent: { ...clone(snapshot.payload), pendingInteractions: [...snapshotRequests.values()] },
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
    pendingInteractions: state.pendingInteractions.filter((request) => request.requestId !== requestId),
    interactionRevision: revision,
    interactionChanges: { ...state.interactionChanges, [requestId]: { revision } },
  };
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

export function applyTimelineReplacement(state: AgentReplicaState, epoch: string): AgentReplicaState {
  if (state.timeline.epoch === epoch && !state.timeline.initialized) return state;
  const retiredEpochs = state.timeline.epoch && state.timeline.epoch !== epoch
    ? unique([...state.retiredEpochs, state.timeline.epoch])
    : state.retiredEpochs;
  return {
    ...state,
    retiredEpochs,
    timeline: {
      epoch,
      initialized: false,
      entries: [],
      nextSeq: 1,
      hasOlder: false,
      pendingLive: [],
    },
  };
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

export function applyHistoryPage(state: AgentReplicaState, page: HistoryPage): TimelineReduction {
  const payload = page.payload;
  if (payload.reset || payload.staleCursor || payload.gap) {
    const reset = applyTimelineReplacement(state, payload.epoch);
    return { status: 'reset_required', state: reset, epoch: payload.epoch };
  }
  if (state.timeline.epoch && state.timeline.epoch !== payload.epoch) {
    if (state.retiredEpochs.includes(payload.epoch)) return { status: 'stale_epoch', state };
    if (payload.direction !== 'tail') {
      return {
        status: 'epoch_changed',
        state: applyTimelineReplacement(state, payload.epoch),
        epoch: payload.epoch,
      };
    }
  }

  const authorityState = state.timeline.epoch && state.timeline.epoch !== payload.epoch
    ? applyTimelineReplacement(state, payload.epoch)
    : state;

  const base = !authorityState.timeline.initialized || payload.direction === 'tail'
    ? []
    : authorityState.timeline.entries;
  const entries = mergeAuthoritative(base, payload.entries);
  const nextSeq = nextSequenceForPage(authorityState, page);
  const prepared: AgentReplicaState = {
    ...authorityState,
    timeline: {
      epoch: payload.epoch,
      initialized: true,
      entries,
      nextSeq,
      hasOlder: payload.direction === 'before' ? payload.hasOlder : payload.hasOlder || authorityState.timeline.hasOlder,
      pendingLive: authorityState.timeline.pendingLive
        .filter((message) => message.payload.epoch === payload.epoch)
        .sort((left, right) => left.payload.seq - right.payload.seq),
    },
  };
  return drainPending(prepared);
}

export function reduceTimelineEvent(state: AgentReplicaState, message: AgentStreamMessage): TimelineReduction {
  if (!isTimelineMessage(message)) {
    return { status: 'applied', state: applyNonTimelineEvent(state, message) };
  }
  const payload = message.payload;
  const epoch = payload.epoch;
  if (state.retiredEpochs.includes(epoch)) return { status: 'stale_epoch', state };
  if (state.timeline.epoch && state.timeline.epoch !== epoch) {
    const reset = applyTimelineReplacement(state, epoch);
    return {
      status: 'epoch_changed',
      state: bufferLive(reset, message),
      epoch,
    };
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
  if (!state.agent) return state;
  switch (event.type) {
    case 'thread_started':
      return state;
    case 'turn_started':
      return {
        ...state,
        agent: {
          ...state.agent,
          status: 'running',
          activeTurn: event.turnId ? { turnId: event.turnId, startedAt: message.payload.timestamp } : state.agent.activeTurn,
        },
      };
    case 'turn_completed':
      return {
        ...state,
        agent: { ...state.agent, status: 'idle', activeTurn: null, ...(event.usage ? { lastUsage: clone(event.usage) } : {}) },
      };
    case 'turn_failed':
      return { ...state, agent: { ...state.agent, status: 'failed', activeTurn: null, lastError: event.error } };
    case 'turn_canceled':
      return { ...state, agent: { ...state.agent, status: 'idle', activeTurn: null } };
    case 'usage_updated':
      return { ...state, agent: { ...state.agent, lastUsage: clone(event.usage) } };
    case 'runtime_updated':
      return {
        ...state,
        agent: {
          ...state.agent,
          status: event.runtimeInfo.status,
          runtimeInfo: clone(event.runtimeInfo),
          ...(event.runtimeInfo.cwd === undefined ? {} : { cwd: event.runtimeInfo.cwd }),
          ...(event.runtimeInfo.model === undefined ? {} : { model: event.runtimeInfo.model }),
        },
      };
  }
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
  const projected = liveEntry(message);
  return {
    ...state,
    timeline: {
      ...state.timeline,
      entries: coalesceEntry(state.timeline.entries, projected),
      nextSeq: payload.seq + 1,
      pendingLive: state.timeline.pendingLive.filter((current) => current.payload.seq !== payload.seq),
    },
  };
}

function liveEntry(message: TimelineStreamMessage): ProjectedTimelineEntry {
  const payload = message.payload;
  return {
    providerId: payload.event.providerId,
    item: clone(payload.event.item),
    ...(payload.event.turnId === undefined ? {} : { turnId: payload.event.turnId }),
    timestamp: payload.timestamp,
    seqStart: payload.seq,
    seqEnd: payload.seq,
    sourceSeqRanges: [{ startSeq: payload.seq, endSeq: payload.seq }],
    collapsed: [],
    resources: clone(payload.event.resources),
  };
}

function coalesceEntry(
  entries: readonly ProjectedTimelineEntry[],
  incoming: ProjectedTimelineEntry,
): ProjectedTimelineEntry[] {
  const next = entries.map((entry) => clone(entry));
  const incomingItem = incoming.item;
  if (incomingItem.type === 'assistant_message') {
    const previous = next.at(-1);
    if (
      previous?.item.type === 'assistant_message'
      && sameContext(previous, incoming)
      && previous.item.messageId === incomingItem.messageId
    ) {
      previous.item.text += incomingItem.text;
      extendEntry(previous, incoming, 'assistant_merge');
      return next;
    }
  } else if (incomingItem.type === 'reasoning') {
    const previous = next.at(-1);
    if (previous?.item.type === 'reasoning' && sameContext(previous, incoming)) {
      previous.item.text += incomingItem.text;
      extendEntry(previous, incoming, 'reasoning_merge');
      return next;
    }
  } else if (incomingItem.type === 'tool_call') {
    const existing = next.find((entry) => (
      entry.providerId === incoming.providerId
      && entry.item.type === 'tool_call'
      && entry.item.callId === incomingItem.callId
    ));
    if (existing) {
      existing.item = clone(incomingItem);
      extendEntry(existing, incoming, 'tool_lifecycle');
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
      existing.item = clone(incomingItem);
      extendEntry(existing, incoming);
      return sortEntries(next);
    }
  }
  next.push(clone(incoming));
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
  return left.providerId === right.providerId && left.turnId === right.turnId;
}

function mergeAuthoritative(
  existing: readonly ProjectedTimelineEntry[],
  authoritative: readonly ProjectedTimelineEntry[],
): ProjectedTimelineEntry[] {
  const replaced = existing.filter((entry) => (
    !authoritative.some((candidate) => rangesOverlap(entry.sourceSeqRanges, candidate.sourceSeqRanges))
  ));
  return sortEntries([...replaced.map(clone), ...authoritative.map(clone)]);
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
