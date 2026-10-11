import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionService, type SessionSuccessionPorts } from './session-succession-service.js';
import { AgentOperationRejectedError, AGENT_NATIVE_EVIDENCE_REASONS, type AgentEmptyCreationResult } from '@orchardworks/agent-provider-sdk';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const request = { operationId: 'handoff', roleId: 'role', expectedRevision: 1, from: ref('A') };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'succession-recovery-'))); roots.push(root);
  let creates = 0;
  const ports: SessionSuccessionPorts = {
    supports: async () => true,
    inspect: async () => ({ cwd: root, idle: true, managed: true, pendingInputs: 0, inFlightInputs: 0, pendingInteractions: 0, activeChildren: 0, boundary: { epoch: 'e', seq: 1 } }),
    createIdle: async () => { creates++; return ref('B'); },
    captureTimeline: async () => ({ entries: [{ item: { type: 'user_message', text: 'old work' } }] as never, boundary: { epoch: 'e', seq: 1 }, capturedAt: '2026-10-10T00:00:00Z' }),
    authorizeRead: async () => {}, readHistory: async () => ({ entries: [] }), reconcileDelivery: async () => undefined,
  };
  const directory = join(root, 'state');
  const service = new SessionSuccessionService(directory, 'host', ports); await service.ready;
  await service.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: root } });
  return { root, directory, ports, service, creates: () => creates };
}

test('capture failure is a durable rejection before any native creation', async () => {
  const f = await fixture(); f.ports.captureTimeline = async () => { throw new Error('history unavailable'); };
  expect((await f.service.prepare(request)).phase).toBe('rejected');
  expect(f.creates()).toBe(0);
  expect(() => f.service.coordinator.assertAdmission(ref('A'))).not.toThrow();
  const restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
  expect((await restored.prepare(request)).phase).toBe('rejected'); expect(f.creates()).toBe(0);
});

test('context slot exhaustion rejects before native creation', async () => {
  const f = await fixture();
  await f.service.contexts.attach({ operationId: 'old', roleId: 'old', roleRevision: 2, source: ref('old-A'), target: ref('old-B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 0 }, text: '[]', itemCount: 0 });
  const path = join(f.directory, 'contexts', 'context.json'), state = JSON.parse(await readFile(path, 'utf8'));
  state.attachments = Array.from({ length: 512 }, (_, index) => ({ ...state.attachments[0], operationId: `old-${index}`, target: ref(`old-B-${index}`) }));
  await writeFile(path, JSON.stringify(state));
  const restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
  expect((await restored.prepare(request)).phase).toBe('rejected'); expect(f.creates()).toBe(0);
});

test('actual serialized context byte exhaustion rejects before native creation', async () => {
  const f = await fixture();
  await f.service.contexts.attach({ operationId: 'old', roleId: 'old', roleRevision: 2, source: ref('old-A'), target: ref('old-B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 0 }, text: '[]', itemCount: 0 });
  const path = join(f.directory, 'contexts', 'context.json'), state = JSON.parse(await readFile(path, 'utf8'));
  const text = JSON.stringify([{ role: 'user', text: 'x'.repeat(1000000) }]);
  state.attachments = Array.from({ length: 8 }, (_, index) => ({ ...state.attachments[0], operationId: `old-${index}`, target: ref(`old-B-${index}`), text, itemCount: 1 }));
  await writeFile(path, JSON.stringify(state));
  f.ports.captureTimeline = async () => ({ entries: [{ item: { type: 'user_message', text: '\\'.repeat(250000) } }] as never, boundary: { epoch: 'e', seq: 1 }, capturedAt: '2026-10-10T00:00:00Z' });
  const restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
  expect((await restored.prepare(request)).phase).toBe('rejected'); expect(f.creates()).toBe(0);
});

test('known candidate read failure retains B and rejects before releasing A', async () => {
  const f = await fixture(), inspect = f.ports.inspect;
  f.ports.inspect = async source => { if (source.nativeSessionId === 'B') throw new Error('candidate read unavailable'); return inspect(source); };
  expect(await f.service.prepare(request)).toMatchObject({ phase: 'rejected', to: ref('B') });
  expect(f.creates()).toBe(1); expect(() => f.service.coordinator.assertAdmission(ref('A'))).not.toThrow();
  expect(await readFile(join(f.directory, 'contexts', 'context.json'), 'utf8')).toContain('old work');
});

test('cancels blocked creation, retains its late orphan, and never binds or recreates after restart', async () => {
  const f = await fixture(), entered = deferred<void>(), returned = deferred<ReturnType<typeof ref>>();
  let calls = 0;
  f.ports.createIdle = async (_source, operationId) => { calls++; expect(operationId).toBe('handoff:create'); entered.resolve(); return returned.promise; };
  const running = f.service.prepare(request);
  try {
    await entered.promise;
    expect((await f.service.coordinator.cancel('handoff')).phase).toBe('cancelled');
    expect(() => f.service.coordinator.assertAdmission(ref('A'))).not.toThrow();
    returned.resolve(ref('B'));
    expect((await running).phase).toBe('cancelled');
    expect(f.service.contexts.forTarget(ref('B'))).toBeUndefined();
    const saved = JSON.parse(await readFile(join(f.directory, 'roles', 'state.json'), 'utf8'));
    expect(JSON.stringify(saved)).toContain('orphanCandidate');
    const restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
    expect((await restored.prepare(request)).phase).toBe('cancelled');
    await expect(restored.commit('handoff', 1)).rejects.toThrow();
    expect(calls).toBe(1); expect(restored.store.read('role').role.current).toEqual(ref('A'));
  } finally { returned.resolve(ref('B')); await running.catch(() => undefined); }
});

test.each(['oversized', 'unserializable'] as const)('%s normalized history rejects before create', async kind => {
  const f = await fixture(), cyclic: any = {}; cyclic.self = cyclic;
  f.ports.captureTimeline = async () => ({ entries: [kind === 'oversized'
    ? { item: { type: 'user_message', text: '中'.repeat(400000) } }
    : { item: { type: 'tool_call', detail: { cyclic } } }] as never, boundary: { epoch: 'e', seq: 1 }, capturedAt: '2026-10-10T00:00:00Z' });
  expect((await f.service.prepare(request)).phase).toBe('rejected'); expect(f.creates()).toBe(0);
});

test.each(['not-started', 'create-started', 'candidate-known', 'ready'] as const)('restart of %s never replays create and permits only saved-stage recovery', async stage => {
  const f = await fixture();
  if (stage === 'ready') await f.service.prepare(request);
  else {
    await f.service.store.begin(request, true);
    if (stage !== 'not-started') {
      await f.service.contexts.prepare({ operationId: 'handoff', roleId: 'role', roleRevision: 2, source: ref('A'), text: '[{"role":"user","text":"saved context"}]', itemCount: 1, boundary: { epoch: 'e', seq: 1 }, capturedAt: '2026-10-10T00:00:00Z' });
      await f.service.store.savePreparation('handoff', { epoch: 'e', seq: 1, capturedAt: '2026-10-10T00:00:00Z' });
      await f.service.store.startCreation('handoff');
      if (stage === 'candidate-known') await f.service.store.saveCandidate('handoff', ref('B'));
    }
  }
  const creates = f.creates(), restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
  expect((await restored.prepare(request)).phase).toBe('unknown');
  if (stage === 'create-started') {
    await expect(restored.coordinator.reconcileReady('handoff')).rejects.toThrow(/unknown/);
    expect((await restored.coordinator.cancel('handoff')).phase).toBe('cancelled');
  } else expect((await restored.coordinator.reconcileReady('handoff')).phase).toBe(stage === 'not-started' ? 'rejected' : 'ready');
  expect(f.creates()).toBe(creates);
});

test('legacy unknown phases receive neither stage certification nor abandonment authority', async () => {
  const f = await fixture(); await f.service.store.begin(request);
  await f.service.store.advance('handoff', 'preparing', { phase: 'quiescing' });
  const path = join(f.directory, 'roles', 'state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  state.version = 3; delete state.roles[0].localPreparations; await writeFile(path, JSON.stringify(state));
  const restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
  await expect(restored.coordinator.cancel('handoff')).rejects.toThrow(/legacy|reconciliation/i);
  await expect(restored.coordinator.reconcileReady('handoff')).rejects.toThrow(/reconciliation/i);
  expect(restored.store.progress('handoff')).toBeUndefined(); expect(f.creates()).toBe(0);
  expect(() => restored.coordinator.assertAdmission(ref('A'))).toThrow(/reserved/);
});

test.each(['certification', 'creation identity', 'stage', 'reservation'] as const)('rejects contradictory saved %s without native recovery effects', async field => {
  const f = await fixture(); await f.service.prepare(request);
  const path = join(f.directory, 'roles', 'state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  const progress = state.roles[0].localPreparations[0];
  if (field === 'certification') delete progress.zeroInputAndTask;
  if (field === 'creation identity') progress.createOperationId = 'other:create';
  if (field === 'stage') progress.stage = 'create-started';
  if (field === 'reservation') progress.reservedBytes = '00000000';
  await writeFile(path, JSON.stringify(state));
  await expect(new SessionSuccessionService(f.directory, 'host', f.ports).ready).rejects.toThrow();
  expect(f.creates()).toBe(1);
});

test.each([ref('x'.repeat(513)), { ...ref('B'), extra: 'unbounded' }])('invalid native return keeps uncertainty but allows certified cancellation', async candidate => {
  const f = await fixture(); f.ports.createIdle = async () => candidate;
  expect((await f.service.prepare(request)).phase).toBe('unknown');
  expect(f.service.store.operation('handoff').to).toBeUndefined();
  expect((await f.service.coordinator.cancel('handoff')).phase).toBe('cancelled');
  expect((await f.service.prepare(request)).phase).toBe('cancelled');
});

test('late candidate read cannot bind context after cancellation', async () => {
  const f = await fixture(), entered = deferred<void>(), released = deferred<void>(), inspect = f.ports.inspect;
  f.ports.inspect = async source => { if (source.nativeSessionId === 'B') { entered.resolve(); await released.promise; } return inspect(source); };
  const running = f.service.prepare(request);
  try {
    await entered.promise;
    expect((await f.service.coordinator.cancel('handoff')).phase).toBe('cancelled');
    released.resolve(); expect((await running).phase).toBe('cancelled');
    expect(f.service.contexts.forTarget(ref('B'))).toBeUndefined();
  } finally { released.resolve(); await running.catch(() => undefined); }
});

const capture = { epoch: 'e', seq: 1, capturedAt: '2026-10-10T00:00:00Z' };
const creation = { status: 'created' as const, handle: { providerId: 'fixture', sessionId: 'B', opaque: 'original\nopaque' } };
test('selects native creation before durable preparation and retains its original result', async () => {
  const f = await fixture(); let creates = 0;
  f.ports.selectNativeCreation = async (_source, identity, provider) => {
    expect(identity).toBe('handoff:create'); expect(provider).toBe('fixture');
    expect(f.service.store.progress('handoff')?.capture).toBeUndefined();
    return async () => {
      creates++; expect(f.service.store.progress('handoff')?.nativeCreation).toBeDefined();
      return creation;
    };
  };
  expect((await f.service.prepare(request)).phase).toBe('ready');
  expect(f.service.store.progress('handoff')?.nativeCreation?.outcome).toEqual(creation);
  expect(creates).toBe(1); expect(f.creates()).toBe(0);
});
test.each(['known_rejected', 'unknown', 'typed', 'generic'] as const)('native creation %s never reads or binds a candidate', async kind => {
  const f = await fixture(), inspect = f.ports.inspect; let reads = 0;
  f.ports.inspect = async source => { if (source.nativeSessionId === 'B') reads++; return inspect(source); };
  f.ports.selectNativeCreation = async () => async () => {
    if (kind === 'typed') throw new AgentOperationRejectedError('native_evidence_unavailable', AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_unavailable);
    if (kind === 'generic') throw new Error('response lost');
    return { status: kind, ...(kind === 'known_rejected' ? { handle: creation.handle } : {}), code: 'native_evidence_outcome_unknown', reason: AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_outcome_unknown } as AgentEmptyCreationResult;
  };
  const result = await f.service.prepare(request);
  expect(result.phase).toBe(kind === 'typed' || kind === 'known_rejected' ? 'rejected' : 'unknown');
  expect(reads).toBe(0); expect(f.creates()).toBe(0); expect(f.service.contexts.forTarget(ref('B'))).toBeUndefined();
});
test('cancelled native creation retains late evidence without candidate revival', async () => {
  const f = await fixture(), entered = deferred<void>(), returned = deferred<AgentEmptyCreationResult>();
  f.ports.selectNativeCreation = async () => async () => { entered.resolve(); return returned.promise; };
  const running = f.service.prepare(request);
  try {
    await entered.promise; expect((await f.service.coordinator.cancel('handoff')).phase).toBe('cancelled');
    returned.resolve(creation); expect((await running).phase).toBe('cancelled');
    expect(f.service.store.progress('handoff')).toMatchObject({ orphanCandidate: ref('B'), nativeCreation: { outcome: creation } });
    expect(f.service.contexts.forTarget(ref('B'))).toBeUndefined();
  } finally { returned.resolve(creation); await running.catch(() => undefined); }
});
async function evidencePreparation() {
  const f = await fixture(); await f.service.store.begin(request, true);
  await f.service.store.savePreparation('handoff', capture, true);
  await f.service.store.startCreation('handoff'); return f;
}
test('stores the original creation result with B atomically, rejects replacements, and restores only readback evidence', async () => {
  const f = await evidencePreparation(), store = f.service.store;
  await store.saveCreationResult('handoff', creation);
  const saved = JSON.parse(await readFile(join(f.directory, 'roles', 'state.json'), 'utf8'));
  expect(saved.version).toBe(7); expect(saved.roles[0].operations[0].to).toEqual(ref('B'));
  expect(saved.roles[0].localPreparations[0].nativeCreation).toMatchObject({ version: 1, binding: expect.stringMatching(/^[a-f0-9]{64}$/), outcome: creation });
  expect(await store.saveCreationResult('handoff', creation)).toMatchObject({ to: ref('B') });
  await expect(store.saveCreationResult('handoff', { ...creation, handle: { ...creation.handle, opaque: 'runtime handle' } })).rejects.toThrow(/conflict/);
  await expect(store.saveCandidate('handoff', ref('C'))).rejects.toThrow();
  const restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
  expect(restored.store.progress('handoff')!.nativeCreation!.outcome).toEqual(creation);
  expect(restored.store.operation('handoff').phase).toBe('unknown'); expect(f.creates()).toBe(0);
});
test.each([false, true])('retains known-rejected B without reviving it (cancelled=%s)', async cancelled => {
  const f = await evidencePreparation(), store = f.service.store;
  if (cancelled) await store.settlePreparation('handoff', 'cancelled');
  const outcome = { ...creation, status: 'known_rejected' as const, code: 'native_evidence_invalid' as const, reason: 'Native evidence is malformed.' };
  await store.saveCreationResult('handoff', outcome);
  expect(store.operation('handoff').phase).toBe(cancelled ? 'cancelled' : 'rejected');
  expect(cancelled ? store.progress('handoff')!.orphanCandidate : store.operation('handoff').to).toEqual(ref('B'));
  expect(store.progress('handoff')!.nativeCreation!.outcome).toEqual(outcome);
  await expect(store.revalidateCandidate('handoff')).rejects.toThrow();
  await expect(store.advance('handoff', cancelled ? 'cancelled' : 'rejected', { phase: 'transferring' })).rejects.toThrow();
});
test('cancelled late successful creation retains its original outcome after restart', async () => {
  const f = await evidencePreparation(); await f.service.store.settlePreparation('handoff', 'cancelled');
  const restored = new SessionSuccessionService(f.directory, 'host', f.ports); await restored.ready;
  await restored.store.saveCreationResult('handoff', creation);
  expect(restored.store.operation('handoff')).toMatchObject({ phase: 'cancelled' });
  expect(restored.store.operation('handoff').to).toBeUndefined();
  expect(restored.store.progress('handoff')).toMatchObject({ orphanCandidate: ref('B'), nativeCreation: { version: 1, outcome: creation } });
});
test('only explicit typed pre-request evidence permits creation-start rejection; unknown remains uncertain', async () => {
  const f = await evidencePreparation();
  await expect(f.service.store.settlePreparation('handoff', 'rejected')).rejects.toThrow(/Unknown/);
  await f.service.store.rejectCreationBeforeDispatch('handoff', 'native_evidence_admission');
  expect(f.service.store.progress('handoff')!.nativeCreation!.outcome).toEqual({ status: 'not_dispatched', code: 'native_evidence_admission' });
  expect(f.service.store.operation('handoff').phase).toBe('rejected');
  await expect(f.service.store.saveCreationResult('handoff', creation)).rejects.toThrow(/conflict/);
  const g = await evidencePreparation();
  await g.service.store.saveCreationResult('handoff', { status: 'unknown', code: 'native_evidence_outcome_unknown', reason: 'The native operation outcome is unknown.' });
  expect(g.service.store.operation('handoff').phase).toBe('unknown'); expect(g.service.store.operation('handoff').to).toBeUndefined();
});
test('creation evidence cannot be attached to legacy admission or a different provider', async () => {
  const f = await fixture(); await f.service.store.begin(request, true); await f.service.store.savePreparation('handoff', capture); await f.service.store.startCreation('handoff');
  await expect(f.service.store.saveCreationResult('handoff', creation)).rejects.toThrow(/evidence/);
  const g = await evidencePreparation();
  await expect(g.service.store.saveCreationResult('handoff', { ...creation, handle: { ...creation.handle, providerId: 'other' } })).rejects.toThrow(/identity/);
  expect(g.service.store.operation('handoff').to).toBeUndefined();
});

test('creation restore rejects altered capture binding and evidence hidden in an old storage version', async () => {
  const f = await evidencePreparation(); await f.service.store.saveCreationResult('handoff', creation);
  const path = join(f.directory, 'roles', 'state.json'), original = await readFile(path, 'utf8');
  for (const mutate of [(state: any) => { state.roles[0].localPreparations[0].capture.seq++; }, (state: any) => { state.version = 6; }]) {
    const state = JSON.parse(original); mutate(state); await writeFile(path, JSON.stringify(state));
    await expect(new SessionSuccessionService(f.directory, 'host', f.ports).ready).rejects.toThrow();
  }
});


test('cancelled creation rejects a non-string local code without changing its durable outcome', async () => {
  const f = await evidencePreparation(), store = f.service.store; await store.settlePreparation('handoff', 'cancelled');
  const path = join(f.directory, 'roles', 'state.json'), before = await readFile(path);
  await expect(store.rejectCreationBeforeDispatch('handoff', ['native_evidence_admission'] as never)).rejects.toThrow();
  expect(await readFile(path)).toEqual(before); expect(store.progress('handoff')!.nativeCreation!.outcome).toBeUndefined();
  const accepted = await store.rejectCreationBeforeDispatch('handoff', 'native_evidence_admission');
  expect(accepted.phase).toBe('cancelled');
  expect(store.progress('handoff')!.nativeCreation!.outcome).toEqual({ status: 'not_dispatched', code: 'native_evidence_admission' });
  const retained = await readFile(path);
  expect(await store.rejectCreationBeforeDispatch('handoff', 'native_evidence_admission')).toEqual(accepted);
  expect(await readFile(path)).toEqual(retained);
});

test('restore rejects a non-string local code in cancelled evidence without rewriting the file', async () => {
  const f = await evidencePreparation(), store = f.service.store; await store.settlePreparation('handoff', 'cancelled');
  await store.rejectCreationBeforeDispatch('handoff', 'native_evidence_admission');
  const path = join(f.directory, 'roles', 'state.json'), disk = JSON.parse(await readFile(path, 'utf8'));
  disk.roles[0].localPreparations[0].nativeCreation.outcome.code = ['native_evidence_admission'];
  await writeFile(path, JSON.stringify(disk)); const before = await readFile(path);
  await expect(new SessionSuccessionService(f.directory, 'host', f.ports).ready).rejects.toThrow();
  expect(await readFile(path)).toEqual(before);
});
