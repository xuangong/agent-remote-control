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

  test('closes a bridged application socket without sending on the closed tunnel', async () => {
    const [relaySocket, controllerSocket] = socketPair();
    let applicationClosed: ((code: number, reason: string) => void) | undefined;
    const application = {
      send() {}, onMessage() { return () => {}; }, close() { applicationClosed?.(1000, 'closed'); },
      onClose(listener: (code: number, reason: string) => void) { applicationClosed = listener; return () => { applicationClosed = undefined; }; },
    };
    const controller = createTunnelPeer(controllerSocket, { webSocket: async () => ({ socket: application }) });
    const relay = createTunnelPeer(relaySocket, {});
    const accepted = await relay.openWebSocket({ previewId: 'p', path: '/', headers: [], protocols: [] });
    expect(() => relay.close()).not.toThrow();
    expect(() => accepted.socket.close()).not.toThrow();
    controller.close();
  });

  test('closes an upstream socket that accepts after its tunnel request was cancelled', async () => {
    const [relaySocket, controllerSocket] = socketPair();
    let resolveSocket!: (value: any) => void;
    const accepted = new Promise<any>(resolve => { resolveSocket = resolve; });
    const controller = createTunnelPeer(controllerSocket, { webSocket: async () => accepted });
    const relay = createTunnelPeer(relaySocket, {});
    const abort = new AbortController();
    const pending = relay.openWebSocket({ previewId: 'p', path: '/', headers: [], protocols: [], signal: abort.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    let close: [number, string] | undefined;
    resolveSocket({ socket: { send() {}, onMessage() { return () => {}; }, close(code: number, reason: string) { close = [code, reason]; }, onClose() { return () => {}; } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(close?.[0]).toBe(1008);
    relay.close(); controller.close();
  });

  test('rejects a WebSocket message that cannot fit in one tunnel frame', async () => {
    const [relaySocket, controllerSocket] = socketPair();
    let applicationClosed: [number, string] | undefined;
    const application = {
      send() {}, onMessage() { return () => {}; }, close(code: number, reason: string) { applicationClosed = [code, reason]; }, onClose() { return () => {}; },
    };
    const controller = createTunnelPeer(controllerSocket, { webSocket: async () => ({ socket: application }) }, { maxFrameBytes: 1024, maxQueuedBytes: 2048 });
    const relay = createTunnelPeer(relaySocket, {}, { maxFrameBytes: 1024, maxQueuedBytes: 2048 });
    const accepted = await relay.openWebSocket({ previewId: 'p', path: '/', headers: [], protocols: [] });
    accepted.socket.send(new Uint8Array(513), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(applicationClosed?.[0]).toBe(1009);
    relay.close(); controller.close();
  });
});

test('rejects an unread response after disconnect instead of returning a truncated body', async () => {
  const [relaySocket, controllerSocket] = socketPair();
  const controller = createTunnelPeer(controllerSocket, { http: async () => ({ status: 200, headers: [], body: new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(256 * 1024)); },
  }) }) });
  const relay = createTunnelPeer(relaySocket, {});
  try {
    const response = await relay.openHttp({ previewId: 'p', method: 'GET', path: '/', headers: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.close();
    await expect(new Response(response.body).arrayBuffer()).rejects.toMatchObject({ code: 'disconnected' });
  } finally { relay.close(); controller.close(); }
});

test('preserves WebSocket message order while a larger message waits for credit', async () => {
  const [relaySocket, controllerSocket] = socketPair();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const received: number[] = [];
  const application = {
    async send(data: string | Uint8Array) { received.push((data as Uint8Array)[0]!); if (received.length === 1) await held; },
    onMessage() { return () => {}; }, onClose() { return () => {}; }, close() {},
  };
  const controller = createTunnelPeer(controllerSocket, { webSocket: async () => ({ socket: application }) }, { maxFrameBytes: 2048 });
  const relay = createTunnelPeer(relaySocket, {}, { maxFrameBytes: 2048 });
  try {
    const { socket } = await relay.openWebSocket({ previewId: 'p', path: '/', headers: [], protocols: [] });
    const first = socket.send(new Uint8Array(1500).fill(1), true);
    const second = socket.send(new Uint8Array(1500).fill(2), true);
    const third = socket.send(new Uint8Array(10).fill(3), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(received).toEqual([1]); release();
    await Promise.all([first, second, third]);
    await expect.poll(() => received).toEqual([1, 2, 3]);
  } finally { release(); relay.close(); controller.close(); }
});

test('closing a WebSocket releases sends waiting for peer credit', async () => {
  const [relaySocket, controllerSocket] = socketPair();
  const application = { send: async () => new Promise<void>(() => {}), onMessage() { return () => {}; }, onClose() { return () => {}; }, close() {} };
  const controller = createTunnelPeer(controllerSocket, { webSocket: async () => ({ socket: application }) }, { maxFrameBytes: 2048 });
  const relay = createTunnelPeer(relaySocket, {}, { maxFrameBytes: 2048 });
  try {
    const { socket } = await relay.openWebSocket({ previewId: 'p', path: '/', headers: [], protocols: [] });
    const sends = [socket.send(new Uint8Array(1500), true), socket.send(new Uint8Array(1500), true)];
    socket.close(); await Promise.all(sends);
  } finally { relay.close(); controller.close(); }
}, 1000);
