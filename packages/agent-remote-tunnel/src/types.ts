export type TunnelData = string | Uint8Array;

export interface TunnelSocket {
  readonly bufferedAmount?: number;
  send(data: TunnelData): void | Promise<void>;
  onMessage(listener: (data: TunnelData) => void): () => void;
  close(code?: number, reason?: string): void;
  onClose(listener: (code: number, reason: string) => void): () => void;
}

export type HeaderList = Array<[string, string]>;
export type PreviewStatus = 'active' | 'expired' | 'unregistered';
export type PreviewPathMode = 'strip' | 'preserve';
export interface PreviewSource { sessionId: string; itemId: string }
export interface PreviewRegistration {
  id: string; target: string; status: PreviewStatus; createdAt: number; expiresAt: number; revision: number;
  pathMode: PreviewPathMode; sources: PreviewSource[];
}
export interface PreviewSnapshot { epoch: string; revision: number; registrations: PreviewRegistration[] }

export interface TunnelHttpRequest {
  previewId: string;
  method: string;
  path: string;
  headers: HeaderList;
  body?: ReadableStream<Uint8Array>;
}

export interface TunnelHttpResponseSource {
  status: number;
  headers: HeaderList;
  body?: ReadableStream<Uint8Array>;
}

export interface TunnelHttpResponse extends TunnelHttpResponseSource {}

export interface TunnelWebSocketRequest {
  previewId: string;
  path: string;
  headers: HeaderList;
  protocols: string[];
}

export interface TunnelWebSocketEndpoint {
  send(data: string | Uint8Array, binary?: boolean): void | Promise<void>;
  onMessage(listener: (data: string | Uint8Array, binary: boolean) => void | Promise<void>): () => void;
  close(code?: number, reason?: string): void;
  onClose(listener: (code: number, reason: string) => void): () => void;
}

export interface TunnelWebSocketAcceptance {
  protocol?: string;
  socket: TunnelWebSocketEndpoint;
}

export interface TunnelPeerHandlers {
  http?(request: TunnelHttpRequest, context: { signal: AbortSignal }): Promise<TunnelHttpResponseSource>;
  webSocket?(request: TunnelWebSocketRequest, context: { signal: AbortSignal }): Promise<TunnelWebSocketAcceptance>;
}

export interface TunnelPeerOptions {
  maxStreams?: number;
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  initialCreditBytes?: number;
  openTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface TunnelPeer {
  openHttp(request: TunnelHttpRequest & { signal?: AbortSignal }): Promise<TunnelHttpResponse>;
  openWebSocket(request: TunnelWebSocketRequest & { signal?: AbortSignal }): Promise<TunnelWebSocketAcceptance>;
  cancelPreview(previewId: string, code?: string, message?: string): void;
  close(code?: number, reason?: string): void;
}
