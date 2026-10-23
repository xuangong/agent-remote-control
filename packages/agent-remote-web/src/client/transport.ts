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
