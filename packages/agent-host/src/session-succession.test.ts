import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { LocalSuccessionPreparation, type LocalSuccessionAccess, type SuccessionReadiness } from './local-succession-preparation.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' };
const target = { ...source, nativeSessionId: 'B' };
const request = { roleId: 'role', operationId: 'op', expectedRevision: 1, from: source };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-succession-flow-'))); roots.push(root);
  const store = new SessionSuccessionStore(join(root, 'state')); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: source, current: source, workspace: { controllerId: 'host', canonicalCwd: root } });
  const sourceState: SuccessionReadiness = { cwd: root, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0,
    managed: true, boundary: { epoch: 'e', seq: 4 } };
  const targetState = { ...sourceState };
  const effects: string[] = [];
  let failCreation = false, failTransfer = false;
  const access: LocalSuccessionAccess = {
    inspect: async session => session.nativeSessionId === 'A' ? { ...sourceState } : { ...targetState },
    create: async (from, operationId) => {
      effects.push(`create:${from.nativeSessionId}:${operationId}`);
      if (failCreation) throw new Error('Response lost after native creation');
      return target;
    },
    transfer: async (from, to, operationId) => {
      effects.push(`transfer:${from.nativeSessionId}:${to.nativeSessionId}:${operationId}`);
      if (failTransfer) throw new Error('Context receipt lost');
      return { epoch: 'e', seq: 4, capturedAt: '2026-10-10T00:00:00.000Z' };
    },
  };
  const preparation = new LocalSuccessionPreparation('host', 'codex', access);
  const coordinator = new SessionSuccessionCoordinator(store, preparation);
  return { root, store, preparation, coordinator, sourceState, targetState, effects,
    loseCreation: () => { failCreation = true; }, loseTransfer: () => { failTransfer = true; } };
}

test('prepares once, gates both executors, then admits only the committed successor', async () => {
  const f = await fixture();
  await Promise.all([f.coordinator.prepare(request), f.coordinator.prepare(request)]);
  expect(f.effects).toEqual(['create:A:op:create', 'transfer:A:B:op:context']);
  expect(f.coordinator.status('op').phase).toBe('ready');
  expect(() => f.coordinator.assertAdmission(source)).toThrow(/handoff/i);
  expect(() => f.coordinator.assertAdmission(target)).toThrow(/ready|handoff/i);
  expect(() => f.coordinator.assertAdmission({ ...source, nativeSessionId: 'unrelated' })).not.toThrow();
  expect((await f.coordinator.commit('op', 1)).committedRevision).toBe(2);
  expect(() => f.coordinator.assertAdmission(target)).not.toThrow();
  expect(() => f.coordinator.assertAdmission(source)).toThrow(/superseded/i);
  expect((await f.coordinator.commit('op', 1)).committedRevision).toBe(2);
});

test.each(['pendingInputs', 'pendingInteractions', 'activeChildren'] as const)('rejects unsafe %s before creating another executor', async field => {
  const f = await fixture(); f.sourceState[field] = 1;
  expect((await f.coordinator.prepare(request)).phase).toBe('rejected');
  expect(f.effects).toEqual([]);
  expect(() => f.coordinator.assertAdmission(source)).not.toThrow();
});

test('rejects unknown native ownership and a changed working directory before creating', async () => {
  const f = await fixture(); f.sourceState.managed = false;
  expect((await f.coordinator.prepare(request)).phase).toBe('rejected');
  f.sourceState.managed = true; f.sourceState.cwd = tmpdir();
  expect((await f.coordinator.prepare({ ...request, operationId: 'cwd' })).phase).toBe('rejected');
  expect(f.effects).toEqual([]);
});

test('retains unknown creation and does not dispatch it again after retries or restart', async () => {
  const f = await fixture(); f.loseCreation();
  expect((await f.coordinator.prepare(request)).phase).toBe('unknown');
  await f.coordinator.prepare(request);
  const restored = new SessionSuccessionStore(join(f.root, 'state')); await restored.ready;
  const coordinator = new SessionSuccessionCoordinator(restored, f.preparation);
  expect((await coordinator.prepare(request)).phase).toBe('unknown');
  expect(f.effects).toEqual(['create:A:op:create']);
  expect(() => coordinator.assertAdmission(source)).toThrow(/handoff/i);
  await expect(coordinator.cancel('op')).rejects.toThrow(/unknown|reconcil/i);
});

test('retains an ambiguous context transfer with the actual candidate identity', async () => {
  const f = await fixture(); f.loseTransfer();
  expect(await f.coordinator.prepare(request)).toMatchObject({ phase: 'unknown', to: target, resumePhase: 'transferring' });
  await f.coordinator.prepare(request);
  expect(f.effects).toEqual(['create:A:op:create', 'transfer:A:B:op:context']);
  expect(f.store.read('role').role.current.nativeSessionId).toBe('A');
});

test('does not commit after the source changes beyond the copied boundary', async () => {
  const f = await fixture(); await f.coordinator.prepare(request);
  f.sourceState.boundary = { epoch: 'e', seq: 5 };
  await expect(f.coordinator.commit('op', 1)).rejects.toThrow(/boundary|changed/i);
  expect(f.store.read('role').role.current.nativeSessionId).toBe('A');
});

test('cancelling a ready candidate retains its identity and reopens the predecessor', async () => {
  const f = await fixture(); await f.coordinator.prepare(request);
  expect(await f.coordinator.cancel('op')).toMatchObject({ phase: 'cancelled', to: target });
  expect(() => f.coordinator.assertAdmission(source)).not.toThrow();
  await expect(f.coordinator.commit('op', 1)).rejects.toThrow(/ready/i);
  expect(f.effects).toHaveLength(2);
});

test('a ready candidate can be reconciled after restart without copying context again', async () => {
  const f = await fixture(); await f.coordinator.prepare(request);
  const store = new SessionSuccessionStore(join(f.root, 'state')); await store.ready;
  const coordinator = new SessionSuccessionCoordinator(store, f.preparation);
  expect(coordinator.status('op').phase).toBe('unknown');
  expect((await coordinator.reconcileReady('op')).phase).toBe('ready');
  expect((await coordinator.commit('op', 1)).committedRevision).toBe(2);
  expect(f.effects).toEqual(['create:A:op:create', 'transfer:A:B:op:context']);
});

test('a ready candidate that became busy cannot be committed or silently interrupted', async () => {
  const f = await fixture(); await f.coordinator.prepare(request);
  f.targetState.idle = false;
  await expect(f.coordinator.commit('op', 1)).rejects.toThrow(/pending|finish/i);
  expect(f.store.read('role').role.current.nativeSessionId).toBe('A');
  expect(f.effects).toHaveLength(2);
});
