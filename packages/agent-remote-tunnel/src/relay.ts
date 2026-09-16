import { TunnelError } from './errors.js';
import type { HeaderList, TunnelHttpResponse, TunnelPeer, TunnelSocket, TunnelWebSocketRequest } from './types.js';

export interface PreviewRoute { id: string; status: 'active' | 'expired' | 'unregistered' }
export interface PreviewRelayRequest { method: string; path: string; headers: HeaderList; body?: ReadableStream<Uint8Array>; signal?: AbortSignal }
export type PreparedWebSocket = { protocol?: string; accept(socket: TunnelSocket): void };
export type PreviewRejection = { status: number; code: string; message: string };

export function createPreviewRelayBridge(peer: TunnelPeer, lookup: (previewId: string) => PreviewRoute | undefined, options: { acceptTimeoutMs?: number } = {}) {
  function requireActive(previewId: string) {
    const route = lookup(previewId);
    if (!route) throw new TunnelError('not_found', 'Preview registration was not found.');
    if (route.status !== 'active') throw new TunnelError(route.status, `Preview registration is ${route.status}.`);
  }
  return {
    fetch(previewId: string, request: PreviewRelayRequest): Promise<TunnelHttpResponse> {
      requireActive(previewId);
      return peer.openHttp({ previewId, ...request });
    },
    async prepareWebSocket(previewId: string, request: Omit<TunnelWebSocketRequest, 'previewId'> & { signal?: AbortSignal }): Promise<PreparedWebSocket | PreviewRejection> {
      try {
        requireActive(previewId);
        const accepted = await peer.openWebSocket({ previewId, ...request });
        let acceptedByRuntime = false;
        const timer = setTimeout(() => { if (!acceptedByRuntime) accepted.socket.close(1001, 'Browser upgrade was not accepted'); }, options.acceptTimeoutMs ?? 10_000);
        request.signal?.addEventListener('abort', () => accepted.socket.close(1001, 'Browser upgrade was cancelled'), { once: true });
        return { protocol: accepted.protocol, accept(socket) {
          acceptedByRuntime = true; clearTimeout(timer);
          const removeIncoming = socket.onMessage(data => accepted.socket.send(data, data instanceof Uint8Array));
          const removeApplication = accepted.socket.onMessage((data) => socket.send(data));
          const removeSocketClose = socket.onClose((code, reason) => accepted.socket.close(code, reason));
          const removeApplicationClose = accepted.socket.onClose((code, reason) => socket.close(code, reason));
          socket.onClose(() => { removeIncoming(); removeApplication(); removeSocketClose(); removeApplicationClose(); });
        } };
      } catch (error) {
        const code = error instanceof TunnelError ? error.code : 'unavailable';
        return { status: code === 'not_found' ? 404 : code === 'expired' || code === 'unregistered' ? 410 : 502, code, message: error instanceof Error ? error.message : 'Preview WebSocket is unavailable.' };
      }
    },
    close() { peer.close(); },
  };
}
