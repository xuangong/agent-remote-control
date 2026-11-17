import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { startLatencyProxy, type LatencyProxy } from './latency-proxy.mjs';

interface Upstream { origin: string; seenOrigins: string[]; seenHosts: string[]; close(): Promise<void> }

async function startUpstream(): Promise<Upstream> {
  const seenOrigins: string[] = [];
  const seenHosts: string[] = [];
  const server = http.createServer((request, response) => {
    seenOrigins.push(String(request.headers.origin));
    seenHosts.push(String(request.headers.host));
    if (request.url === '/redirect') { response.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/landed` }); response.end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end(`echo:${Buffer.concat(chunks).toString()}`); });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => { seenOrigins.push(String(request.headers.origin)); socket.on('message', data => socket.send(`echo:${String(data)}`)); });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://localhost:${port}`, seenOrigins, seenHosts, async close() { sockets.clients.forEach(client => client.terminate()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const item of open.splice(0)) await item.close(); });

async function setup(rttMs: number): Promise<{ upstream: Upstream; proxy: LatencyProxy }> {
  const upstream = await startUpstream();
  const proxy = await startLatencyProxy({ target: upstream.origin, rttMs });
  open.push(upstream, proxy);
  return { upstream, proxy };
}

describe('the latency proxy', () => {
  it('adds one round trip to an HTTP exchange and passes the body both ways', async () => {
    const { proxy } = await setup(200);
    const started = Date.now();
    const response = await fetch(`${proxy.origin}/echo`, { method: 'POST', body: 'ping' });
    const elapsed = Date.now() - started;
    expect(await response.text()).toBe('echo:ping');
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(600);
  });

  it('rewrites the browser origin and host to the target and the redirect back to the proxy', async () => {
    const { upstream, proxy } = await setup(0);
    const location = await new Promise<string | undefined>((resolve, reject) => {
      http.get(`${proxy.origin}/redirect`, { headers: { origin: proxy.origin } }, response => { response.resume(); resolve(response.headers.location); }).on('error', reject);
    });
    expect(upstream.seenOrigins).toEqual([new URL(upstream.origin).origin]);
    expect(upstream.seenHosts).toEqual([new URL(upstream.origin).host]);
    expect(location).toBe(`${proxy.origin}/landed`);
  });

  it('delays WebSocket frames in both directions, counts the upgrade and closes every socket on request', async () => {
    const { proxy } = await setup(200);
    const socket = new WebSocket(proxy.origin.replace('http', 'ws'), { origin: proxy.origin });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    expect(proxy.counts.webSocketsCrossed).toBe(1);
    const started = Date.now();
    const reply = await new Promise<string>(resolve => { socket.once('message', data => resolve(String(data))); socket.send('hello'); });
    const elapsed = Date.now() - started;
    expect(reply).toBe('echo:hello');
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(700);
    const closed = new Promise(resolve => socket.once('close', resolve));
    proxy.closeWebSockets();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('the network conditions of the proxy', () => {
  async function conditioned(conditions: Parameters<typeof startLatencyProxy>[0] extends infer O ? Partial<O> : never) {
    const upstream = await startUpstream();
    const proxy = await startLatencyProxy({ target: upstream.origin, rttMs: 0, ...conditions });
    open.push(upstream, proxy);
    return { upstream, proxy };
  }
  const connect = async (proxy: LatencyProxy) => {
    const socket = new WebSocket(proxy.origin.replace('http', 'ws'), { origin: proxy.origin });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return socket;
  };
  const echo = (socket: WebSocket, text: string, waitMs = 1500) => new Promise<string | undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), waitMs);
    socket.once('message', data => { clearTimeout(timer); resolve(String(data)); });
    socket.send(text);
  });

  it('holds back a lost chunk by retransmission timeouts that double', async () => {
    const { proxy } = await conditioned({ lossRate: 1, retransmitTimeoutMs: 2 });
    const started = Date.now();
    const response = await fetch(`${proxy.origin}/echo`, { method: 'POST', body: 'ping' });
    expect(await response.text()).toBe('echo:ping');
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
    expect(proxy.counts.retransmits).toBeGreaterThanOrEqual(12);
  });

  it('adds jitter on top of the round trip without reordering frames', async () => {
    const { proxy } = await conditioned({ rttMs: 20, jitterMs: 80, seed: 3 });
    const socket = await connect(proxy);
    const seen: string[] = [];
    socket.on('message', data => seen.push(String(data)));
    for (let at = 0; at < 8; at += 1) socket.send(`m${at}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(seen).toEqual(Array.from({ length: 8 }, (_, at) => `echo:m${at}`));
  });

  it('serializes bytes through a bandwidth cap', async () => {
    const { proxy } = await conditioned({ bandwidthBytesPerSec: 40_000 });
    const started = Date.now();
    const response = await fetch(`${proxy.origin}/echo`, { method: 'POST', body: 'b'.repeat(10_000) });
    expect((await response.text()).length).toBe(10_005);
    expect(Date.now() - started).toBeGreaterThanOrEqual(480);
  });

  it('leaves a half-open socket open while it swallows traffic, and lets a new socket work', async () => {
    const { proxy } = await conditioned({});
    const socket = await connect(proxy);
    expect(await echo(socket, 'before')).toBe('echo:before');
    expect(proxy.halfOpenWebSockets()).toBe(1);
    expect(await echo(socket, 'after', 300)).toBeUndefined();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(proxy.counts.dropped).toBeGreaterThan(0);
    const fresh = await connect(proxy);
    expect(await echo(fresh, 'again')).toBe('echo:again');
  });

  it('tees each WebSocket text message with its direction and reports sockets opening and closing', async () => {
    const taps: Array<{ connection: number; direction: string; text: string }> = [];
    const events: string[] = [];
    const { upstream, proxy } = await conditioned({ tap: message => taps.push(message), onSocket: ({ event }) => events.push(event) });
    const socket = await connect(proxy);
    await echo(socket, 'hello');
    proxy.closeWebSockets();
    await new Promise(resolve => socket.once('close', resolve));
    expect(taps).toEqual([{ t: expect.any(Number), connection: 1, direction: 'browser->relay', text: 'hello' }, { t: expect.any(Number), connection: 1, direction: 'relay->browser', text: 'echo:hello' }]);
    expect(events).toEqual(['open', 'close']);
    expect(upstream.seenOrigins.length).toBeGreaterThan(0);
  });

  it('closes sockets and refuses new connections while offline, and recovers', async () => {
    const { proxy } = await conditioned({});
    const socket = await connect(proxy);
    const closed = new Promise(resolve => socket.once('close', resolve));
    proxy.setOffline(true);
    await closed;
    await expect(fetch(`${proxy.origin}/echo`, { method: 'POST', body: 'x' })).rejects.toThrow();
    proxy.setOffline(false);
    expect(await (await fetch(`${proxy.origin}/echo`, { method: 'POST', body: 'x' })).text()).toBe('echo:x');
  });

  it('changes conditions while running', async () => {
    const { proxy } = await conditioned({});
    proxy.setConditions({ rttMs: 150 });
    const started = Date.now();
    await (await fetch(`${proxy.origin}/echo`, { method: 'POST', body: 'x' })).text();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(proxy.conditions().rttMs).toBe(150);
  });
});
