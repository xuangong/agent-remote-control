import type {
  AgentInteractionRequest,
  AgentSnapshotPayload,
  AgentStreamMessage,
  ProjectedTimelineEntry,
  ResourceResponse,
  ResourceState,
} from '@agent-remote-controller/agent-remote-protocol';

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
  readonly epoch: string | null;
  readonly initialized: boolean;
  readonly entries: readonly ProjectedTimelineEntry[];
  readonly nextSeq: number;
  readonly hasOlder: boolean;
  readonly pendingLive: readonly TimelineStreamMessage[];
}

/** Local delivery feedback, separate from the authoritative timeline and its cursor. */
export interface OutgoingMessage {
  readonly id: string;
  readonly agentId: string;
  readonly text: string;
  readonly delivery?: 'immediate' | 'next_turn';
  readonly status: 'sending' | 'awaiting_echo' | 'unconfirmed' | 'failed';
  readonly error?: string;
  readonly epoch: string | null;
  readonly afterSeq: number;
}

export interface AgentReplicaState {
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
  | { status: 'epoch_changed'; state: AgentReplicaState; epoch: string }
  | { status: 'stale_epoch'; state: AgentReplicaState }
  | { status: 'reset_required'; state: AgentReplicaState; epoch: string };

export interface SnapshotApplicationOptions {
  readonly interactionBaseline?: number;
}
