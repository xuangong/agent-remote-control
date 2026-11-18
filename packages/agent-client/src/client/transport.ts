import type {
  AgentSnapshot,
  ClientMessage,
  HistoryPage,
  IncompatibleProtocolVersionErrorMessage,
  ServerMessage,
  TimelineCursor,
  TimelineDirection,
} from '@orchardworks/agent-remote-protocol';

export type RemoteServerMessage = ServerMessage | IncompatibleProtocolVersionErrorMessage;

export interface RemoteRequestOptions {
  readonly signal?: AbortSignal;
}

export interface RemoteTransportDiagnostic {
  readonly source: 'http' | 'websocket';
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface RemoteProtocolObservation {
  readonly redacted?: boolean;
  readonly direction: 'inbound' | 'outbound';
  readonly channel: 'http' | 'websocket';
  readonly message: ClientMessage | RemoteServerMessage;
}

/**
 * Send outcomes that leave delivery uncertain: the message may or may not have reached the agent. The client records
 * them on the outgoing message in plain words, which the conversation shows instead of the Host's reply.
 */
export const UNCERTAIN_SEND_CODES: readonly string[] = ['operation_timeout', 'connection_disconnected', 'operation_stopped', 'command_failed', 'operation_outcome_unknown'];
/** Uncertain outcomes whose operation the Host will not run again: only a new attempt can send the message. */
export const NEW_ATTEMPT_SEND_CODES: readonly string[] = ['command_failed', 'operation_outcome_unknown'];
/** Whether a send or a retry ended uncertain. Its outgoing message then says what to check and what Retry does next. */
export function isUncertainSend(error: unknown): error is RemoteOperationError {
  return error instanceof RemoteOperationError && UNCERTAIN_SEND_CODES.includes(error.code);
}

export class RemoteOperationError extends Error {
  readonly name = 'RemoteOperationError';

  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/** How a session subscription ended. Permanent means the Relay refused it, so retrying cannot succeed without user action. */
export interface RemoteDisconnectReason {
  readonly permanent: boolean;
  readonly reason: string;
  /** Too many session streams are open; the subscription can succeed once another closes. */
  readonly capacity?: true;
  /** The Relay closed the subscription for one in more recent use; resume it when it is in use again. */
  readonly preempted?: true;
}

export interface RemoteTransportListener {
  onOpen(): void;
  onMessage(message: RemoteServerMessage): void;
  onDisconnect(closure?: RemoteDisconnectReason): void;
}

export interface RemoteConnection {
  send(message: ClientMessage): void;
  close(): void;
  /**
   * Whether the owner uses the subscription now, or since when it has not. The Relay gives an account's
   * streams to subscriptions in use and, when they run out, closes the least recently used ones first.
   */
  setActive?(active: boolean, inactiveSince?: number): void;
}

export type SessionSuccessionSupport = 'disabled' | 'unknown' | 'supported' | 'unsupported';
export interface SessionSuccessionSelection { roleId?: string; afterRevision?: number; limit?: number; cursor?: string }

export interface RemoteAgentTransport {
  readonly sessionSuccessionSupport?: SessionSuccessionSupport;
  onSessionSuccession?(listener: (succession: import('@orchardworks/agent-remote-protocol').SessionSuccessionReplay) => void): () => void;
  fetchSessionSuccessions?(selection?: SessionSuccessionSelection, options?: RemoteRequestOptions): Promise<import('@orchardworks/agent-remote-protocol').SessionSuccessionReplayPage>;
  fetchSessionSuccessionOperation?(roleId: string, operationId: string, options?: RemoteRequestOptions): Promise<import('@orchardworks/agent-remote-protocol').SessionSuccessionReplay>;
  fetchSessionSuccessionCurrent?(roleId: string, options?: RemoteRequestOptions): Promise<import('@orchardworks/agent-remote-protocol').SessionSuccessionCurrent>;
  /** Preferred recovery path; custom transports can retain HTTP history loading. */
  readonly timelineRecovery?: 'http' | 'websocket';
  onSessionTitle?(listener: (session: import('@orchardworks/agent-remote-protocol').SessionTitleUpdate) => void): () => void;
  onSessionMigration?(listener: (migration: import('@orchardworks/agent-remote-protocol').SessionMigration) => void): () => void;
  /**
   * Session states the Relay shares for every Host this account may use, without opening session streams. The
   * listener receives the current view at once and again whenever a state changes or turns unknown.
   */
  watchSessionStates?(listener: (states: import('./session-states.js').SessionStatesView) => void): () => void;
  /** The account's read positions, shared by every device; the listener receives the current view at once and on each change. */
  watchSessionReads?(listener: (reads: import('./session-reads.js').SessionReadsView) => void): () => void;
  /** Records that the owner has seen a session's replies up to readAt; positions never move back. */
  markSessionRead?(session: import('./session-states.js').SessionStateRef, readAt: number): void;
  /** The account's drafts, shared by every device; the listener receives the current view at once and on each change. */
  watchSessionDrafts?(listener: (drafts: import('./session-drafts.js').SessionDraftsView) => void): () => void;
  /** Saves a session's draft for every device (an empty text clears it) and resolves with the revision it got. */
  saveSessionDraft?(session: import('./session-states.js').SessionStateRef, text: string): Promise<import('@orchardworks/agent-remote-protocol').SessionDraft>;
  /** The account's outbox: messages waiting for offline Hosts. The listener receives the current view at once and on each change. */
  watchSessionOutbox?(listener: (outbox: import('./session-outbox.js').SessionOutboxView) => void): () => void;
  /** Leaves a message for a session whose Host is offline; its Controller delivers it when it returns. */
  queueMessage?(session: import('./session-states.js').SessionStateRef, text: string): Promise<import('@orchardworks/agent-remote-protocol').OutboxEntry>;
  /** Takes a waiting message back before its Host's Controller claims it. */
  cancelQueuedMessage?(id: string): Promise<void>;
  /** Lets a message that was not delivered wait again. */
  retryQueuedMessage?(id: string): Promise<import('@orchardworks/agent-remote-protocol').OutboxEntry>;
  fetchSnapshot(agentId: string, options?: RemoteRequestOptions): Promise<AgentSnapshot>;
  fetchTimeline(
    agentId: string,
    direction: TimelineDirection,
    cursor?: TimelineCursor,
    limit?: number,
    options?: RemoteRequestOptions,
  ): Promise<HistoryPage>;
  connect(agentId: string, listener: RemoteTransportListener): RemoteConnection;
  onDiagnostic(listener: (diagnostic: RemoteTransportDiagnostic) => void): () => void;
  onProtocolMessage(listener: (observation: RemoteProtocolObservation) => void): () => void;
}
