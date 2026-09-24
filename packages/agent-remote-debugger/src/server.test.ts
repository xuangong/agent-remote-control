import { spawnSync } from 'node:child_process';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { createDebuggerServer } from './server.js';
import { createRecordedLabProvider } from '../../agent-remote-lab/src/server/recorded.js';
import { createDebuggerRuntime, type DebuggerRuntime } from './runtime.js';

beforeAll(() => {
  const build = spawnSync(process.execPath, ['scripts/build-web.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30000 });
  expect(build.status, build.stderr).toBe(0);
}, 35000);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

it('serves one product Session View and shares its Relay with headless clients', async () => {
  const { provider } = createRecordedLabProvider();
  let creates = 0;
  const server = await createDebuggerServer({ assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), adapter: { ...provider, createSession: config => { creates++; return provider.createSession(config); } } });
  cleanups.push(() => server.close());
  expect(await (await fetch(server.url)).text()).toContain('ARDB Session View');
  const bootstrap = await (await fetch(`${server.url}/__ardb/session`)).json();
  expect(bootstrap.agentId).toBe(server.agentId);
  expect((await fetch(`${server.url}/index.js`)).status).toBe(200);
  const clients: DebuggerRuntime[] = [];
  for (let index = 0; index < 2; index++) {
    const runtime = await createDebuggerRuntime(server.agentId, { relayUrl: server.url, origin: server.url });
    cleanups.push(() => runtime.close()); clients.push(runtime); await runtime.ready(3000);
  }
  await clients[0]!.client.sendMessage('from headless');
  await expect.poll(() => JSON.stringify(clients[1]!.replica.getState().timeline)).toContain('Recorded reply: from headless');
  clients[1]!.close();
  const reconnected = await createDebuggerRuntime(server.agentId, { relayUrl: server.url, origin: server.url });
  cleanups.push(() => reconnected.close()); await reconnected.ready(3000);
  expect(JSON.stringify(reconnected.replica.getState().timeline)).toContain('Recorded reply: from headless');
  await fetch(`${server.url}/__ardb/session`);
  expect(creates).toBe(1);
}, 15000);

it('rejects foreign origins, rebinding hosts and browser session creation', async () => {
  const { provider } = createRecordedLabProvider();
  const server = await createDebuggerServer({ assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), adapter: provider });
  cleanups.push(() => server.close());
  expect((await fetch(server.url, { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
  expect(await new Promise(resolve => { get(server.url, { headers: { Host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); })).toBe(403);
  expect((await fetch(`${server.url}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect((await fetch(`${server.url}/__ardb/session`)).status).toBe(200);
}, 10000);

it('disposes a session interrupted before its history boundary, and disposes its provider once', async () => {
  const { provider } = createRecordedLabProvider();
  const abort = new AbortController();
  let sessionDisposals = 0, providerDisposals = 0;
  let release: () => void = () => {};
  const ended = new Promise<void>(resolve => { release = resolve; });
  const starting = createDebuggerServer({
    assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), signal: abort.signal,
    adapter: { ...provider, async createSession(config) {
      const session = await provider.createSession(config);
      const stream = async function* () { queueMicrotask(() => abort.abort(new Error('Test interruption'))); await ended; };
      return new Proxy(session, { get(target, key) {
        if (key === 'observe') return stream;
        if (key === 'dispose') return async () => { sessionDisposals++; release(); await session.dispose(); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }, async dispose() { providerDisposals++; } },
  });
  await expect(starting).rejects.toThrow('Test interruption');
  expect(sessionDisposals).toBe(1); expect(providerDisposals).toBe(1);
}, 10000);

it('bounds browser diagnostic payloads and omits untrusted content', async () => {
  const { provider } = createRecordedLabProvider();
  const events: Record<string, unknown>[] = [];
  const server = await createDebuggerServer({ assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), adapter: provider, onBrowserEvent: event => events.push(event) });
  cleanups.push(() => server.close());
  const post = (body: string) => fetch(`${server.url}/__ardb/events`, { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body });
  expect((await post(JSON.stringify([{ event: 'protocol', messageType: 'interaction_response', payload: { secret: 'must not log' }, source: 'relay' }]))).status).toBe(204);
  expect(events).toHaveLength(1); expect(events[0]!.source).toBe('browser'); expect(JSON.stringify(events)).not.toContain('must not log');
  expect((await post('[')).status).toBe(400);
  expect((await post(JSON.stringify(Array(65).fill({})))).status).toBe(400);
  expect((await post(JSON.stringify([{ text: 'x'.repeat(65536) }]))).status).toBe(413);
}, 10000);

it('replays captured state on a read-only loopback server without a Relay or native session', async () => {
  const { createReplayServer } = await import('./replay-server.js');
  const { observeReplica } = await import('./records.js');
  const { parseRecording } = await import('./recording.js');
  const { provider } = createRecordedLabProvider();
  const live = await createDebuggerServer({ assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), adapter: provider });
  cleanups.push(() => live.close());
  const runtime = await createDebuggerRuntime(live.agentId, { relayUrl: live.url, origin: live.url });
  cleanups.push(() => runtime.close());
  await runtime.ready(3000);
  const records: string[] = [];
  const stop = observeReplica(live.agentId, runtime.replica, runtime.client, record => records.push(JSON.stringify(record)));
  await runtime.client.sendMessage('Recorded for replay');
  await expect.poll(() => records.join('\n')).toContain('Recorded reply: Recorded for replay');
  stop(); runtime.close(); await live.close();
  const replay = await createReplayServer({ recording: parseRecording(records.join('\n')), name: 'session.jsonl', assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)) });
  cleanups.push(() => replay.close());
  expect(await (await fetch(replay.url)).text()).toContain('ARDB Session View');
  expect(await (await fetch(`${replay.url}/__ardb/session`)).json()).toMatchObject({ mode: 'replay', name: 'session.jsonl' });
  expect(await (await fetch(`${replay.url}/__ardb/recording`)).text()).toContain('Recorded reply: Recorded for replay');
  expect((await fetch(`${replay.url}/v1/sessions`, { method: 'POST' })).status).toBe(405);
  expect((await fetch(`${replay.url}/v1/agents/${live.agentId}`)).status).toBe(404);
  expect((await fetch(`${replay.url}/__ardb/recording`, { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
  expect(await new Promise(resolve => { get(replay.url, { headers: { Host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); })).toBe(403);
}, 15000);
