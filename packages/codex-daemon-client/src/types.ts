import type { CodexAppServerTransport } from './app-server-transport.js';

export interface CodexRawNotification { method: string; params: unknown }

export interface CodexConnectionInfo {
  state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable';
  reason?: string;
  attempt?: number;
  nextRetryAt?: number;
}

export interface CodexThreadOrigin {
  parentThreadId: string;
  turnId?: string;
  callId?: string;
  description?: string;
}

export interface CodexChildSnapshot {
  thread: Record<string, unknown>;
  parentThreadId: string;
  history: unknown;
  notifications: CodexRawNotification[];
  historyState: 'available' | 'uncertain' | 'unavailable';
  requiresRefresh: boolean;
  discoveryOrder: number;
  origin?: CodexThreadOrigin;
}

export interface CodexSnapshotHandoff {
  threadId: string;
  snapshot: unknown;
  notifications: CodexRawNotification[];
}

export interface CodexRequestContext {
  threadId: string;
  generation: number;
  signal: AbortSignal;
}

/** Callbacks are synchronous handoffs, except for server request responses. */
export interface CodexDaemonCallbacks {
  onNotification?(method: string, params: unknown): void;
  onRequest?(method: string, params: unknown, id: string | number, context: CodexRequestContext): unknown | Promise<unknown>;
  onSnapshot?(handoff: CodexSnapshotHandoff): void;
  onChild?(child: CodexChildSnapshot): void;
  onChildOrigin?(threadId: string, origin: CodexThreadOrigin): void;
  onInvalidated?(reason: string, generation: number): void;
  onTransport?(transport: CodexAppServerTransport, generation: number): void;
  onConnection?(connection: CodexConnectionInfo): void;
  onTermination?(error: Error): void;
}
