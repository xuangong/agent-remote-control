/** Applying the display Snapshot, interactions, resources and background activity to the replica state. */
import { mergeBackgroundActivity, } from '@orchardworks/agent-remote-protocol';
import { reduceSessionState, withSessionInteractions } from '@orchardworks/agent-remote-protocol';
import type {
  BackgroundActivity,
  AgentInteractionRequest,
  AgentSnapshot,
  AgentUpdateMessage,
  InteractionRequestedMessage,
  InteractionInvalidatedMessage,
  InteractionResolvedMessage,
  ProjectedTimelineEntry,
  ResourceResponse,
  ResourceUpdate,
} from '@orchardworks/agent-remote-protocol';

import type {
  AgentReplicaState,
  SnapshotApplicationOptions,
} from './types.js';
import { clone } from './entry-algebra.js';

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

export function mapTimelineResources(
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

export function updateResourceStatus(
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

export function replaceResourceBinding(
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

/** Preserve explicit outcomes across later ordinary turns and delayed history pages. */
export function applyBackgroundOutcome(state: AgentReplicaState, background: BackgroundActivity): AgentReplicaState {
  const previous = state.timeline.backgroundActivities?.[background.id];
  const merged = mergeBackgroundActivity(previous, background);
  if (previous?.status === merged.status && previous?.summary === merged.summary) return state;
  const outcomes = { ...state.timeline.backgroundActivities, [background.id]: merged };
  const ids = Object.keys(outcomes);
  if (ids.length > 2048) delete outcomes[ids[0]!];
  return { ...state, timeline: { ...state.timeline, backgroundActivities: outcomes,
    entries: applyBackgroundEntries(state.timeline.entries, outcomes) } };
}

export function applyBackgroundEntries(entries: readonly ProjectedTimelineEntry[], outcomes: AgentReplicaState['timeline']['backgroundActivities']): readonly ProjectedTimelineEntry[] {
  if (!outcomes) return entries;
  return entries.map(entry => {
    const background = entry.item.background;
    const outcome = background && outcomes[background.id];
    if (!background || !outcome) return entry;
    const merged = mergeBackgroundActivity(background, outcome);
    return merged === background ? entry : { ...entry, item: { ...entry.item, background: clone(merged) } };
  });
}
