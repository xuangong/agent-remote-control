import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OpenCodeAgentProvider } from '@orchardworks/agent-provider-opencode';
import { createAgentHostRuntime } from './host.js';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import { SessionSuccessionStore } from './session-succession-store.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); }, 5000);
async function fixture(first: boolean) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'arc-native-prefix-recovery-')));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'opencode', nativeSessionId });
  const store = new SessionSuccessionStore(join(cwd, 'roles')); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: cwd } });
  const source = [
    { id: 'first', type: 'user', text: 'Keep', time: { created: 1 } },
    { id: 'first-idle', type: 'idle', outcome: 'succeeded', time: { created: 2 } },
    { id: 'later', type: 'user', text: 'Edit', time: { created: 3 } },
    { id: 'later-idle', type: 'idle', outcome: 'succeeded', time: { created: 4 } },
  ];
  let candidate: typeof source = [], forks = 0, failReads = true, failHistory: string | undefined, corrupt = false;
  const beforeFailures: unknown[] = [], writes: string[] = [], streams = new Set<ServerResponse>();
  const info = (id: string) => ({ id, location: { directory: cwd }, title: id, projectID: 'project', agent: 'build', model: { providerID: 'test', id: 'model' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } });
  const disk = async () => JSON.parse(await readFile(join(cwd, 'roles', 'state.json'), 'utf8'));
  const native = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, 'http://localhost');
    const json = (body: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url.pathname === '/api/event') { response.writeHead(200, { 'content-type': 'text/event-stream' }); streams.add(response); response.on('close', () => streams.delete(response)); response.write('data: {"type":"server.connected","data":{}}\n\n'); return; }
    let raw = ''; for await (const part of request) raw += part;
    if (request.method !== 'GET') writes.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/session/active') return json({ data: {} });
    if (['/api/permission/request', '/api/form', '/api/plugin'].includes(url.pathname)) return json({ location: { directory: cwd }, data: [] });
    if (url.pathname === '/api/model') return json({ location: { directory: cwd }, data: [{ providerID: 'test', id: 'model', modelID: 'model', name: 'Model', enabled: true, status: 'active', capabilities: {}, variants: [], limit: { context: 1000, output: 100 } }] });
    if (url.pathname === '/api/agent') return json({ location: { directory: cwd }, data: [{ id: 'build', name: 'build', mode: 'primary', hidden: false, permissions: [], request: {} }] });
    if (url.pathname === '/api/session') return json({ data: url.searchParams.has('parentID') ? [] : [info('A'), ...(forks ? [info('B')] : [])], cursor: {} });
    const match = /^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json({ message: `Unexpected ${url.pathname}` }, 404);
    const [, id, operation] = match;
    if (!operation) {
      if (id === 'B' && failReads) { beforeFailures.push(await disk()); return json({ message: 'Temporary read failure' }, 503); }
      return json({ data: info(id!) });
    }
    if (['permission', 'form', 'inbox', 'instructions/entries'].includes(operation)) return json({ data: [] });
    if (operation === 'message') {
      if (id === failHistory) return json({ message: 'Temporary history failure' }, 503);
      const history = id === 'A' ? source : corrupt ? source : candidate;
      const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit'));
      return json({ data: [...history].reverse().slice(offset, offset + limit), cursor: offset + limit < history.length ? { next: String(offset + limit) } : {} });
    }
    if (operation === 'fork' && request.method === 'POST') { forks++; const before = JSON.parse(raw).before; candidate = structuredClone(source.slice(0, source.findIndex(message => message.id === before))); return json({ data: info('B') }); }
    return json({ message: `Unexpected ${operation}` }, 404);
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const stream of streams) stream.destroy(); native.closeAllConnections(); await new Promise<void>(resolve => native.close(() => resolve())); });
  const serverUrl = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
  const make = () => { const provider = new OpenCodeAgentProvider({ serverUrl, requestTimeoutMs: 1000 }); return createAgentHostRuntime({ succession: { controllerId: 'host', stateDirectory: cwd }, registrations: [{ directory: createOpenCodeSessionDirectory(provider, []), adapter: provider }] }); };
  let host = make(); cleanups.push(() => host.close());
  const http = createServer((request, response) => { void (async () => { let body = ''; for await (const part of request) body += part; const result = await host.control({ method: 'POST', path: request.url!, body }); response.writeHead(result.status); response.end(result.body); })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const post = async (path: string, value: unknown) => { const response = await fetch(origin + path, { method: 'POST', body: JSON.stringify(value), signal: AbortSignal.timeout(4000) }); return { status: response.status, data: await response.json() }; };
  const selection = first ? 'first' : 'later';
  const request = { operationId: 'prefix', roleId: 'role', expectedRevision: 1, from: ref('A'), preparation: { kind: 'native_prefix', turnId: selection, messageId: selection } };
  return { cwd, ref, disk, request, post, beforeFailures, writes, forks: () => forks, fail: (value: boolean) => { failReads = value; }, failHistory: (id?: string) => { failHistory = id; }, corrupt: () => { corrupt = true; }, restart: async () => { await host.close(); host = make(); }, fence: (id: string) => host.executionRouting!.assertCurrent(ref(id), ref(id)) };
}

test.each([true, false])('OpenCode first=%s saves the candidate before failed HTTP readback and recovers without another fork', async first => {
  const f = await fixture(first);
  expect(await f.post('/remote/succession/prepare', f.request)).toMatchObject({ status: 200, data: { phase: 'unknown', to: f.ref('B') } });
  expect(f.beforeFailures.length).toBeGreaterThan(0);
  expect(f.beforeFailures[0]).toMatchObject({ roles: [{ localPreparations: [{ stage: 'candidate-known', nativePrefix: { handle: { providerId: 'opencode', sessionId: 'B', opaque: JSON.stringify({ cwd: f.cwd }) } } }] }] });
  for (const id of ['A', 'B']) expect(() => f.fence(id)).toThrow(/reserved/);
  expect((await f.post('/remote/succession/commit', { operationId: 'prefix', expectedRevision: 1 })).status).toBe(409);
  f.fail(false);
  f.failHistory('B');
  expect(await f.post('/remote/succession/reconcile', { operationId: 'prefix' })).toMatchObject({ status: 200, data: { phase: 'unknown', to: f.ref('B') } });
  for (const id of ['A', 'B']) expect(() => f.fence(id)).toThrow(/reserved/);
  f.failHistory('A');
  expect(await f.post('/remote/succession/reconcile', { operationId: 'prefix' })).toMatchObject({ status: 200, data: { phase: 'unknown', to: f.ref('B') } });
  for (const id of ['A', 'B']) expect(() => f.fence(id)).toThrow(/reserved/);
  f.failHistory();
  const ready = await f.post('/remote/succession/reconcile', { operationId: 'prefix' });
  expect(ready, JSON.stringify(ready)).toMatchObject({ status: 200, data: { phase: 'ready', to: f.ref('B') } });
  expect(f.forks()).toBe(1); expect(f.writes).toEqual(['POST /api/session/A/fork']);
}, 15000);

test.each([true, false])('OpenCode first=%s restart retains the candidate and rejects changed source epoch without re-forking', async first => {
  const f = await fixture(first);
  expect((await f.post('/remote/succession/prepare', f.request)).data).toMatchObject({ phase: 'unknown', to: f.ref('B') });
  const original = (await f.disk()).roles[0].localPreparations[0];
  await f.restart(); f.fail(false);
  const recovered = await f.post('/remote/succession/reconcile', { operationId: 'prefix' });
  expect(recovered).toMatchObject({ status: 200, data: { phase: 'rejected', failureCode: 'succession_boundary_changed', to: f.ref('B') } });
  expect((await f.disk()).roles[0].localPreparations[0].nativePrefix).toEqual(original.nativePrefix);
  expect((await f.disk()).roles[0].localPreparations[0].capture).toEqual(original.capture);
  expect(f.forks()).toBe(1); expect(f.writes).toEqual(['POST /api/session/A/fork']);
}, 15000);

test('OpenCode complete prefix mismatch remains rejected with the exact candidate saved', async () => {
  const f = await fixture(false); f.fail(false); f.corrupt();
  expect((await f.post('/remote/succession/prepare', f.request)).data).toMatchObject({ phase: 'rejected', to: f.ref('B') });
  expect((await f.disk()).roles[0].localPreparations[0]).toMatchObject({ stage: 'candidate-known', nativePrefix: { handle: { sessionId: 'B' } } });
  expect(f.forks()).toBe(1);
}, 15000);
