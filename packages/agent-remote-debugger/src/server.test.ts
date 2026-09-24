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

it('records a shared session across browser reloads and exports a complete replay without stopping the Agent', async () => {
  const { parseRecording, RecordingPlayer } = await import('./recording.js');
  const { provider } = createRecordedLabProvider();
  const server = await createDebuggerServer({ assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), adapter: provider });
  cleanups.push(() => server.close());
  const runtime = await createDebuggerRuntime(server.agentId, { relayUrl: server.url, origin: server.url });
  cleanups.push(() => runtime.close()); await runtime.ready(3000);
  const endpoint = `${server.url}/__ardb/recording`;
  const post = (action: string, body: object = {}) => fetch(`${endpoint}/${action}`, {
    method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(await (await fetch(endpoint)).json()).toMatchObject({ phase: 'idle' });
  expect((await fetch(`${endpoint}/start`, { method: 'POST' })).status).toBe(403);
  const started = await post('start'); expect(started.status).toBe(200);
  const capture = await started.json(); expect(capture.phase).toBe('recording');
  expect((await post('start')).status).toBe(409);
  await runtime.client.sendMessage('human and AI share this recording');
  await expect.poll(async () => (await (await fetch(endpoint)).json()).records).toBeGreaterThan(capture.records);
  await fetch(`${server.url}/__ardb/session`);
  expect(await (await fetch(endpoint)).json()).toMatchObject({ id: capture.id, phase: 'recording' });
  expect((await post('stop', { id: 'stale' })).status).toBe(409);
  const stopped = await post('stop', { id: capture.id }); expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({ phase: 'stopped', id: capture.id });
  const exported = await fetch(`${endpoint}/export?id=${capture.id}`);
  expect(exported.headers.get('content-disposition')).toContain('.jsonl');
  const recording = parseRecording(await exported.text());
  const player = new RecordingPlayer(recording); player.seek(recording.duration);
  expect(JSON.stringify(player.state.timeline)).toContain('Recorded reply: human and AI share this recording');
  expect(recording.warnings).not.toContain('Recording completion is unknown: no closing marker was captured.');
  await runtime.client.sendMessage('after recording');
  await expect.poll(() => JSON.stringify(runtime.replica.getState().timeline)).toContain('Recorded reply: after recording');
  expect(await (await fetch(`${endpoint}/export?id=${capture.id}`)).text()).not.toContain('after recording');
  expect((await post('start')).status).toBe(409);
  const next = await (await post('start', { previousId: capture.id })).json();
  expect(next.phase).toBe('recording'); expect(next.id).not.toBe(capture.id);
  expect((await fetch(`${endpoint}/export?id=${capture.id}`)).status).toBe(409);
  expect((await fetch(endpoint, { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
}, 15000);

it('browses and validates recordings on the server filesystem', async () => {
  const { mkdtemp, writeFile, mkdir, rm, truncate } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'ardb-files-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'recordings'));
  await writeFile(join(directory, 'invalid.jsonl'), 'not json');
  await writeFile(join(directory, 'notes.txt'), 'not a recording');
  await writeFile(join(directory, '.hidden.jsonl'), 'not shown');
  const { provider } = createRecordedLabProvider();
  const server = await createDebuggerServer({ assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), adapter: provider, config: { cwd: directory } });
  cleanups.push(() => server.close());
  const listing = await (await fetch(`${server.url}/__ardb/files`)).json();
  expect(listing.directory).toContain('ardb-files-');
  expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(['recordings', 'invalid.jsonl']);
  expect((await fetch(`${server.url}/__ardb/files?directory=${encodeURIComponent(join(directory, 'recordings'))}`)).status).toBe(200);
  const invalid = await fetch(`${server.url}/__ardb/files/open?path=${encodeURIComponent(join(directory, 'invalid.jsonl'))}`);
  expect(invalid.status).toBe(400); expect(await invalid.text()).toContain('line 1');
  await truncate(join(directory, 'invalid.jsonl'), 64 * 1024 * 1024 + 1);
  expect(await (await fetch(`${server.url}/__ardb/files/open?path=${encodeURIComponent(join(directory, 'invalid.jsonl'))}`)).text()).toContain('64 MiB');
  expect((await fetch(`${server.url}/__ardb/files`, { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
}, 10000);

it('bounds capture size and retains a replayable prefix while the Agent stays usable', async () => {
  const { LiveRecording } = await import('./live-recording.js');
  const { parseRecording } = await import('./recording.js');
  const { provider } = createRecordedLabProvider();
  const server = await createDebuggerServer({ assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)), adapter: provider });
  cleanups.push(() => server.close());
  const capture = new LiveRecording(server.agentId, () => server.url, 65536);
  cleanups.push(() => capture.close());
  const started = await capture.start();
  expect(started.phase).toBe('recording');
  capture.append({ kind: 'browser_trace', text: 'x'.repeat(65536) });
  expect(capture.status()).toMatchObject({ phase: 'stopped', error: expect.stringContaining('size limit') });
  const data = capture.export(started.id!);
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(65536);
  expect(parseRecording(data).agentId).toBe(server.agentId);
  expect(parseRecording(data).warnings).toContain('Recording stopped at its size limit; later session changes were not captured.');
  const runtime = await createDebuggerRuntime(server.agentId, { relayUrl: server.url, origin: server.url });
  cleanups.push(() => runtime.close()); await runtime.ready(3000);
  await runtime.client.sendMessage('still usable after recorder limit');
  await expect.poll(() => JSON.stringify(runtime.replica.getState().timeline)).toContain('Recorded reply: still usable after recorder limit');
}, 10000);
