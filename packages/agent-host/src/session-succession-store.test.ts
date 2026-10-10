import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionStore } from './session-succession-store.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const source = { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' };
const workspace = { controllerId: 'host', canonicalCwd: '/workspace' };
const role = { id: 'role', revision: 1, origin: source, current: source, workspace };
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: source };
const target = { ...source, nativeSessionId: 'B' };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-succession-')); directories.push(directory);
  const store = new SessionSuccessionStore(directory); await store.ready; await store.createRole(role);
  return { directory, store };
}
async function ready(store: SessionSuccessionStore, input = request, to = target) {
  await store.begin(input);
  await store.advance(input.operationId, 'preparing', { phase: 'quiescing', to });
  await store.advance(input.operationId, 'quiescing', { phase: 'transferring' });
  return store.advance(input.operationId, 'transferring', { phase: 'ready', prepared: {
    ...input, to, associationRevision: 0, workspace, participants: [],
    capture: { epoch: 'epoch', seq: 4, capturedAt: '2026-10-10T00:00:00.000Z' },
  } });
}

test('reserves one revision and deduplicates the same intent without accepting conflicting input', async () => {
  const { store } = await fixture();
  const outcomes = await Promise.allSettled([store.begin(request), store.begin({ ...request, operationId: 'other' })]);
  expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  const first = store.operation('op');
  expect(await store.begin({ ...request, from: { nativeSessionId: 'A', providerId: 'codex', controllerId: 'host' } })).toEqual(first);
  await expect(store.begin({ ...request, from: target })).rejects.toThrow(/identity|conflict/i);
  expect(store.read('role').role.current.nativeSessionId).toBe('A');
});

test('commits role and receipt together and retains A -> B -> C history across restart', async () => {
  const { store, directory } = await fixture();
  await ready(store);
  const first = await store.commit('op');
  expect(first.committedRevision).toBe(2);
  expect(await store.commit('op')).toEqual(first);
  const next = { ...request, operationId: 'next', expectedRevision: 2, from: target };
  await ready(store, next, { ...source, nativeSessionId: 'C' }); await store.commit('next');
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.read('role').role).toMatchObject({ revision: 3, origin: source, current: { nativeSessionId: 'C' } });
  expect(restored.read('role').operations.map(op => [op.from.nativeSessionId, op.to?.nativeSessionId])).toEqual([['A', 'B'], ['B', 'C']]);
  expect(await restored.commit('op')).toEqual(first);
  await expect(restored.begin({ ...request, operationId: 'stale' })).rejects.toThrow(/revision|changed/i);
});

test('rejects commit without verified preparation and cannot rewrite a persisted target', async () => {
  const { store } = await fixture(); await store.begin(request);
  await expect(store.commit('op')).rejects.toThrow(/ready/i);
  await expect(store.advance('op', 'preparing', { phase: 'ready' })).rejects.toThrow();
  await store.advance('op', 'preparing', { phase: 'quiescing', to: target });
  await expect(store.advance('op', 'quiescing', { phase: 'transferring', to: { ...target, nativeSessionId: 'C' } })).rejects.toThrow(/target/i);
  expect(store.operation('op').phase).toBe('quiescing');
});

test('restart retains the gate and records uncertain preparation without recreating or committing', async () => {
  const { store, directory } = await fixture(); await ready(store);
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.operation('op')).toMatchObject({ phase: 'unknown', resumePhase: 'ready', to: target });
  expect(restored.read('role').role.current.nativeSessionId).toBe('A');
  await expect(restored.commit('op')).rejects.toThrow(/ready/i);
  await expect(restored.begin({ ...request, operationId: 'retry-new-id' })).rejects.toThrow(/progress|reserved/i);
  await expect(restored.advance('op', 'unknown', { phase: 'cancelled' })).rejects.toThrow(/reconcil|unknown/i);
  await restored.advance('op', 'unknown', { phase: 'ready' });
  expect((await restored.commit('op')).committedRevision).toBe(2);
});

test('rejects self succession, duplicate participant relations and mismatched preparation', async () => {
  const { store } = await fixture(); await store.begin(request);
  await expect(store.advance('op', 'preparing', { phase: 'quiescing', to: source })).rejects.toThrow(/same|target/i);
  await store.advance('op', 'preparing', { phase: 'quiescing', to: target });
  await store.advance('op', 'quiescing', { phase: 'transferring' });
  const prepared = { ...request, to: target, associationRevision: 0, workspace, participants: [],
    capture: { epoch: 'epoch', seq: 4, capturedAt: '2026-10-10T00:00:00.000Z' } };
  await expect(store.advance('op', 'transferring', { phase: 'ready', prepared: { ...prepared, from: target } })).rejects.toThrow(/prepar/i);
  const side = { relationId: 'same', kind: 'side' as const, before: target, after: target };
  await expect(store.advance('op', 'transferring', { phase: 'ready', prepared: { ...prepared, participants: [side, side] } })).rejects.toThrow(/participant/i);
});

test('a failed atomic replacement does not publish memory or damage the last saved decision', async () => {
  const { store, directory } = await fixture();
  const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
  const saved = await readFile(join(directory, file), 'utf8');
  await rm(join(directory, file)); await mkdir(join(directory, file));
  await expect(store.begin(request)).rejects.toThrow();
  expect(store.read('role').operations).toEqual([]);
  await rm(join(directory, file), { recursive: true }); await writeFile(join(directory, file), saved);
  await writeFile(join(directory, `${file}.interrupted.tmp`), '{partial');
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.read('role').role.current.nativeSessionId).toBe('A');
  expect(restored.read('role').operations).toEqual([]);
});

test('rejects a future persisted format rather than overwriting it', async () => {
  const { directory } = await fixture();
  const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
  const saved = JSON.parse(await readFile(join(directory, file), 'utf8')); saved.version = 999;
  await writeFile(join(directory, file), JSON.stringify(saved));
  await expect(new SessionSuccessionStore(directory).ready).rejects.toThrow(/format|version/i);
});

test('freezes association changes during preparation and rejects a stale association snapshot', async () => {
  const { store } = await fixture();
  await store.setParticipants('role', 1, 0, [{ relationId: 'ask', kind: 'ask', before: target, after: target }]);
  await ready(store);
  await expect(store.setParticipants('role', 1, 1, [])).rejects.toThrow(/progress|reserved/i);
  await expect(store.commit('op')).rejects.toThrow(/association/i);
  expect(store.read('role').role.current.nativeSessionId).toBe('A');
});
