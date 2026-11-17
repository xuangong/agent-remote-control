import type { SendState } from './send-state.js';
import type {
  MessagePart,
  AgentInteractionRequest,
  AgentSnapshotPayload,
  AgentStreamMessage,
  ProjectedTimelineEntry,
  ResourceResponse,
  ResourceState,
} from '@orchardworks/agent-remote-protocol';

export interface ReplicaDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface InteractionChange {
  readonly revision: number;
  readonly request?: AgentInteractionRequest;
}

export type TimelineStreamMessage = Extract<AgentStreamMessage, {
  payload: { event: { type: 'timeline' } };
}>;

export interface TimelineReplicaState {
  readonly backgroundActivities?: Readonly<Record<string, import('@orchardworks/agent-remote-protocol').BackgroundActivity>>;
  readonly epoch: string | null;
  readonly initialized: boolean;
  readonly entries: readonly ProjectedTimelineEntry[];
  readonly nextSeq: number;
  readonly hasOlder: boolean;
  readonly pendingLive: readonly TimelineStreamMessage[];
  /**
   * The epoch of a replacement the replica has heard of and not yet read. The held entries stay until the tail of that epoch
   * is applied; frames of the pending epoch wait in `pendingLive`.
   */
  readonly pendingEpoch?: string;
  /**
   * The rows came from this device's store, not from the Relay: a record of the last read, at the position it ended. The first `after` or `tail` page of
   * the connection confirms it (same epoch) or replaces it by key. Until then these rows are display, and the labels that say a session is opening give way.
   */
  readonly restoredFromDevice?: true;
}

/** Local delivery feedback, separate from the authoritative timeline and its cursor. */
export interface OutgoingMessage {
  readonly operationId?: string;
  readonly retryRequiresNewOperation?: boolean;
  readonly id: string;
  readonly agentId: string;
  readonly text: string;
  readonly content?: readonly MessagePart[];
  readonly imageDigests?: Readonly<Record<string, string>>;
  readonly submittedTextSha256?: string;
  /** Row keys of echoes already assigned to another local send. Retained across reload. */
  readonly consumedEchoKeys?: readonly string[];
  readonly delivery?: 'immediate' | 'next_turn';
  readonly status: SendState;
  readonly error?: string;
  /** The row key of the newest row when the message was sent (`epoch-start:<epoch>` when there was none); its echo is a later row. Absent when it was sent before the conversation was read, and in a ledger written before keys. */
  readonly afterKey?: string;
}

export interface AgentReplicaState {
  readonly sessionControl?: { readonly access: 'control' | 'read_only' | 'checking'; readonly available: boolean; readonly revision?: string; readonly nativeOwner?: {readonly kind: 'native_cli' | 'controller'; readonly generation: string} };

  readonly agent: AgentSnapshotPayload | null;
  readonly timeline: TimelineReplicaState;
  readonly pendingInteractions: readonly AgentInteractionRequest[];
  readonly interactionRevision: number;
  readonly interactionChanges: Readonly<Record<string, InteractionChange>>;
  readonly resources: Readonly<Record<string, ResourceResponse['payload']['state'] | ResourceState>>;
  readonly diagnostics: readonly ReplicaDiagnostic[];
  readonly retiredEpochs: readonly string[];
  readonly outgoingMessages?: readonly OutgoingMessage[];
}

export type TimelineReduction =
  | { status: 'applied' | 'buffered' | 'duplicate'; state: AgentReplicaState }
  | { status: 'gap'; state: AgentReplicaState; expectedSeq: number }
  | { status: 'replaced'; state: AgentReplicaState; epoch: string }
  | { status: 'stale_epoch'; state: AgentReplicaState };

export interface SnapshotApplicationOptions {
  readonly interactionBaseline?: number;
}
