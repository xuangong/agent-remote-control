import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import { createTunnelPeer, type TunnelData, type TunnelSocket } from '../index.js';
import { canonicalizeLoopbackTarget, createLoopbackTunnelHandlers } from './index.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function server(handler: Parameters<typeof createServer>[0]) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => instance.close(() => resolve())));
  return { instance, port: (instance.address() as { port: number }).port };
}

function socketPair(): [TunnelSocket, TunnelSocket] {
  const messages: [Set<(data: TunnelData) => void>, Set<(data: TunnelData) => void>] = [new Set(), new Set()];
  const closes: [Set<(code: number, reason: string) => void>, Set<(code: number, reason: string) => void>] = [new Set(), new Set()];
  return [0, 1].map(index => ({
    send(data: TunnelData) { queueMicrotask(() => messages[1 - index]!.forEach(listener => listener(data))); },
    onMessage(listener: (data: TunnelData) => void) { messages[index]!.add(listener); return () => messages[index]!.delete(listener); },
    close(code = 1000, reason = '') { closes[index]!.forEach(listener => listener(code, reason)); closes[1 - index]!.forEach(listener => listener(code, reason)); },
    onClose(listener: (code: number, reason: string) => void) { closes[index]!.add(listener); return () => closes[index]!.delete(listener); },
  })) as [TunnelSocket, TunnelSocket];
}

describe('loopback forwarding', () => {
  test('preserves binary request and response bytes', async () => {
    const target = await server((request, response) => request.pipe(response));
    const handlers = createLoopbackTunnelHandlers({ lookup: () => ({ target: `http://127.0.0.1:${target.port}`, pathMode: 'strip' }) });
    const body = new Uint8Array([0, 255, 1, 128]);
    const result = await handlers.http!({ previewId: 'p', method: 'POST', path: '/echo', headers: [], body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }) }, { signal: new AbortController().signal });
    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(body);
  });

  test('returns an SSE event before the upstream response ends', async () => {
    const target = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ready\n\n');
      setTimeout(() => response.end('data: done\n\n'), 150);
    });
    const handlers = createLoopbackTunnelHandlers({ lookup: () => ({ target: `http://127.0.0.1:${target.port}`, pathMode: 'strip' }) });
    const result = await handlers.http!({ previewId: 'p', method: 'GET', path: '/', headers: [] }, { signal: new AbortController().signal });
    const reader = result.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: ready\n\n');
    await reader.cancel();
  });

  test('aborts the upstream request when the relay cancels', async () => {
    let closed = false;
    let arrived!: () => void;
    const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
    const target = await server((request) => { arrived(); request.on('close', () => { closed = true; }); });
    const controller = new AbortController();
    const handlers = createLoopbackTunnelHandlers({ lookup: () => ({ target: `http://127.0.0.1:${target.port}`, pathMode: 'strip' }) });
    const pending = handlers.http!({ previewId: 'p', method: 'GET', path: '/', headers: [] }, { signal: controller.signal });
    await requestArrived;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(true);
  });

  test('accepts WS only after handshake and preserves protocol, text, binary and close', async () => {
    const target = await server();
    const wss = new WebSocketServer({ server: target.instance, handleProtocols: protocols => protocols.has('vite-hmr') ? 'vite-hmr' : false });
    wss.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })).on('close', (code, reason) => { void code; void reason; }));
    const handlers = createLoopbackTunnelHandlers({ lookup: () => ({ target: `http://127.0.0.1:${target.port}`, pathMode: 'strip' }) });
    const accepted = await handlers.webSocket!({ previewId: 'p', path: '/', headers: [], protocols: ['vite-hmr'] }, { signal: new AbortController().signal });
    expect(accepted.protocol).toBe('vite-hmr');
    const messages: Array<{ data: string | Uint8Array; binary: boolean }> = [];
    accepted.socket.onMessage((data, binary) => messages.push({ data, binary }));
    accepted.socket.send('hello', false);
    accepted.socket.send(new Uint8Array([4, 5]), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages).toEqual([{ data: 'hello', binary: false }, { data: new Uint8Array([4, 5]), binary: true }]);
    accepted.socket.close(1000, 'done');
  });

  test('carries a real loopback WS through the portable peer', async () => {
    const target = await server();
    const wss = new WebSocketServer({ server: target.instance, handleProtocols: protocols => protocols.has('chat') ? 'chat' : false });
    wss.on('connection', socket => { socket.send('welcome'); socket.on('message', (data, binary) => socket.send(data, { binary })); });
    const [relaySocket, controllerSocket] = socketPair();
    const controller = createTunnelPeer(controllerSocket, createLoopbackTunnelHandlers({ lookup: () => ({ target: `http://127.0.0.1:${target.port}`, pathMode: 'strip' }) }));
    const relay = createTunnelPeer(relaySocket, {});
    const accepted = await relay.openWebSocket({ previewId: 'p', path: '/events', headers: [], protocols: ['chat'] });
    expect(accepted.protocol).toBe('chat');
    const welcome = new Promise<{ data: string | Uint8Array; binary: boolean }>(resolve => accepted.socket.onMessage((data, binary) => resolve({ data, binary })));
    expect(await welcome).toEqual({ data: 'welcome', binary: false });
    const echoed = new Promise<{ data: string | Uint8Array; binary: boolean }>(resolve => accepted.socket.onMessage((data, binary) => resolve({ data, binary })));
    accepted.socket.send(new Uint8Array([8, 9]), true);
    expect(await echoed).toEqual({ data: new Uint8Array([8, 9]), binary: true });
    accepted.socket.close(); relay.close(); controller.close();
  });

  test('rejects unsafe methods, paths and header values before forwarding', async () => {
    const handlers = createLoopbackTunnelHandlers({ lookup: () => ({ target: 'http://127.0.0.1:5173', pathMode: 'strip' }) });
    const signal = new AbortController().signal;
    await expect(handlers.http!({ previewId: 'p', method: 'CONNECT', path: '/', headers: [] }, { signal })).rejects.toThrow(/method/i);
    await expect(handlers.http!({ previewId: 'p', method: 'GET', path: 'http://evil.test/', headers: [] }, { signal })).rejects.toThrow(/path/i);
    await expect(handlers.http!({ previewId: 'p', method: 'GET', path: '/', headers: [['x-test', 'ok\r\ninjected: yes']] }, { signal })).rejects.toThrow(/header/i);
  });

  test('allows only canonical loopback targets and protected ports', () => {
    expect(canonicalizeLoopbackTarget('http://localhost:5173/path')).toBe('http://127.0.0.1:5173');
    expect(canonicalizeLoopbackTarget('http://[::1]:5173/path')).toBe('http://[::1]:5173');
    expect(canonicalizeLoopbackTarget('http://127.0.0.1:80/path')).toBe('http://127.0.0.1');
    expect(() => canonicalizeLoopbackTarget('http://user@127.0.0.1:5173')).toThrow(/userinfo/i);
    expect(() => canonicalizeLoopbackTarget('http://192.168.1.2:5173')).toThrow(/loopback/i);
    expect(() => canonicalizeLoopbackTarget('http://127.0.0.1:9999', { protectedPorts: [9999] })).toThrow(/protected/i);
  });
});
