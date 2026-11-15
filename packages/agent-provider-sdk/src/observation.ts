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

export type AgentTimelineItem = (
  /** withdrawn marks input that was accepted into a native queue and removed before it ran. */
  | { type: 'user_message'; text: string; content?: import('./image-input.js').AgentUserMessagePart[]; messageId?: string; clientMessageId?: string; withdrawn?: import('./provider.js').AgentInputWithdrawal }
  | { type: 'assistant_message'; text: string; messageId?: string }
  | { type: 'agent_communication'; messageId: string; sender: string; recipient: string; text: string }
  | { type: 'reasoning'; text: string }
  | AgentToolCallTimelineItem
  | { type: 'todo'; items: AgentTaskItem[] }
  | { type: 'interaction'; request: AgentInteractionRequest; response: AgentInteractionResponse }
  | { type: 'error'; message: string }
  | { type: 'compaction'; status: 'loading' | 'completed'; trigger?: 'auto' | 'manual'; preTokens?: number }
) & { background?: import('./background-activity.js').BackgroundActivity };

export interface AgentUsage {
  /**
   * Latest normalized token snapshot. Session totals cover the entire native session; runtime totals
   * accumulate across turns since this native runtime/query started or resumed, or its last
   * native clear/reset. Turn and call scopes remain supported for legacy measurements.
   * Omitted for counters with unknown semantics. Consumers replace snapshots, never sum them.
   */
  tokenScope?: 'session' | 'runtime' | 'turn' | 'call';
  /** When tokenScope is present, input excludes cache read and cache creation. */
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  /** Total from the same normalized snapshot; consumers never sum usage notifications. */
  totalTokens?: number;
  totalCostUsd?: number;
  /** Confirms that context fields measure current occupancy, independently of token consumption. */
  contextScope?: 'current';
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

/** Current native execution facts. Pending interaction presentation is projected separately. */
export interface AgentRuntimeInfo {
  providerId: string;
  sessionId: string | null;
  status: 'starting' | 'idle' | 'running' | 'waiting' | 'failed' | 'closed';
  /** Native evidence explaining the current failed state; omitted when unknown or no longer failed. */
  failure?: { message: string; turnId?: string };
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
  | { type: 'background_activity_updated'; provider: string; background: import('./background-activity.js').BackgroundActivity; turnId?: string }
  | { type: 'thread_started'; sessionId: string; provider: string }
  | { type: 'turn_started'; provider: string; turnId?: string }
  | { type: 'turn_completed'; provider: string; usage?: AgentUsage; turnId?: string }
  | { type: 'turn_failed'; provider: string; error: string; code?: string; diagnostic?: string; turnId?: string }
  | { type: 'turn_canceled'; provider: string; reason: string; turnId?: string }
  | { type: 'timeline'; provider: string; item: AgentTimelineItem; turnId?: string }
  | { type: 'usage_updated'; provider: string; usage: AgentUsage; turnId?: string }
  /** Authoritative execution state; turn events alone never change runtime status.
   * activeTurnId is authoritative when present; null clears it without implying how the turn ended. */
  | { type: 'runtime_updated'; provider: string; runtimeInfo: AgentRuntimeInfo; activeTurnId?: string | null }
  | { type: 'interaction_requested'; provider: string; request: AgentInteractionRequest; turnId?: string }
  | { type: 'interaction_resolved'; provider: string; requestId: string; response: AgentInteractionResponse; turnId?: string }
  | { type: 'interaction_invalidated'; provider: string; requestId: string; reason: string; turnId?: string };

export interface ProviderResourceReference {
  locator: string;
  readLocator: string;
}

/**
 * The native identity of the finalized item a timeline observation belongs to. Live deltas and the rows read again from
 * native history after a reopen carry the same key for the same item, so a journal can recognize it.
 */
export interface ProviderItemIdentity {
  /** At most 4096 characters. Record, message, call or part identities of the native runtime, never a source key of a delta. */
  key: string;
  /**
   * This observation finishes the item. The adapter sets it itself on every history observation whose native record is
   * complete, interaction items included; the Controller never infers completion. A provider whose last live delta of a
   * text item carries no content may finish it with an empty body of the same text item type. That does not apply to
   * `tool_call` and `todo`, whose row replaces the whole item, nor to `compaction`, whose row overwrites its fields: an
   * empty body would wipe their content, so such an adapter repeats the full content with `completes`.
   */
  completes?: true;
  /** A reread of native history cannot reproduce this item, so the journal keeps its only copy. */
  liveOnly?: true;
}

export interface ProviderObservation {
  type: 'observation';
  sourceKey: string;
  occurredAt: number;
  /** Monotonic for the same sourceKey within this observation stream; not a cross-process clock. */
  nativeRevision?: number;
  /** History is for presentation, never proof of current execution or a callable interaction. */
  delivery: 'history' | 'live';
  event: AgentStreamEvent;
  /** Required, by an adapter that declares `AgentProviderAdapter.journal`, on every timeline observation and on every `interaction_resolved` observation, from which the agent manager builds an interaction item. */
  itemIdentity?: ProviderItemIdentity;
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
