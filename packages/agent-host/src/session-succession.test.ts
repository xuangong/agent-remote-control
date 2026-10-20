import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { LocalSuccessionPreparation, type LocalSuccessionAccess, type SuccessionReadiness } from './local-succession-preparation.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const source = { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' };
const target = { ...source, nativeSessionId: 'B' };
const request = { roleId: 'role', operationId: 'op', expectedRevision: 1, from: source };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-succession-flow-'))); roots.push(root);
  const store = new SessionSuccessionStore(join(root, 'state')); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: source, current: source, workspace: { controllerId: 'host', canonicalCwd: root } });
  const sourceState: SuccessionReadiness = { cwd: root, idle: true, pendingInputs: 0, inFlightInputs: 0, pendingInteractions: 0, activeChildren: 0,
    managed: true, boundary: { epoch: 'e', seq: 4 } };
  const targetState = { ...sourceState };
  const effects: string[] = [];
  let failCreation = false, failTransfer = false;
  const access: LocalSuccessionAccess = {
    supports: async () => true,
    verifyAttachment: async () => {},
    inspect: async session => session.nativeSessionId === 'A' ? { ...sourceState } : { ...targetState },
    create: async (from, operationId) => {
      effects.push(`create:${from.nativeSessionId}:${operationId}`);
      if (failCreation) throw new Error('Response lost after native creation');
      return target;
    },
    capture: async (from, operationId) => {
      effects.push(`capture:${from.nativeSessionId}:${operationId}`);
      if (failTransfer) throw new Error('Context receipt lost');
      return { operationId: operationId.slice(0, -8), roleId: 'role', roleRevision: 2, source: from, text: '[]', itemCount: 0, boundary: { epoch: 'e', seq: 4 }, capturedAt: '2026-10-10T00:00:00.000Z' };
    },
    saveContext: async () => {},
    bind: async (operationId, to) => { effects.push(`bind:${to.nativeSessionId}:${operationId}`); },
  };
  const preparation = new LocalSuccessionPreparation('host', 'codex', access);
  const coordinator = new SessionSuccessionCoordinator(store, preparation);
  return { root, store, preparation, coordinator, sourceState, targetState, effects, access,
    loseCreation: () => { failCreation = true; }, loseTransfer: () => { failTransfer = true; } };
}

test('prepares once, gates both executors, then admits only the committed successor', async () => {
  const f = await fixture();
  await Promise.all([f.coordinator.prepare(request), f.coordinator.prepare(request)]);
  expect(f.effects).toEqual(['capture:A:op:context', 'create:A:op:create', 'bind:B:op']);
  expect(f.coordinator.status('op').phase).toBe('ready');
  expect(() => f.coordinator.assertAdmission(source)).toThrow(/handoff/i);
  expect(() => f.coordinator.assertAdmission(target)).toThrow(/ready|handoff/i);
  expect(() => f.coordinator.assertAdmission({ ...source, nativeSessionId: 'unrelated' })).not.toThrow();
  expect((await f.coordinator.commit('op', 1)).committedRevision).toBe(2);
  expect(() => f.coordinator.assertAdmission(target)).not.toThrow();
  expect(() => f.coordinator.assertAdmission(source)).toThrow(/superseded/i);
  expect((await f.coordinator.commit('op', 1)).committedRevision).toBe(2);
});

test.each(['token', 'snapshot', 'enrolled-to-local', 'local-to-enrolled'] as const)('in-flight preparation rejects changed %s identity before begin while exact retries join', async change => {
  const f = await fixture(); const generation = f.store.generation;
  f.access.supportsBoundedProjection = async () => true;
  const freeze: SuccessionAssociationFreeze = { version: 2, maxProjectionBytes: 64 * 1024, token: 'freeze',
    authority: { version: 1, origin: 'https://relay.test', issuer: 'relay', namespace: 'tenant', ownerSubject: 'owner' },
    controllerId: source.controllerId, request, associationRevision: 0, lineage: [source], relations: [] };
  let entered!: () => void, resume!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const inspect = f.access.inspect;
  f.access.inspect = async target => { entered(); await gate; return inspect(target); };
  const local = change === 'local-to-enrolled';
  const first = local ? f.coordinator.prepare(request) : f.coordinator.prepareEnrolled(freeze, [], generation);
  await reached;
  const exact = local ? f.coordinator.prepare({ ...request }) : f.coordinator.prepareEnrolled(structuredClone(freeze), [], generation);
  const changed = structuredClone(freeze);
  if (change === 'token') changed.token = 'other';
  if (change === 'snapshot') changed.relations.push({ relationId: 'new-reader', kind: 'side', sourceRef: source,
    readerRef: { ...source, nativeSessionId: 'C' }, linked: true, revision: 1 });
  let outcome: unknown;
  const conflict = (change === 'enrolled-to-local' ? f.coordinator.prepare(request)
    : f.coordinator.prepareEnrolled(changed, [], generation)).then(() => { outcome = 'joined'; }, error => { outcome = error; });
  try {
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(outcome).toBeInstanceOf(Error); expect((outcome as Error).message).toMatch(/identity/);
    expect(f.store.read('role').operations).toEqual([]); expect(f.effects).toEqual([]);
    resume(); expect((await first).phase).toBe('ready'); expect(await exact).toEqual(await first); await conflict;
    expect(f.effects.filter(effect => effect.startsWith('create:'))).toEqual(['create:A:op:create']);
    expect(f.store.read('role').enrollments ?? []).toEqual(local ? [] : [freeze]);
  } finally { resume(); await Promise.allSettled([first, exact, conflict]); }
}, 10000);

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
  expect(f.effects).toEqual(['capture:A:op:context', 'create:A:op:create']);
  expect(() => coordinator.assertAdmission(source)).toThrow(/handoff/i);
  expect((await coordinator.cancel('op')).phase).toBe('cancelled');
});

test('rejects failed capture before candidate creation', async () => {
  const f = await fixture(); f.loseTransfer();
  expect(await f.coordinator.prepare(request)).toMatchObject({ phase: 'rejected' });
  await f.coordinator.prepare(request);
  expect(f.effects).toEqual(['capture:A:op:context']);
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
  expect(f.effects).toHaveLength(3);
});

test('a ready candidate can be reconciled after restart without copying context again', async () => {
  const f = await fixture(); await f.coordinator.prepare(request);
  const store = new SessionSuccessionStore(join(f.root, 'state')); await store.ready;
  const coordinator = new SessionSuccessionCoordinator(store, f.preparation);
  expect(coordinator.status('op').phase).toBe('unknown');
  expect((await coordinator.reconcileReady('op')).phase).toBe('ready');
  expect((await coordinator.commit('op', 1)).committedRevision).toBe(2);
  expect(f.effects).toEqual(['capture:A:op:context', 'create:A:op:create', 'bind:B:op', 'bind:B:op']);
});

test.each(['source', 'source-error', 'supports', 'candidate', 'verify'] as const)('cancelling deferred recovery at %s never recreates source or candidate fences', async stage => {
  const f = await fixture(); await f.coordinator.prepare(request);
  const store = new SessionSuccessionStore(join(f.root, 'state')); await store.ready;
  const coordinator = new SessionSuccessionCoordinator(store, f.preparation);
  const { createOperationCache } = await import('@orchardworks/agent-remote-relay');
  const { SessionSuccessionBoundary } = await import('./session-succession-boundary.js');
  const { SessionSuccessionContextStore } = await import('./session-succession-context.js');
  const contexts = new SessionSuccessionContextStore(join(f.root, 'contexts')); await contexts.ready;
  const cache = createOperationCache();
  const boundary = new SessionSuccessionBoundary(contexts, target => coordinator.assertAdmission(target), () => undefined, cache);
  coordinator.setAdmission(boundary);
  let entered!: () => void, resume!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const pause = async () => { entered(); await gate; if (stage === 'source-error') throw new Error('Readiness unavailable'); };
  const inspect = f.access.inspect;
  f.access.inspect = async target => {
    if ((stage === 'source' || stage === 'source-error') && target.nativeSessionId === 'A'
      || stage === 'candidate' && target.nativeSessionId === 'B') await pause();
    return inspect(target);
  };
  if (stage === 'supports') f.access.supports = async () => { await pause(); return true; };
  if (stage === 'verify') f.access.verifyAttachment = pause;
  const recovery = coordinator.reconcileReady('op');
  try {
    await reached;
    expect((await coordinator.cancel('op')).phase).toBe('cancelled');
    expect(() => boundary.admit([source, target], 'after-cancel')()).not.toThrow();
    resume(); expect((await recovery).phase).toBe('cancelled');
    expect(() => boundary.admit([source, target], 'after-recovery')()).not.toThrow();
    expect((await coordinator.reconcileReady('op')).phase).toBe('cancelled');
    expect(f.effects.filter(effect => effect.startsWith('create:'))).toEqual(['create:A:op:create']);
    expect(store.read('role').role.current).toEqual(source);
  } finally { resume(); await recovery; await boundary.close(); await cache.close(); }
}, 10000);

test('a ready candidate that became busy cannot be committed or silently interrupted', async () => {
  const f = await fixture(); await f.coordinator.prepare(request);
  f.targetState.idle = false;
  await expect(f.coordinator.commit('op', 1)).rejects.toThrow(/pending|finish/i);
  expect(f.store.read('role').role.current.nativeSessionId).toBe('A');
  expect(f.effects).toHaveLength(3);
});

test('requires durable attachment verification before ready and again before commit', async () => {
  const f = await fixture(); let verified = 0;
  f.access.verifyAttachment = async () => { verified++; if (verified === 2) throw new Error('attachment unavailable'); };
  expect((await f.coordinator.prepare(request)).phase).toBe('ready');
  await expect(f.coordinator.commit('op', 1)).rejects.toThrow('attachment unavailable');
  expect(f.store.read('role').role.current).toEqual(source);
});
test('rejects unsupported provider pairs before candidate creation', async () => {
  const f = await fixture();
  f.access.supports = async () => false;
  expect((await f.coordinator.prepare({ ...request, targetProviderId: 'claude' })).phase).toBe('rejected');
  expect(f.effects).toEqual([]);
});
test('records selected provider identity and gates Host in-flight inputs', async () => {
  const f = await fixture(); f.sourceState.inFlightInputs = 1;
  expect((await f.coordinator.prepare(request)).phase).toBe('rejected'); expect(f.effects).toEqual([]);
});

test('creates a supported provider successor and saves requested provider in durable identity', async () => {
  const f = await fixture(); const other = { ...target, providerId: 'claude' };
  let requested = '';
  f.access.create = async (_source, _operation, provider) => { requested = provider; return other; };
  const cross = { ...request, targetProviderId: 'claude' };
  expect(await f.coordinator.prepare(cross)).toMatchObject({ phase: 'ready', targetProviderId: 'claude', to: other });
  expect(requested).toBe('claude');
  await expect(f.coordinator.prepare({ ...cross, targetProviderId: 'codex' })).rejects.toThrow(/identity/);
  expect((await f.coordinator.commit('op', 1)).to).toEqual(other);
});
test('blocks an unresolved first input before another succession without wrapping pending rows', async () => {
  const f = await fixture(); await f.coordinator.prepare(request); await f.coordinator.commit('op', 1);
  const { SessionSuccessionContextStore } = await import('./session-succession-context.js');
  const contexts = new SessionSuccessionContextStore(join(f.root, 'contexts')); await contexts.ready;
  const raw = '[{"role":"user","text":"old"}]';
  await contexts.attach({ operationId: 'op', roleId: 'role', roleRevision: 2, source, target, capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 4 }, text: raw, itemCount: 1 });
  const preparation = new LocalSuccessionPreparation('host', 'codex', f.access, contexts);
  expect(preparation.pendingContext(target)!.text).toBe(raw);
  await contexts.begin('op', { operationId: 'first', roleId: 'role', roleRevision: 2, target, text: 'new' });
  await contexts.settle('op', 'first', 'unknown');
  const coordinator = new SessionSuccessionCoordinator(f.store, preparation);
  expect((await coordinator.prepare({ ...request, operationId: 'next', expectedRevision: 2, from: target })).failureCode).toBe('succession_context_unknown');
});
test('refuses commit if durable state changes while attachment verification awaits', async () => {
  const f = await fixture(); await f.coordinator.prepare(request);
  f.access.verifyAttachment = async () => { await f.coordinator.cancel('op'); };
  await expect(f.coordinator.commit('op', 1)).rejects.toThrow(/changed/);
  expect(f.store.read('role').role.current).toEqual(source);
});

test('retains actual candidate identity before rejecting a wrong provider result', async () => {
  const f = await fixture(); f.access.create = async () => ({ ...target, providerId: 'wrong' });
  expect(await f.coordinator.prepare(request)).toMatchObject({ phase: 'rejected', to: { ...target, providerId: 'wrong' }, failureCode: 'succession_target_provider_mismatch' });
  expect(f.effects).toEqual(['capture:A:op:context']);
});

test('final synchronous Host check rejects facts changed after asynchronous verification', async () => {
  const f = await fixture();
  const { createOperationCache } = await import('@orchardworks/agent-remote-relay');
  const { SessionSuccessionBoundary } = await import('./session-succession-boundary.js');
  const { SessionSuccessionContextStore } = await import('./session-succession-context.js');
  const contexts = new SessionSuccessionContextStore(join(f.root, 'contexts')); await contexts.ready;
  const cache = createOperationCache(); let changed = false;
  const boundary = new SessionSuccessionBoundary(contexts, target => f.coordinator.assertAdmission(target), () => undefined, cache,
    () => { if (changed) throw new Error('Host execution changed'); });
  f.coordinator.setAdmission(boundary);
  try {
    expect((await f.coordinator.prepare(request)).phase).toBe('ready');
    const verify = f.preparation.verify.bind(f.preparation);
    f.preparation.verify = async (...args) => { const lease = await verify(...args); changed = true; return lease; };
    await expect(f.coordinator.commit('op', 1)).rejects.toThrow('Host execution changed');
    expect(f.store.operation('op').phase).toBe('ready'); expect(f.store.read('role').role.current).toEqual(source);
    expect(() => boundary.admit([source], 'blocked')).toThrow();
    changed = false; f.preparation.verify = verify;
    expect((await f.coordinator.commit('op', 1)).phase).toBe('committed');
  } finally { await boundary.close(); await cache.close(); }
}, 10000);
