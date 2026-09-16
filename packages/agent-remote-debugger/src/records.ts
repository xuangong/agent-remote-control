import type { AgentInteractionRequest, AgentSnapshotPayload, ProjectedTimelineEntry, ResourceResponseState, ResourceState } from '@agent-remote-controller/agent-remote-protocol';
import type { AgentReplica, ReplicaDiagnostic, RemoteSessionStatus } from '@agent-remote-controller/agent-remote-web/headless';

import { stableJsonValue } from './structural.js';
import { redactDebuggerValue } from './redaction.js';

export type DebuggerResourceState = ResourceState | Omit<Extract<ResourceResponseState, { status: 'available' }>, 'contentBase64'>;

export type DebuggerRecordBase = {
  schemaVersion: '1.1.0';
  timestamp: string;
  agentId: string;
};

export type DebuggerRecord =
  | DebuggerRecordBase & { kind: 'connection'; status: RemoteSessionStatus }
  | DebuggerRecordBase & { kind: 'agent'; agent: AgentSnapshotPayload }
  | DebuggerRecordBase & { kind: 'timeline_reset'; previousEpoch: string | null; epoch: string | null }
  | DebuggerRecordBase & { kind: 'timeline_upsert'; epoch: string; entry: ProjectedTimelineEntry }
  | DebuggerRecordBase & { kind: 'interaction_requested'; request: AgentInteractionRequest }
  | DebuggerRecordBase & { kind: 'interaction_resolved'; requestId: string; interactionKind: AgentInteractionRequest['kind'] }
  | DebuggerRecordBase & { kind: 'resource'; resourceId: string; state: DebuggerResourceState }
  | DebuggerRecordBase & { kind: 'diagnostic'; diagnostic: ReplicaDiagnostic }
  | DebuggerRecordBase & { kind: 'checkpoint'; epoch: string | null; nextSeq: number; hasOlder: boolean; bufferedLive: number };

export interface RemoteSessionStatusSource {
  subscribeStatus(listener: (status: RemoteSessionStatus) => void): () => void;
}

type ReplicaState = ReturnType<AgentReplica['getState']>;

export function observeReplica(
  agentId: string,
  replica: AgentReplica,
  statusSource: RemoteSessionStatusSource,
  emit: (record: DebuggerRecord) => void,
): () => void {
  let ready = false;
  let status: RemoteSessionStatus = 'idle';
  let emittedConnectionStatus: RemoteSessionStatus | undefined;
  let previous: ReplicaState | undefined;
  const makeRecord = <T extends DebuggerRecord['kind']>(kind: T, fields: Omit<Extract<DebuggerRecord, { kind: T }>, keyof DebuggerRecordBase | 'kind'>): void => {
    const record = { schemaVersion: '1.1.0', timestamp: new Date().toISOString(), agentId, kind, ...fields } as Extract<DebuggerRecord, { kind: T }>;
    emit(redactDebuggerValue(record) as DebuggerRecord);
  };
  const project = () => {
    const current = replica.getState();
    if (!ready) return;
    if (!previous) {
      makeRecord('connection', { status });
      emittedConnectionStatus = status;
      emitBaseline(current, makeRecord);
      previous = current;
      return;
    }
    emitChanges(previous, current, makeRecord);
    previous = current;
  };
  const unsubscribeReplica = replica.subscribe(project);
  const unsubscribeStatus = statusSource.subscribeStatus((next) => {
    status = next;
    if (!ready && next === 'ready') {
      ready = true;
      project();
    } else if (ready && emittedConnectionStatus !== next) {
      makeRecord('connection', { status: next });
      emittedConnectionStatus = next;
    }
  });
  return () => {
    unsubscribeReplica();
    unsubscribeStatus();
  };
}

function emitBaseline(
  state: ReplicaState,
  emit: <T extends DebuggerRecord['kind']>(kind: T, fields: Omit<Extract<DebuggerRecord, { kind: T }>, keyof DebuggerRecordBase | 'kind'>) => void,
): void {
  if (state.agent) emit('agent', { agent: state.agent });
  emit('timeline_reset', { previousEpoch: null, epoch: state.timeline.epoch });
  if (state.timeline.epoch) {
    for (const entry of state.timeline.entries) emit('timeline_upsert', { epoch: state.timeline.epoch, entry });
  }
  for (const request of state.pendingInteractions) emit('interaction_requested', { request });
  for (const [resourceId, stateValue] of Object.entries(state.resources)) emit('resource', { resourceId, state: publicResourceState(stateValue) });
  for (const diagnostic of state.diagnostics) emit('diagnostic', { diagnostic });
  emitCheckpoint(state, emit);
}

function emitChanges(
  previous: ReplicaState,
  current: ReplicaState,
  emit: <T extends DebuggerRecord['kind']>(kind: T, fields: Omit<Extract<DebuggerRecord, { kind: T }>, keyof DebuggerRecordBase | 'kind'>) => void,
): void {
  if (!equal(previous.agent, current.agent) && current.agent) emit('agent', { agent: current.agent });
  let timelineReset = previous.timeline.epoch !== current.timeline.epoch;
  if (!timelineReset && current.timeline.epoch) {
    const currentRows = new Set(current.timeline.entries.map((entry) => entry.seqStart));
    timelineReset = previous.timeline.entries.some((entry) => !currentRows.has(entry.seqStart));
  }
  if (timelineReset) {
    emit('timeline_reset', { previousEpoch: previous.timeline.epoch, epoch: current.timeline.epoch });
    if (current.timeline.epoch) {
      for (const entry of current.timeline.entries) emit('timeline_upsert', { epoch: current.timeline.epoch, entry });
    }
  } else if (current.timeline.epoch) {
    const priorEntries = new Map(previous.timeline.entries.map((entry) => [entry.seqStart, entry]));
    for (const entry of current.timeline.entries) {
      if (!equal(priorEntries.get(entry.seqStart), entry)) emit('timeline_upsert', { epoch: current.timeline.epoch, entry });
    }
  }
  emitInteractionChanges(previous.pendingInteractions, current.pendingInteractions, emit);
  emitResourceChanges(previous.resources, current.resources, emit);
  const knownDiagnostics = new Set(previous.diagnostics.map(stableValue));
  for (const diagnostic of current.diagnostics) {
    const key = stableValue(diagnostic);
    if (!knownDiagnostics.has(key)) emit('diagnostic', { diagnostic });
  }
  if (timelineReset || !equal(checkpoint(previous), checkpoint(current))) emitCheckpoint(current, emit);
}

function emitInteractionChanges(
  previous: readonly AgentInteractionRequest[],
  current: readonly AgentInteractionRequest[],
  emit: <T extends DebuggerRecord['kind']>(kind: T, fields: Omit<Extract<DebuggerRecord, { kind: T }>, keyof DebuggerRecordBase | 'kind'>) => void,
): void {
  const previousById = new Map(previous.map((request) => [request.requestId, request]));
  const currentById = new Map(current.map((request) => [request.requestId, request]));
  for (const request of current) {
    if (!equal(previousById.get(request.requestId), request)) emit('interaction_requested', { request });
  }
  for (const request of previous) {
    if (!currentById.has(request.requestId)) emit('interaction_resolved', { requestId: request.requestId, interactionKind: request.kind });
  }
}

function emitResourceChanges(
  previous: ReplicaState['resources'],
  current: ReplicaState['resources'],
  emit: <T extends DebuggerRecord['kind']>(kind: T, fields: Omit<Extract<DebuggerRecord, { kind: T }>, keyof DebuggerRecordBase | 'kind'>) => void,
): void {
  for (const [resourceId, state] of Object.entries(current)) {
    if (!equal(previous[resourceId], state)) emit('resource', { resourceId, state: publicResourceState(state) });
  }
}

function emitCheckpoint(
  state: ReplicaState,
  emit: <T extends DebuggerRecord['kind']>(kind: T, fields: Omit<Extract<DebuggerRecord, { kind: T }>, keyof DebuggerRecordBase | 'kind'>) => void,
): void {
  emit('checkpoint', checkpoint(state));
}

function checkpoint(state: ReplicaState) {
  return {
    epoch: state.timeline.epoch,
    nextSeq: state.timeline.nextSeq,
    hasOlder: state.timeline.hasOlder,
    bufferedLive: state.timeline.pendingLive.length,
  };
}

function publicResourceState(state: ResourceResponseState | ResourceState): DebuggerResourceState {
  if (state.status !== 'available' || !('contentBase64' in state)) return state;
  const { contentBase64: _contentBase64, ...publicState } = state;
  return publicState;
}

function equal(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right);
}

function stableValue(value: unknown): string {
  return stableJsonValue(value);
}
