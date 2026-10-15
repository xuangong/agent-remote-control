import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { createDebuggerServer } from './server.js';
import { createDebuggerRuntime } from './runtime.js';
// @ts-expect-error Test-only native fixture shared with installed-package smoke.
import { createPrefixAdapter } from './fixtures/prefix-adapter.mjs';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 10000);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ardb-prefix-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const adapter = createPrefixAdapter(directory);
  const options = { adapter, config: { sessionId: 'A', cwd: directory }, successionStateDirectory: join(directory, 'state'), assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)) };
  const start = async () => { const server = await createDebuggerServer(options); cleanup.push(() => server.close()); return server; };
  return { adapter, start };
}
const post = (server: {url: string}, action: string, body: unknown) => fetch(`${server.url}/__ardb/succession/${action}`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
async function prepare(server: Awaited<ReturnType<typeof createDebuggerServer>>, operationId = 'edit') {
  const response = await post(server, 'describe', { agentId: server.agentId, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } });
  expect(response.status).toBe(200);
  const { role } = await response.json();
  return post(server, 'prepare', { operationId, roleId: role.id, expectedRevision: role.revision, from: role.current, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } });
}
test('commits the exact live prefix, fences old input, preserves history and restores without another fork', async () => {
  const f = await fixture(), server = await f.start(), original = server.agentId;
  const old = await createDebuggerRuntime(original, { relayUrl: server.url, origin: server.url }); cleanup.push(() => old.close()); await old.ready(3000);
  const prepared = await prepare(server); expect(prepared.status).toBe(200); expect(await prepared.json()).toMatchObject({ record: { phase: 'ready' } });
  const committed = await post(server, 'commit', { operationId: 'edit', expectedRevision: 1 }); expect(committed.status).toBe(200);
  const current = await (await fetch(server.url + '/__ardb/session')).json(); expect(current.nativeSessionId).toBe('candidate-1'); expect(current.agentId).not.toBe(original); expect(server.session).toEqual(current);
  await expect(old.client.sendMessage('obsolete')).rejects.toThrow();
  expect(JSON.stringify(old.replica.getState().timeline)).toContain('discarded tail');
  const live = await createDebuggerRuntime(current.agentId, { relayUrl: server.url, origin: server.url }); cleanup.push(() => live.close()); await live.ready(3000); await live.client.sendMessage('replacement');
  expect((await f.adapter.state()).sessions['candidate-1'].inputs).toEqual(['replacement']);
  old.close(); live.close(); await server.close();
  const restarted = await f.start(); expect(restarted.session).toEqual(current); expect((await f.adapter.state()).forks).toBe(1); expect((await f.adapter.state()).creates).toBe(1);
}, 20000);
test('cancel retains the original and foreign locators cannot prepare', async () => {
  const f = await fixture(), server = await f.start(), original = server.agentId;
  expect((await post(server, 'describe', { agentId: 'foreign' })).status).toBe(403);
  expect((await prepare(server)).status).toBe(200);
  expect((await post(server, 'cancel', { operationId: 'edit', expectedRevision: 1 })).status).toBe(200);
  expect(server.agentId).toBe(original);
  const client = await createDebuggerRuntime(original, { relayUrl: server.url, origin: server.url }); cleanup.push(() => client.close()); await client.ready(3000); await client.client.sendMessage('still original');
}, 15000);
test('unknown without an exact handle stays recoverable on restart without retrying native creation', async () => {
  const f = await fixture(), server = await f.start(); await f.adapter.unknown();
  expect(await (await prepare(server)).json()).toMatchObject({ record: { phase: 'unknown' } }); await server.close();
  const restarted = await f.start();
  expect(await (await prepare(restarted)).json()).toMatchObject({ record: { phase: 'unknown' } });
  expect((await post(restarted, 'reconcile', { operationId: 'edit', expectedRevision: 1 })).status).toBe(409);
  expect((await f.adapter.state()).forks).toBe(1); expect(restarted.session.nativeSessionId).toBe('A');
}, 15000);

test('keeps the original recording identity and explicitly reopens historical reads after restart', async () => {
  const f = await fixture(), server = await f.start(), original = server.agentId;
  const capture = await fetch(server.url + '/__ardb/recording/start', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: '{}' });
  const started = await capture.json(); expect(started.phase).toBe('recording');
  await prepare(server); await post(server, 'commit', { operationId: 'edit', expectedRevision: 1 });
  expect(await (await fetch(server.url + '/__ardb/recording')).json()).toMatchObject({ phase: 'idle' });
  const exported = await (await fetch(`${server.url}/__ardb/recording/export?id=${started.id}`)).text();
  const records = exported.trim().split('\n').map(line => JSON.parse(line)); expect(records[0].agentId).toBe(original); expect(records.at(-1).agentId).toBe(original); expect(exported).toContain('discarded tail');
  await server.close(); const restarted = await f.start();
  const history = await fetch(restarted.url + '/__ardb/history?nativeSessionId=A'); expect(history.status).toBe(200); const locator = await history.json();
  const old = await createDebuggerRuntime(locator.agentId, { relayUrl: restarted.url, origin: restarted.url }); cleanup.push(() => old.close()); await old.ready(3000);
  expect(JSON.stringify(old.replica.getState().timeline)).toContain('discarded tail'); await expect(old.client.sendMessage('historical')).rejects.toThrow();
  expect((await fetch(restarted.url + '/__ardb/history?nativeSessionId=foreign')).status).toBe(403);
}, 20000);

test('publishes the committed descriptor through the replay/live listener and rejects replay-only mutation', async () => {
  const { createReplayServer } = await import('./replay-server.js');
  const root = await mkdtemp(join(tmpdir(), 'ardb-prefix-replay-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const adapter = createPrefixAdapter(root);
  const server = await createReplayServer({ directory: root, successionStateDirectory: join(root, 'state'), loadProvider: async () => adapter, assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)) }); cleanup.push(() => server.close());
  expect((await post(server, 'prepare', {})).status).toBe(405);
  const starting = await fetch(server.url + '/__ardb/live/start', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'codex', cwd: root }) });
  const live = await starting.json();
  const description = await (await post(server, 'describe', { agentId: live.agentId, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } })).json();
  expect((await post(server, 'prepare', { operationId: 'edit', roleId: description.role.id, expectedRevision: 1, from: description.role.current, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } })).status).toBe(200);
  expect((await post(server, 'commit', { operationId: 'edit', expectedRevision: 1 })).status).toBe(200);
  const descriptor = await (await fetch(server.url + '/__ardb/session')).json(); expect(descriptor.live.nativeSessionId).toBe('candidate-1'); expect(descriptor.live.agentId).not.toBe(live.agentId);
}, 20000);

test('restores the exact uncommitted candidate without refreshing its source capture', async () => {
  const f = await fixture(), server = await f.start();
  expect(await (await prepare(server)).json()).toMatchObject({ record: { phase: 'ready', to: { nativeSessionId: 'candidate-1' } } });
  await server.close(); const restarted = await f.start();
  expect(restarted.session.nativeSessionId).toBe('A');
  expect(await (await post(restarted, 'status', { operationId: 'edit', expectedRevision: 1 })).json()).toMatchObject({ record: { phase: 'unknown', to: { nativeSessionId: 'candidate-1' } } });
  expect((await post(restarted, 'commit', { operationId: 'edit', expectedRevision: 1 })).status).toBe(409);
  const reconciled = await post(restarted, 'reconcile', { operationId: 'edit', expectedRevision: 1 });
  expect(await reconciled.json()).toMatchObject({ record: { phase: 'rejected', failureCode: 'succession_boundary_changed', to: { nativeSessionId: 'candidate-1' } } });
  expect(restarted.session.nativeSessionId).toBe('A'); expect((await f.adapter.state()).forks).toBe(1);
}, 15000);
