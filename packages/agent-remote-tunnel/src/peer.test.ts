import { describe, expect, test } from 'vitest';
import { createTunnelPeer, type TunnelData, type TunnelSocket } from './index.js';

function socketPair(): [TunnelSocket, TunnelSocket] {
  type Listener = (data: TunnelData) => void;
  type CloseListener = (code: number, reason: string) => void;
  const listeners: [Set<Listener>, Set<Listener>] = [new Set(), new Set()];
  const closes: [Set<CloseListener>, Set<CloseListener>] = [new Set(), new Set()];
  return [0, 1].map(index => ({
    send(data: TunnelData) { queueMicrotask(() => listeners[1 - index]!.forEach(listener => listener(data))); },
    onMessage(listener: Listener) { listeners[index]!.add(listener); return () => listeners[index]!.delete(listener); },
    close(code = 1000, reason = '') { closes[index]!.forEach(listener => listener(code, reason)); closes[1 - index]!.forEach(listener => listener(code, reason)); },
    onClose(listener: CloseListener) { closes[index]!.add(listener); return () => closes[index]!.delete(listener); },
  })) as [TunnelSocket, TunnelSocket];
}

describe('TunnelPeer', () => {
  test('multiplexes streamed response headers and bytes', async () => {
    const [relaySocket, controllerSocket] = socketPair();
    const controller = createTunnelPeer(controllerSocket, { http: async request => ({
      status: 201,
      headers: [['x-path', request.path]],
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } }),
    }) });
    const relay = createTunnelPeer(relaySocket, {});
    const response = await relay.openHttp({ previewId: 'p', method: 'GET', path: '/stream', headers: [] });
    expect(response.status).toBe(201);
    expect(response.headers).toEqual([['x-path', '/stream']]);
    expect(new Uint8Array(await new Response(response.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    relay.close(); controller.close();
  });

  test('rejects work beyond configured concurrent capacity', async () => {
    const [relaySocket, controllerSocket] = socketPair();
    const controller = createTunnelPeer(controllerSocket, { http: async () => new Promise(() => undefined) }, { maxStreams: 1, openTimeoutMs: 100 });
    const relay = createTunnelPeer(relaySocket, {}, { maxStreams: 1, openTimeoutMs: 100 });
    void relay.openHttp({ previewId: 'p', method: 'GET', path: '/one', headers: [] }).catch(() => undefined);
    await expect(relay.openHttp({ previewId: 'p', method: 'GET', path: '/two', headers: [] })).rejects.toMatchObject({ code: 'capacity' });
    relay.close(); controller.close();
  });

  test('cancels every live stream for a revoked preview', async () => {
    const [relaySocket, controllerSocket] = socketPair();
    const controller = createTunnelPeer(controllerSocket, { http: async (_request, context) => new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })) });
    const relay = createTunnelPeer(relaySocket, {});
    const pending = relay.openHttp({ previewId: 'revoked', method: 'GET', path: '/', headers: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    relay.cancelPreview('revoked');
    await expect(pending).rejects.toMatchObject({ code: 'preview_revoked' });
    relay.close(); controller.close();
  });

  test('replenishes body credit only as the consumer reads', async () => {
    const [relaySocket, controllerSocket] = socketPair();
    const bytes = new Uint8Array(40).map((_value, index) => index);
    const controller = createTunnelPeer(controllerSocket, { http: async () => ({ status: 200, headers: [], body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) }) }, { initialCreditBytes: 8 });
    const relay = createTunnelPeer(relaySocket, {}, { initialCreditBytes: 8 });
    const response = await relay.openHttp({ previewId: 'p', method: 'GET', path: '/', headers: [] });
    expect(new Uint8Array(await new Response(response.body).arrayBuffer())).toEqual(bytes);
    relay.close(); controller.close();
  });
});
