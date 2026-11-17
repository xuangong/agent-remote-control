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
