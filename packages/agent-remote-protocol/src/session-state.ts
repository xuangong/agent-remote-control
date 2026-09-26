import { Clone } from '@sinclair/typebox/value';
import type { PublicAgentNonTimelineEvent } from './envelope.js';
import type { AgentInteractionRequest } from './interactions.js';
import type { AgentSnapshotPayload, AgentStatus } from './snapshot.js';

/** Native and wire events share the same state transitions, without transport or Provider identity interpretation. */
export type SessionStateEvent = PublicAgentNonTimelineEvent extends infer Event
  ? Event extends { providerId: string } ? Omit<Event, 'providerId'> : never : never;
export type SessionInteractionEvent =
  | { type: 'interaction_requested'; request: AgentInteractionRequest }
  | { type: 'interaction_resolved' | 'interaction_invalidated'; requestId: string };

/** Pending interactions overlay native activity; transport loss alone never resolves them. */
export function withSessionInteractions(state: AgentSnapshotPayload, pending: readonly AgentInteractionRequest[]): AgentSnapshotPayload {
  const nativeStatus = state.runtimeInfo.status;
  const status: AgentStatus = state.status === 'failed' || state.status === 'closed' ? state.status
    : pending.length ? 'waiting'
    : state.status === 'waiting' && state.pendingInteractions.length > 0
      ? nativeStatus === 'waiting' ? (state.activeTurn ? 'running' : 'idle') : nativeStatus
      : state.status;
  return { ...state, status, pendingInteractions: Clone([...pending]) };
}

export function reduceSessionState(
  previous: AgentSnapshotPayload,
  event: SessionStateEvent | SessionInteractionEvent,
  timestamp: string,
): AgentSnapshotPayload {
  let state = { ...previous, updatedAt: timestamp };
  const activity = (status: AgentStatus) => { state = { ...state, status, runtimeInfo: { ...state.runtimeInfo, status } }; };
  switch (event.type) {
    case 'thread_started':
      if (state.runtimeInfo.status === 'starting') activity('idle');
      break;
    case 'turn_started':
      activity('running');
      state.activeTurn = event.turnId
        ? state.activeTurn?.turnId === event.turnId ? state.activeTurn : { turnId: event.turnId, startedAt: timestamp }
        : null;
      break;
    case 'turn_completed':
      activity('idle');
      state.activeTurn = null;
      if (event.usage) state.lastUsage = Clone(event.usage);
      break;
    case 'turn_failed':
      activity('failed');
      state.activeTurn = null;
      state.lastError = event.error;
      break;
    case 'turn_canceled':
      activity('idle');
      state.activeTurn = null;
      break;
    case 'usage_updated':
      state.lastUsage = Clone(event.usage);
      break;
    case 'runtime_updated':
      state.runtimeInfo = Clone(event.runtimeInfo);
      state.status = event.runtimeInfo.status;
      if (event.activeTurnId === null) state.activeTurn = null;
      else if (event.activeTurnId !== undefined && event.activeTurnId !== state.activeTurn?.turnId) {
        state.activeTurn = { turnId: event.activeTurnId, startedAt: timestamp };
      }
      if (event.runtimeInfo.cwd !== undefined) state.cwd = event.runtimeInfo.cwd;
      if (event.runtimeInfo.model !== undefined) state.model = event.runtimeInfo.model;
      if (event.runtimeInfo.persistence !== undefined) state.persistence = Clone(event.runtimeInfo.persistence);
      break;
    case 'interaction_requested': {
      const pending = new Map(state.pendingInteractions.map(request => [request.requestId, request]));
      pending.set(event.request.requestId, Clone(event.request));
      state.pendingInteractions = [...pending.values()];
      break;
    }
    case 'interaction_resolved':
    case 'interaction_invalidated':
      state.pendingInteractions = state.pendingInteractions.filter(request => request.requestId !== event.requestId);
      break;
  }
  return withSessionInteractions({ ...state, pendingInteractions: previous.pendingInteractions }, state.pendingInteractions);
}

export type SessionOperationKind = 'send_message' | 'queue_message' | 'steer' | 'cancel'
  | 'set_planning' | 'set_session_setting' | 'execute_command' | 'interaction_response';
export type SessionOperationAvailability = { allowed: true } | { allowed: false; code: string; reason: string };

/** Shared admission semantics. Server authority and native dispatch must still be checked at execution time. */
export function sessionOperationAvailability(
  state: AgentSnapshotPayload | null,
  operation: SessionOperationKind,
  context: { synchronized?: boolean; closed?: boolean; control?: 'control' | 'read_only' | 'checking' | 'unsupported'; interactionId?: string } = {},
): SessionOperationAvailability {
  const reject = (code: string, reason: string): SessionOperationAvailability => ({ allowed: false, code, reason });
  if (!state || context.synchronized === false) return reject('session_not_ready', 'The session has not finished synchronizing.');
  if (context.closed || state.status === 'closed') return reject('session_closed', 'The session is closed.');
  if (context.control !== undefined && context.control !== 'control') return reject('session_read_only', 'This session does not currently grant control.');
  const connection = state.runtimeInfo.connection;
  if (connection && connection.state !== 'connected') return reject(`native_runtime_${connection.state}`, connection.reason ?? `The native runtime is ${connection.state}.`);
  const capabilities = state.capabilities;
  const supported = operation === 'interaction_response' ? true
    : operation === 'send_message' ? capabilities.sendMessage
    : operation === 'queue_message' ? capabilities.sendMessage && capabilities.queueMessage === true
    : operation === 'steer' ? capabilities.steer
    : operation === 'cancel' ? capabilities.cancel
    : operation === 'set_planning' ? capabilities.planning
    : operation === 'set_session_setting' ? capabilities.sessionSettings : capabilities.commands;
  if (!supported) return reject('unsupported_command', `Provider does not support ${operation}.`);
  if ((operation === 'set_planning' || operation === 'set_session_setting')
    && (state.status !== 'idle' || state.activeTurn !== null || state.pendingInteractions.length > 0)) {
    return reject('agent_busy', 'Session settings can change only while idle with no pending interactions.');
  }
  if (operation === 'interaction_response' && context.interactionId !== undefined
    && !state.pendingInteractions.some(request => request.requestId === context.interactionId)) {
    return reject('stale_interaction', 'This interaction is no longer pending.');
  }
  return { allowed: true };
}
