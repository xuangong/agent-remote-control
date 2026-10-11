import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { OpenCodeRequestError, OpenCodeTransport } from './transport.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const requests: Array<{ path: string; authorization?: string }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    if (request.url === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"server.connected","data":{}}\n\n');
      streams.add(response); request.on('close', () => streams.delete(response)); return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/info') { response.end(JSON.stringify({ version: '2.0.25', pid: 42, urls: [], paths: {} })); return; }
    if (request.url === '/api/session/missing') { response.writeHead(404).end(JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: 'missing', message: 'Session was not found.' })); return; }
    if (request.url === '/api/session/broken/prompt') { request.socket.destroy(); return; }
    response.writeHead(500).end(JSON.stringify({ _tag: 'UnknownError', message: 'Unexpected request.' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { for (const response of streams) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const transport = new OpenCodeTransport({ serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, password: 'test-password', requestTimeoutMs: 1000 });
  cleanup.push(() => transport.close());
  return { transport, requests, streams };
}

it('uses the v2 authenticated HTTP API and preserves native not-found errors', async () => {
  const f = await fixture();
  expect(await f.transport.request(() => f.transport.client.server.info())).toMatchObject({ version: '2.0.25' });
  await expect(f.transport.request(() => f.transport.client.session.get({ sessionID: 'missing' }))).rejects.toMatchObject({ status: 404, nativeCode: 'SessionNotFoundError' });
  expect(f.requests.every(item => item.authorization === `Basic ${Buffer.from('opencode:test-password').toString('base64')}`)).toBe(true);
}, 5000);

it('shares one event observation and reconnects without replaying mutations', async () => {
  const f = await fixture(); const one = new AbortController(), two = new AbortController();
  let connected = 0, received = 0;
  const observe = (signal: AbortSignal) => f.transport.events(signal, () => connected++, () => {}, () => received++);
  const first = observe(one.signal), second = observe(two.signal);
  await expect.poll(() => received).toBe(2);
  expect(f.requests.filter(item => item.path === '/api/event')).toHaveLength(1);
  for (const stream of f.streams) stream.destroy();
  await expect.poll(() => connected).toBe(4);
  one.abort(); two.abort(); await Promise.all([first, second]);
  await expect(f.transport.request(() => f.transport.client.session.prompt({ sessionID: 'broken', text: 'Only once' }))).rejects.toBeInstanceOf(OpenCodeRequestError);
  expect(f.requests.filter(item => item.path === '/api/session/broken/prompt')).toHaveLength(1);
}, 5000);
