import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createTunnelPeer, type PreviewSnapshot, type TunnelSocket } from '@orchardworks/agent-remote-tunnel';
import { createPreviewRegistry, createLoopbackTunnelHandlers, type PreviewRegistry } from '@orchardworks/agent-remote-tunnel/node';
import type { RemoteHostControlRequest } from '@orchardworks/agent-remote-relay';

export function createControllerPreviews(options: { stateDirectory: string; ttlMs?: number; protectedPorts?: number[]; diagnostic?(event: string): void }) {
  let registry: PreviewRegistry | undefined;
  let initialization: Promise<void> = Promise.resolve();
  let identity: string | undefined;
  let generation = 0;
  let connection: { url: string; tunnelToken: string } | undefined;
  let peer: ReturnType<typeof createTunnelPeer> | undefined;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let closed = false;
  const listeners = new Set<(snapshot: PreviewSnapshot) => void>();
  function disconnect() {
    connection = undefined; clearTimeout(retry); retry = undefined; peer?.close(1012, 'Control connection closed'); peer = undefined;
    socket?.terminate(); socket = undefined;
  }
  function reconcile() {
    if (!registry?.snapshot().registrations.some(value => value.status === 'active')) {
      clearTimeout(retry); retry = undefined; peer?.close(1000, 'No active previews'); peer = undefined; socket?.terminate(); socket = undefined; return;
    }
    if (closed || !connection || socket || retry) return;
    const config = connection;
    const url = new URL(config.url); url.pathname = '/ws/preview-tunnel';
    const next = new WebSocket(url, { headers: { authorization: `Bearer ${config.tunnelToken}` }, perMessageDeflate: false,
      followRedirects: false, handshakeTimeout: 10_000, maxPayload: 256 * 1024 });
    socket = next;
    next.once('open', () => {
      if (closed || socket !== next || connection !== config) { next.terminate(); return; }
      retries = 0;
      peer = createTunnelPeer(nodeSocket(next), createLoopbackTunnelHandlers({ lookup: id => registry?.lookup(id), protectedPorts: options.protectedPorts }));
      options.diagnostic?.('tunnel_connected');
    });
    next.on('error', () => next.terminate());
    next.once('close', () => {
      if (socket !== next) return;
      socket = undefined; peer = undefined;
      options.diagnostic?.('tunnel_disconnected');
      if (!closed && connection === config) {
        retry = setTimeout(() => { retry = undefined; reconcile(); }, Math.min(30_000, 500 * 2 ** Math.min(retries++, 6)));
        retry.unref?.();
      }
    });
  }
  function publish() {
    if (!registry) return;
    const snapshot = registry.snapshot();
    for (const value of snapshot.registrations) if (value.status !== 'active') peer?.cancelPreview(value.id);
    for (const listener of listeners) listener(snapshot);
    reconcile();
  }
  return {
    snapshot: () => registry?.snapshot(),
    subscribe(listener: (snapshot: PreviewSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    registered(info: { url: string; hostId: string; tunnelToken: string }) {
      disconnect(); const current = ++generation;
      const nextIdentity = createHash('sha256').update(JSON.stringify([new URL(info.url).origin, info.hostId])).digest('hex');
      initialization = initialization.catch(() => undefined).then(async () => {
        if (closed || current !== generation) return;
        if (identity !== nextIdentity) {
          await registry?.close(); registry = undefined;
          registry = await createPreviewRegistry({ filePath: join(options.stateDirectory, 'previews', nextIdentity + '.json'), ttlMs: options.ttlMs, protectedPorts: options.protectedPorts });
          identity = nextIdentity; registry.subscribe(publish);
        }
        if (closed || current !== generation) return;
        connection = { url: info.url, tunnelToken: info.tunnelToken }; publish();
      });
      void initialization.catch(() => { disconnect(); options.diagnostic?.('preview_storage_failed'); });
    },
    disconnected() { generation += 1; disconnect(); },
    async control(request: RemoteHostControlRequest) {
      await initialization;
      if (!registry || !connection) return { status: 503, body: JSON.stringify({ error: 'Preview registry is unavailable.' }) };
      try {
        if (request.path === '/remote/previews' && request.method === 'GET') return { status: 200, body: JSON.stringify(registry.snapshot()) };
        if (request.path !== '/remote/previews' && request.path !== '/remote/previews/unregister' && request.path !== '/remote/previews/renew') return { status: 404, body: JSON.stringify({ error: 'Preview control route was not found.' }) };
        if (request.method !== 'POST') return { status: 405, body: JSON.stringify({ error: 'Preview control method is not allowed.' }) };
        const input = JSON.parse(request.body ?? '{}');
        const registration = request.path === '/remote/previews/unregister' ? await registry.unregister(input.id)
          : request.path === '/remote/previews/renew' ? await registry.renew(input.id) : await registry.register(input);
        options.diagnostic?.(request.path.endsWith('unregister') ? 'preview_unregistered' : request.path.endsWith('renew') ? 'preview_renewed' : 'preview_registered');
        return { status: 200, body: JSON.stringify({ registration }) };
      } catch { return { status: 400, body: JSON.stringify({ error: 'Cannot register this local target. Check its loopback address, port, and local preview storage.' }) }; }
    },
    async close() { closed = true; generation += 1; disconnect(); await initialization.catch(() => undefined); await registry?.close(); listeners.clear(); },
  };
}
function nodeSocket(socket: WebSocket): TunnelSocket {
  return {
    get bufferedAmount() { return socket.bufferedAmount; },
    send: data => new Promise<void>((resolve, reject) => socket.send(data, { binary: data instanceof Uint8Array }, error => error ? reject(error) : resolve())),
    close: (code, reason) => socket.close(code, reason),
    onMessage(listener) { const receive = (data: import('ws').RawData, binary: boolean) => listener(binary ? new Uint8Array(data as Buffer) : data.toString()); socket.on('message', receive); return () => { socket.off('message', receive); }; },
    onClose(listener) { const close = (code: number, reason: Buffer) => listener(code, reason.toString()); socket.on('close', close); return () => { socket.off('close', close); }; },
  };
}
