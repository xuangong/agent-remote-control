import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { OpenCodeAgentProvider } from './provider.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('persists explicit creation model and planning selections on the native session', async () => {
  const cwd = process.cwd();
  const native = { id: 'created', directory: cwd, title: 'Created', time: { created: 1, updated: 1 } };
  const writes: Array<{ path: string; body: unknown }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (path === '/global/event') {
      streams.add(response); response.on('close', () => streams.delete(response));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(`data: ${JSON.stringify({ directory: cwd, payload: { type: 'server.connected', properties: {} } })}\n\n`); return;
    }
    let raw = ''; for await (const part of request) raw += part;
    if (request.method === 'POST') writes.push({ path, body: JSON.parse(raw || '{}') });
    if (path === '/session' || path === '/session/created') return json(native);
    if (path === '/provider') return json({ connected: ['test'], default: {}, all: [{ id: 'test', name: 'Test', models: { model: { id: 'model', name: 'Model', limit: { context: 10000, output: 1000 } } } }] });
    if (path === '/agent') return json(['plan', 'build'].map(name => ({ name, mode: 'primary', permission: [] })));
    if (/^\/api\/session\/created\/(model|agent)$/.test(path)) { response.writeHead(204).end(); return; }
    if (path === '/session/status') return json({});
    if (['/permission', '/question', '/session/created/message', '/session/created/todo', '/session/created/children'].includes(path)) return json([]);
    return json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const provider = new OpenCodeAgentProvider({ serverUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` });
  cleanups.push(() => provider.close());
  await provider.createSession({ sessionId: 'requested', cwd, model: 'test/model', planning: true });
  expect(writes).toContainEqual({ path: '/api/session/created/model', body: { model: { providerID: 'test', id: 'model' } } });
  expect(writes).toContainEqual({ path: '/api/session/created/agent', body: { agent: 'plan' } });
}, 10000);

test('rejects a malformed persisted model variant before native access', async () => {
  const provider = new OpenCodeAgentProvider({ serverUrl: 'http://127.0.0.1:1' });
  cleanups.push(() => provider.close());
  await expect(provider.resumeSession({ providerId: 'opencode', sessionId: 'native', opaque: JSON.stringify({ cwd: process.cwd(), variant: 4 }) })).rejects.toThrow('Invalid OpenCode persistence handle.');
}, 10000);
