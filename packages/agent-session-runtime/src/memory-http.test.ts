import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { memoryHttp, type MemoryHttp } from './memory-http.js';

const open: MemoryHttp[] = [];
afterEach(() => { for (const net of open.splice(0)) net.close(); });

function network(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  const net = memoryHttp(server);
  open.push(net);
  return { server, net };
}

it('serves a request through the server handler: method, path with query, headers and body arrive; status, headers and body come back', async () => {
  const seen: unknown[] = [];
  const { net } = network(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method, url: request.url, type: request.headers['content-type'], body });
    response.writeHead(201, { 'content-type': 'application/json', 'x-reply': 'yes' }).end(JSON.stringify({ ok: true }));
  });
  const reply = await net.fetch(`${net.url}/v1/items?limit=2`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
  expect(reply.status).toBe(201);
  expect(reply.headers.get('x-reply')).toBe('yes');
  expect(await reply.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ method: 'POST', url: '/v1/items?limit=2', type: 'text/plain', body: 'hello' }]);
});

it('answers a bodiless status without a body and accepts a Request', async () => {
  const { net } = network((_request, response) => { response.writeHead(204).end(); });
  const reply = await net.fetch(new Request('http://memory.test/x', { method: 'DELETE' }));
  expect(reply.status).toBe(204);
  expect(await reply.text()).toBe('');
});

it('fails the call as a dropped connection does when the server destroys the reply', async () => {
  const { net } = network((_request, response) => { response.destroy(); });
  await expect(net.fetch(`${net.url}/x`)).rejects.toThrow(TypeError);
});

it('ends a call the caller aborts with the abort reason', async () => {
  const { net } = network(() => { /* never answers */ });
  const controller = new AbortController();
  const call = net.fetch(`${net.url}/x`, { signal: controller.signal });
  controller.abort(new Error('stop'));
  await expect(call).rejects.toThrow('stop');
});

it('upgrades a WebSocket with the client origin and headers, delivers frames both ways and ends both sides on close', async () => {
  const { server, net } = network();
  const sockets = new WebSocketServer({ server });
  const upgrades: unknown[] = [];
  sockets.on('connection', (socket, request) => {
    upgrades.push({ url: request.url, origin: request.headers.origin, subject: request.headers['x-subject'] });
    socket.on('message', data => socket.send(`echo:${data}`));
    socket.on('close', (code, reason) => upgrades.push({ closed: code, reason: String(reason) }));
  });
  const client = net.webSocket('ws://memory.test/v1/events?x=1', { origin: 'http://app.test', headers: { 'x-subject': 'owner' } });
  const received = new Promise<string>(resolve => client.once('message', data => resolve(String(data))));
  await new Promise<void>(resolve => client.once('open', () => resolve()));
  client.send('one');
  expect(await received).toBe('echo:one');
  const closed = new Promise<number>(resolve => client.once('close', code => resolve(code)));
  client.close(1000, 'done');
  expect(await closed).toBe(1000);
  await new Promise(resolve => setTimeout(resolve, 1));
  expect(upgrades).toEqual([{ url: '/v1/events?x=1', origin: 'http://app.test', subject: 'owner' }, { closed: 1000, reason: 'done' }]);
});

it('reports a refused upgrade to the client as an unexpected response', async () => {
  const { server, net } = network();
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); });
  const client = net.webSocket('ws://memory.test/v1/events');
  const status = await new Promise<number | undefined>(resolve => client.once('unexpected-response', (_request, response) => resolve(response.statusCode)));
  expect(status).toBe(401);
});

it('ends every open connection on close, as a lost network does', async () => {
  const { server, net } = network();
  const sockets = new WebSocketServer({ server });
  const serverClosed = new Promise<void>(resolve => sockets.on('connection', socket => socket.on('close', () => resolve())));
  const client = net.webSocket('ws://memory.test/v1/events');
  const clientClosed = new Promise<number>(resolve => client.once('close', code => resolve(code)));
  await new Promise<void>(resolve => client.once('open', () => resolve()));
  net.close();
  expect(await clientClosed).toBe(1006);
  await serverClosed;
});
