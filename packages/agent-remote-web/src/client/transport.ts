import type {
  AgentSnapshot,
  ClientMessage,
  HistoryPage,
  IncompatibleProtocolVersionErrorMessage,
  ServerMessage,
  TimelineCursor,
  TimelineDirection,
} from '@agent-remote-controller/agent-remote-protocol';

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

export interface RemoteTransportListener {
  onOpen(): void;
  onMessage(message: RemoteServerMessage): void;
  onDisconnect(): void;
}

export interface RemoteConnection {
  send(message: ClientMessage): void;
  close(): void;
}

export interface RemoteAgentTransport {
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
