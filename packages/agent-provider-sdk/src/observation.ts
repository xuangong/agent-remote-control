import type { AgentToolResult } from './tool-result.js';
import type { AgentInteractionRequest, AgentInteractionResponse, AgentToolDetail } from './control.js';

export interface AgentTaskItem {
  text: string;
  completed: boolean;
  id?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface AgentToolCallBase {
  type: 'tool_call';
  callId: string;
  name: string;
  detail: AgentToolDetail;
  result?: AgentToolResult;
}

export type AgentToolCallTimelineItem = AgentToolCallBase & (
  | { status: 'running'; error: null }
  | { status: 'completed'; error: null }
  | { status: 'failed'; error: string }
  | { status: 'canceled'; error: null }
);

export type AgentTimelineItem =
  | { type: 'user_message'; text: string; content?: import('./image-input.js').AgentUserMessagePart[]; messageId?: string; clientMessageId?: string }
  | { type: 'assistant_message'; text: string; messageId?: string }
  | { type: 'reasoning'; text: string }
  | AgentToolCallTimelineItem
  | { type: 'todo'; items: AgentTaskItem[] }
  | { type: 'interaction'; request: AgentInteractionRequest; response: AgentInteractionResponse }
  | { type: 'error'; message: string }
  | { type: 'compaction'; status: 'loading' | 'completed'; trigger?: 'auto' | 'manual'; preTokens?: number };

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface AgentPlanningState {
  active: boolean;
  requested?: boolean;
}

export interface AgentRuntimeConnection {
  state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable';
  reason?: string;
  attempt?: number;
  nextRetryAt?: number;
}

/** A direct native child, with stable creation provenance when the runtime provides it. */
export interface AgentChildSession {
  nativeSessionId: string;
  title: string;
  role?: string;
  description?: string;
  createdAt: string;
  parentTurnId?: string;
  parentCallId?: string;
  status: 'starting' | 'idle' | 'running' | 'waiting' | 'failed' | 'closed';
  observation: 'live' | 'saved_history';
}

export interface AgentRuntimeInfo {
  providerId: string;
  sessionId: string | null;
  status: 'starting' | 'idle' | 'running' | 'waiting' | 'failed' | 'closed';
  cwd?: string;
  model?: string | null;
  mode?: string | null;
  planning?: AgentPlanningState;
  connection?: AgentRuntimeConnection;
  settings?: import('./session-settings.js').AgentSessionSetting[];
  childSessions?: AgentChildSession[];
  persistence?: import('./provider.js').AgentPersistenceHandle;
}

export type AgentStreamEvent =
  | { type: 'thread_started'; sessionId: string; provider: string }
  | { type: 'turn_started'; provider: string; turnId?: string }
  | { type: 'turn_completed'; provider: string; usage?: AgentUsage; turnId?: string }
  | { type: 'turn_failed'; provider: string; error: string; code?: string; diagnostic?: string; turnId?: string }
  | { type: 'turn_canceled'; provider: string; reason: string; turnId?: string }
  | { type: 'timeline'; provider: string; item: AgentTimelineItem; turnId?: string }
  | { type: 'usage_updated'; provider: string; usage: AgentUsage; turnId?: string }
  /** activeTurnId is authoritative when present; null clears it without implying how the turn ended. */
  | { type: 'runtime_updated'; provider: string; runtimeInfo: AgentRuntimeInfo; activeTurnId?: string | null }
  | { type: 'interaction_requested'; provider: string; request: AgentInteractionRequest; turnId?: string }
  | { type: 'interaction_resolved'; provider: string; requestId: string; response: AgentInteractionResponse; turnId?: string }
  | { type: 'interaction_invalidated'; provider: string; requestId: string; reason: string; turnId?: string };

export interface ProviderResourceReference {
  locator: string;
  readLocator: string;
}

export interface ProviderObservation {
  type: 'observation';
  sourceKey: string;
  occurredAt: number;
  nativeRevision?: number;
  delivery: 'history' | 'live';
  event: AgentStreamEvent;
  resourceReferences?: ProviderResourceReference[];
}

export interface ProviderHistoryBoundary {
  type: 'history_boundary';
  olderCursor?: string;
}

/** Complete, ordered Timeline correction after readiness. Runtime state is unaffected. */
export interface ProviderTimelineReplacement {
  type: 'timeline_replacement';
  olderCursor?: string;
  observations: ProviderObservation[];
}

export type ProviderStreamItem = ProviderObservation | ProviderHistoryBoundary | ProviderTimelineReplacement;
