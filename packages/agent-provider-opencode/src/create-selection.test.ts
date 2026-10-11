import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { SessionInfo } from '@opencode/client';
import { OpenCodeAgentProvider } from './provider.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('persists explicit creation model and planning selections on the native session', async () => {
  const cwd = process.cwd();
  const native: SessionInfo = { id: 'created', projectID: 'project', location: { directory: cwd }, title: 'Created', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } };
  const writes: Array<{ path: string; body: unknown }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (path === '/api/event') {
      streams.add(response); response.on('close', () => streams.delete(response));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"type":"server.connected","data":{}}\n\n'); return;
    }
    let raw = ''; for await (const part of request) raw += part;
    if (request.method === 'POST') writes.push({ path, body: JSON.parse(raw || '{}') });
    if (path === '/api/session' && request.method === 'POST' || path === '/api/session/created') return json({ data: native });
    if (path === '/api/model') return json({ location: { directory: cwd }, data: [{ providerID: 'test', id: 'model', modelID: 'model', name: 'Model', enabled: true, variants: [], limit: { context: 10000, output: 1000 } }] });
    if (path === '/api/agent') return json({ location: { directory: cwd }, data: ['plan', 'build'].map(name => ({ id: name, name, mode: 'primary', hidden: false, permissions: [] })) });
    if (/^\/api\/session\/created\/(model|agent)$/.test(path)) { Object.assign(native, JSON.parse(raw)); response.writeHead(204).end(); return; }
    if (path === '/api/session/active') return json({ data: {} });
    if (['/api/permission/request', '/api/form'].includes(path)) return json({ location: { directory: cwd }, data: [] });
    if (['/api/session', '/api/session/created/message'].includes(path)) return json({ data: [], cursor: {} });
    if (path === '/api/session/created/inbox') return json({ data: [] });
    return json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const provider = new OpenCodeAgentProvider({ serverUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` });
  cleanups.push(() => provider.close());
  await provider.createSession({ sessionId: 'requested', cwd, model: 'test/model', planning: true });
  expect(writes).toContainEqual({ path: '/api/session/created/model', body: { model: { providerID: 'test', id: 'model' } } });
  expect(writes).toContainEqual({ path: '/api/session/created/agent', body: { agent: 'plan' } });
  expect(native.model).toEqual({ providerID: 'test', id: 'model' });
  expect(native.agent).toBe('plan');
}, 10000);

test('rejects a malformed persisted model variant before native access', async () => {
  const provider = new OpenCodeAgentProvider({ serverUrl: 'http://127.0.0.1:1' });
  cleanups.push(() => provider.close());
  await expect(provider.resumeSession({ providerId: 'opencode', sessionId: 'native', opaque: JSON.stringify({ cwd: process.cwd(), variant: 4 }) })).rejects.toThrow('Invalid OpenCode persistence handle.');
}, 10000);
