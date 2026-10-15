// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web/headless';
import { SessionDirectoryClient } from '../directory-client.js';
import { createProtocolValidationServer } from '../server.js';
import { createDebuggerRuntime } from '../../../agent-remote-debugger/src/runtime.js';
// @ts-expect-error Deterministic native fixture shared with the installed package test.
import { createPrefixAdapter } from '../../../agent-remote-debugger/src/fixtures/prefix-adapter.mjs';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 10000);
const preparation = { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message-1' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lab-succession-replay-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const adapter = createPrefixAdapter(root), origin = 'http://127.0.0.1:5175';
  const start = async () => {
    const server = createProtocolValidationServer({ providers: [adapter], labOrigin: origin, successionStateDirectory: join(root, 'state') }); cleanup.push(() => server.close());
    const { url } = await server.http.listen(0);
    const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...init?.headers, origin }, signal: init?.signal ?? AbortSignal.timeout(5000) });
    const directory = new SessionDirectoryClient(url, fetcher);
    const transport = new HttpWebSocketTransport(url, { fetch: fetcher, sessionSuccessions: true });
    return { server, url, directory, transport, fetcher };
  };
  return { root, adapter, origin, start };
}
test('the existing clients replay A to B to C and reopen exact ancestors after restart', async () => {
  const f = await fixture(); let live = await f.start();
  const providerId = 'prefix-fixture';
  expect((await live.transport.fetchSessionSuccessions()).successions).toEqual([]);
  const original = await live.directory.create(providerId, 'create', { cwd: f.root });
  const description = await live.directory.describeSuccession(providerId, original.nativeSessionId!, preparation);
  const roleId = description.role.id;
  const originalRequest = { operationId: 'one', providerId, nativeSessionId: original.nativeSessionId!, expectedRevision: 1, preparation };
  for (const [operationId, nativeSessionId, expectedRevision] of [['one', original.nativeSessionId!, 1], ['two', 'candidate-1', 2]] as const) {
    const ready = await live.directory.prepareSuccession({ operationId, providerId, nativeSessionId, expectedRevision, preparation });
    expect(ready.record.phase).toBe('ready');
    await expect(live.directory.attachHistorical(providerId, ready.record.to!.nativeSessionId, roleId)).rejects.toMatchObject({ status: 403 });
    const result = await live.directory.successionAction('commit', operationId);
    expect(result.record.phase).toBe('committed'); expect(result.locator!.hostId).toBe('local');
    expect(result.role.current.controllerId).not.toBe('local');
    expect(await live.directory.attach(providerId, original.nativeSessionId!)).toMatchObject({ nativeSessionId: result.locator!.nativeSessionId });
  }
  const originalCommitted = (await live.directory.successionAction('status', 'one')).record;
  const assertReplay = async () => {
    expect((await live.directory.prepareSuccession(originalRequest)).record).toEqual(originalCommitted);
    await expect(live.directory.prepareSuccession({ ...originalRequest, preparation: { ...preparation, messageId: 'changed' } })).rejects.toMatchObject({ status: 409 });
    await expect(live.directory.prepareSuccession({ ...originalRequest, nativeSessionId: 'foreign' })).rejects.toMatchObject({ status: 409 });
    await expect(live.directory.prepareSuccession({ ...originalRequest, operationId: 'new-from-retired' })).rejects.toMatchObject({ status: 403 });
    expect((await f.adapter.state()).forks).toBe(2);
  };
  await assertReplay();
  const page = await live.transport.fetchSessionSuccessions({ roleId, limit: 1 });
  expect(page.successions.map(row => [row.projection.role.revision, row.to.nativeSessionId])).toEqual([[2, 'candidate-1']]);
  expect(page.nextCursor).toBeTypeOf('string');
  const next = await live.transport.fetchSessionSuccessions({ roleId, limit: 1, cursor: page.nextCursor! });
  expect(next.successions.map(row => [row.projection.role.revision, row.to.nativeSessionId])).toEqual([[3, 'candidate-2']]); expect(next.nextCursor).toBeNull();
  expect(await live.transport.fetchSessionSuccessionOperation(roleId, 'one')).toEqual(page.successions[0]);
  expect(await live.transport.fetchSessionSuccessionCurrent(roleId)).toMatchObject({ role: { revision: 3 }, locator: { hostId: 'local', nativeSessionId: 'candidate-2' } });
  expect((await live.transport.fetchSessionSuccessions({ roleId, afterRevision: 2 })).successions).toHaveLength(1);
  for (const query of ['limit=65', 'limit=0', 'limit=01', 'limit=1&limit=2', 'afterRevision=0', 'wat=1', 'cursor=bad', `roleId=${roleId}&afterRevision=1&cursor=${page.nextCursor}`]) {
    expect((await live.fetcher(`${live.url}/v1/session-successions?${query}`)).status, query).toBe(400);
  }
  expect((await live.fetcher(`${live.url}/v1/session-successions`, { method: 'POST' })).status).toBe(405);
  await live.server.close(); live = await f.start();
  await assertReplay();
  expect(await live.transport.fetchSessionSuccessionOperation(roleId, 'one')).toEqual(page.successions[0]);
  const historical = await live.directory.attachHistorical(providerId, original.nativeSessionId!, roleId);
  expect(historical.nativeSessionId).toBe(original.nativeSessionId);
  const old = await createDebuggerRuntime(historical.agentId, { relayUrl: live.url, origin: f.origin }); cleanup.push(() => old.close()); await old.ready(3000);
  expect(JSON.stringify(old.replica.getState().timeline)).toContain('discarded tail');
  await expect(old.client.sendMessage('obsolete')).rejects.toThrow();
  await expect(live.directory.attachHistorical(providerId, 'candidate-2', roleId)).rejects.toMatchObject({ status: 403 });
  await expect(live.directory.attachHistorical(providerId, original.nativeSessionId!, 'foreign')).rejects.toMatchObject({ status: 403 });
  const b = await live.directory.attachHistorical(providerId, 'candidate-1', roleId); expect(b.nativeSessionId).toBe('candidate-1');
  expect(await live.directory.attach(providerId, original.nativeSessionId!)).toMatchObject({ nativeSessionId: 'candidate-2' });
  expect((await f.adapter.state()).forks).toBe(2); expect((await f.adapter.state()).creates).toBe(1);
}, 25000);

test('the directory client cancels by operation identity and validates its retained original request', async () => {
  const f = await fixture(), live = await f.start(), providerId = 'prefix-fixture';
  const created = await live.directory.create(providerId, 'create', { cwd: f.root });
  const original = { operationId: 'cancel-first', providerId, nativeSessionId: created.nativeSessionId!, expectedRevision: 1, preparation };
  const cancelled = await live.directory.successionAction('cancel', original.operationId, { original });
  expect(cancelled.record.phase).toBe('cancelled'); expect((await f.adapter.state()).forks).toBe(0);
  expect((await live.directory.prepareSuccession(original)).record.phase).toBe('cancelled');
  expect((await live.directory.successionAction('status', original.operationId, { includeContext: true })).record.phase).toBe('cancelled');
  await expect(live.directory.successionAction('cancel', original.operationId, { original: { ...original, preparation: { ...preparation, messageId: 'forged' } } })).rejects.toMatchObject({ status: 409 });
  const ready = await live.directory.prepareSuccession({ ...original, operationId: 'ready-cancel' }); expect(ready.record.phase).toBe('ready');
  expect((await live.directory.successionAction('cancel', 'ready-cancel')).record.phase).toBe('cancelled');
  expect(await live.directory.attach(providerId, created.nativeSessionId!)).toMatchObject({ nativeSessionId: created.nativeSessionId });
  await expect(live.directory.attachHistorical(providerId, 'candidate-1', ready.role.id)).rejects.toMatchObject({ status: 403 });
}, 15000);
