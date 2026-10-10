import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { LocalSuccessionPreparation } from './local-succession-preparation.js';
import { SessionReferenceStore } from './session-reference.js';
import { SessionSuccessionService, type SessionSuccessionPorts } from './session-succession-service.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename), unlink: vi.fn(original.unlink), link: vi.fn(original.link) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); const original = await vi.importActual<typeof fs>('node:fs/promises'); for (const name of ['open', 'rename', 'unlink', 'link'] as const) { vi.mocked(fs[name]).mockReset(); vi.mocked(fs[name]).mockImplementation(original[name] as never); } await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: ref('A') };
async function root() { const directory = await fs.mkdtemp(join(tmpdir(), 'succession-durable-')); roots.push(directory); return directory; }
async function enteredWithinDeadline(entered: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Publication barrier was not entered.')), 1000); })]); }
  finally { clearTimeout(timer); }
}

const sourceGrant = (sourceNativeSessionId = 'A', sessionId = 'reader') => ({ sourceNativeSessionId, systemPrompt: '', systemPromptProvided: false,
  instructions: 'Original instructions', handle: { providerId: 'fixture', sessionId, opaque: 'opaque native handle' } });
test.each(['sync', 'close'] as const)('grant temporary %s failure preserves the preceding exact grant', async phase => {
  const directory = await root(), store = new SessionReferenceStore(directory, 'fixture'); await store.set(sourceGrant());
  const original = await vi.importActual<typeof fs>('node:fs/promises'), failure = new Error(`temporary ${phase} unavailable`);
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[1] === 'wx') {
      if (phase === 'sync') vi.spyOn(file, 'sync').mockRejectedValue(failure);
      else { const close = file.close.bind(file); vi.spyOn(file, 'close').mockImplementation(async () => { await close(); throw failure; }); }
    }
    return file;
  });
  await expect(store.set(sourceGrant('B'))).rejects.toMatchObject({ code: 'succession_publication_rejected', cause: failure });
  expect(await store.get('reader')).toEqual(sourceGrant());
  expect(await new SessionReferenceStore(directory, 'fixture').get('reader')).toEqual(sourceGrant());
});

test('grant replacement refusal withholds success and cleanup cannot mask its first cause; reopening retains the preceding file', async () => {
  const directory = await root(), store = new SessionReferenceStore(directory, 'fixture'); await store.set(sourceGrant());
  const refusal = Object.assign(new Error('replacement refused'), { code: 'EACCES' }), cleanup = new Error('temporary cleanup failed');
  vi.mocked(fs.rename).mockRejectedValueOnce(refusal); vi.mocked(fs.unlink).mockRejectedValueOnce(cleanup);
  const failure = await store.set(sourceGrant('B')).catch(error => error);
  expect(failure).toMatchObject({ code: 'succession_publication_unknown' });
  expect(failure.cause === refusal || failure.cause?.errors?.[0] === refusal).toBe(true);
  await expect(store.get('reader')).rejects.toThrow(/unknown|restart/i);
  expect(await new SessionReferenceStore(directory, 'fixture').get('reader')).toEqual(sourceGrant());
});

test.each(['open', 'sync', 'close'] as const)('grant directory %s failure fences old reads, listing and queued writes until fresh validated reopen', async phase => {
  const directory = await root(), store = new SessionReferenceStore(directory, 'fixture'); await store.set(sourceGrant());
  const original = await vi.importActual<typeof fs>('node:fs/promises'), failure = new Error(`directory ${phase} failed`);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] === directory && args[1] === 'r' && phase === 'open') { enter(); await gate; throw failure; }
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') {
      const close = file.close.bind(file);
      if (phase === 'sync') vi.spyOn(file, 'sync').mockImplementation(async () => { enter(); await gate; throw failure; });
      else vi.spyOn(file, 'close').mockImplementation(async () => { await close(); enter(); await gate; throw failure; });
    }
    return file;
  });
  const writing = store.set(sourceGrant('B')), outcome = writing.then(() => undefined, error => error);
  try {
    await enteredWithinDeadline(entered);
    const queued = store.set(sourceGrant('C', 'other')), queuedOutcome = queued.then(() => undefined, error => error);
    release(); expect(await outcome).toMatchObject({ code: 'succession_publication_unknown', cause: failure }); expect((await queuedOutcome)?.message).toMatch(/unknown|restart/i);
    await expect(store.get('reader')).rejects.toThrow(/unknown|restart/i); await expect(store.list()).rejects.toThrow(/unknown|restart/i);
    await expect(store.set(sourceGrant('C'))).rejects.toThrow(/unknown|restart/i);
    vi.mocked(fs.open).mockImplementation(original.open);
    const reopened = new SessionReferenceStore(directory, 'fixture'); expect(await reopened.get('reader')).toEqual(sourceGrant('B'));
    expect(await reopened.list()).toEqual([{ nativeSessionId: 'reader', sourceNativeSessionId: 'B' }]);
    expect(await reopened.get('other')).toBeUndefined();
  } finally { release(); await writing.catch(() => undefined); }
});

test('grant rename that acts before rejecting stays unknown and never serves the preceding authority', async () => {
  const directory = await root(), store = new SessionReferenceStore(directory, 'fixture'); await store.set(sourceGrant());
  const original = await vi.importActual<typeof fs>('node:fs/promises'), failure = Object.assign(new Error('rename outcome lost'), { code: 'EIO' });
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => { await original.rename(...args); throw failure; });
  await expect(store.set(sourceGrant('B'))).rejects.toMatchObject({ code: 'succession_publication_unknown', cause: failure });
  await expect(store.get('reader')).rejects.toThrow(/unknown|restart/i);
  expect(await new SessionReferenceStore(directory, 'fixture').get('reader')).toEqual(sourceGrant('B'));
});

test.each(['temporary', 'directory', 'windows-directory'] as const)('grant %s sync/close faults retain their first cause without changing the publication phase', async phase => {
  const directory = await root(), store = new SessionReferenceStore(directory, 'fixture'); await store.set(sourceGrant());
  const original = await vi.importActual<typeof fs>('node:fs/promises'), first = new Error('fatal sync failure'), closeFailure = Object.assign(new Error('close failure'), { code: 'EINVAL' });
  if (phase === 'windows-directory') vi.stubGlobal('process', { ...process, platform: 'win32' });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (phase === 'temporary' ? args[1] === 'wx' : args[0] === directory && args[1] === 'r') {
      const close = file.close.bind(file); vi.spyOn(file, 'sync').mockRejectedValue(first);
      vi.spyOn(file, 'close').mockImplementation(async () => { await close(); throw closeFailure; });
    }
    return file;
  });
  const failure = await store.set(sourceGrant('B')).catch(error => error);
  expect(failure.code).toBe(phase === 'temporary' ? 'succession_publication_rejected' : 'succession_publication_unknown');
  expect(failure.cause).toBeInstanceOf(AggregateError); expect(failure.cause.errors).toEqual([first, closeFailure]); expect(failure.cause.cause).toBe(first);
  vi.unstubAllGlobals(); vi.mocked(fs.open).mockImplementation(original.open);
  expect(await new SessionReferenceStore(directory, 'fixture').get('reader')).toEqual(sourceGrant(phase === 'temporary' ? 'A' : 'B'));
});

test.each(['role', 'context'] as const)('a rejected %s rename fences the owner and reopened interrupted work stays unknown', async owner => {
  const directory = await root(), original = await vi.importActual<typeof fs>('node:fs/promises');
  const role = new SessionSuccessionStore(directory), context = new SessionSuccessionContextStore(directory); await Promise.all([role.ready, context.ready]);
  if (owner === 'role') await role.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  else await context.attach({ operationId: 'op', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 1 }, text: '[]', itemCount: 0 });
  const failure = Object.assign(new Error('rename response lost'), { code: 'EIO' });
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => { await original.rename(...args); throw failure; });
  if (owner === 'role') {
    await expect(role.begin(request)).rejects.toMatchObject({ code: 'succession_publication_unknown', cause: failure });
    expect(() => role.read('role')).toThrow(/unknown|restart/i); await expect(role.begin({ ...request, operationId: 'another' })).rejects.toThrow(/unknown|restart/i);
    const reopened = new SessionSuccessionStore(directory); await reopened.ready; expect(reopened.operation('op').phase).toBe('unknown');
  } else {
    await expect(context.begin('op', { operationId: 'input', roleId: 'role', roleRevision: 2, target: ref('B'), text: 'work' })).rejects.toMatchObject({ code: 'succession_publication_unknown', cause: failure });
    expect(() => context.read('op')).toThrow(/unknown|restart/i);
    const reopened = new SessionSuccessionContextStore(directory); await reopened.ready; expect(reopened.read('op').state).toBe('unknown');
  }
});

const unusedPorts: SessionSuccessionPorts = { supports: async () => false, inspect: async () => { throw new Error('unused fixture'); },
  createIdle: async () => { throw new Error('unexpected native create'); }, captureTimeline: async () => { throw new Error('unused fixture'); },
  authorizeRead: async () => {}, readHistory: async () => ({ entries: [] }), reconcileDelivery: async () => undefined };
test.each(['open', 'sync', 'close'] as const)('cursor directory %s failure withholds readiness and fresh reopen keeps the installed key', async phase => {
  const directory = await root(), original = await vi.importActual<typeof fs>('node:fs/promises'), failure = new Error(`cursor directory ${phase} failed`);
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] === directory && args[1] === 'r' && phase === 'open') throw failure;
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') {
      if (phase === 'sync') vi.spyOn(file, 'sync').mockRejectedValue(failure);
      else { const close = file.close.bind(file); vi.spyOn(file, 'close').mockImplementation(async () => { await close(); throw failure; }); }
    }
    return file;
  });
  const service = new SessionSuccessionService(directory, 'host', unusedPorts);
  await expect(service.ready).rejects.toBe(failure); expect(() => service.bindings('fixture')).toThrow(/not ready/);
  const key = await fs.readFile(join(directory, 'source-cursor.key')); expect(key.length).toBe(32);
  vi.mocked(fs.open).mockImplementation(original.open);
  const reopened = new SessionSuccessionService(directory, 'host', unusedPorts); await reopened.ready;
  expect(await fs.readFile(join(directory, 'source-cursor.key'))).toEqual(key);
});

test('concurrent cursor installation reads the winning original key and both services wait for the directory barrier', async () => {
  const directory = await root(), original = await vi.importActual<typeof fs>('node:fs/promises');
  let installers = 0, releaseInstall!: () => void, enterBarrier!: () => void, releaseBarrier!: () => void;
  const installed = new Promise<void>(resolve => { releaseInstall = resolve; }), entered = new Promise<void>(resolve => { enterBarrier = resolve; }), gate = new Promise<void>(resolve => { releaseBarrier = resolve; });
  vi.mocked(fs.link).mockImplementation(async (...args) => { if (++installers === 2) releaseInstall(); await installed; await original.link(...args); });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') vi.spyOn(file, 'sync').mockImplementation(async () => { enterBarrier(); await gate; });
    return file;
  });
  const first = new SessionSuccessionService(directory, 'host', unusedPorts), second = new SessionSuccessionService(directory, 'host', unusedPorts);
  try {
    await enteredWithinDeadline(entered); expect(installers).toBe(2); expect(() => first.bindings('fixture')).toThrow(/not ready/); expect(() => second.bindings('fixture')).toThrow(/not ready/);
    const key = await fs.readFile(join(directory, 'source-cursor.key')); releaseBarrier(); await Promise.all([first.ready, second.ready]);
    expect(await fs.readFile(join(directory, 'source-cursor.key'))).toEqual(key);
    vi.mocked(fs.open).mockImplementation(original.open); vi.mocked(fs.link).mockImplementation(original.link);
    const reopened = new SessionSuccessionService(directory, 'host', unusedPorts); await reopened.ready;
    expect(await fs.readFile(join(directory, 'source-cursor.key'))).toEqual(key);
  } finally { releaseInstall(); releaseBarrier(); await Promise.allSettled([first.ready, second.ready]); }
});

test('cursor cleanup cannot replace an initialization failure and successful install cleanup failure also withholds readiness', async () => {
  for (const failSync of [true, false]) {
    const directory = await root(), original = await vi.importActual<typeof fs>('node:fs/promises'), first = new Error('cursor file sync failed'), cleanup = new Error('cursor cleanup failed');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await original.open(...args);
      if (failSync && String(args[0]).includes('source-cursor.key.') && args[1] === 'wx') vi.spyOn(file, 'sync').mockRejectedValue(first);
      return file;
    });
    vi.mocked(fs.unlink).mockRejectedValueOnce(cleanup);
    const service = new SessionSuccessionService(directory, 'host', unusedPorts), failure = await service.ready.catch(error => error);
    if (failSync) expect(failure === first || failure.errors?.[0] === first || failure.cause === first).toBe(true);
    else expect(failure).toBe(cleanup);
    expect(() => service.bindings('fixture')).toThrow(/not ready/);
    vi.mocked(fs.open).mockImplementation(original.open); vi.mocked(fs.unlink).mockImplementation(original.unlink);
    const reopened = new SessionSuccessionService(directory, 'host', unusedPorts); await reopened.ready;
    expect((await fs.readFile(join(directory, 'source-cursor.key'))).length).toBe(32);
  }
});

test('cursor install conflict preserves a corrupt winning key and its validation cause through cleanup failure', async () => {
  const directory = await root(), original = await vi.importActual<typeof fs>('node:fs/promises'), cleanup = new Error('temporary cursor cleanup failed');
  vi.mocked(fs.link).mockImplementationOnce(async (...args) => { await original.writeFile(join(directory, 'source-cursor.key'), 'invalid'); await original.link(...args); });
  vi.mocked(fs.unlink).mockRejectedValueOnce(cleanup);
  const service = new SessionSuccessionService(directory, 'host', unusedPorts), failure = await service.ready.catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors[0].message).toMatch(/signing key/); expect(failure.errors[1]).toBe(cleanup);
  expect(() => service.bindings('fixture')).toThrow(/not ready/); expect(await fs.readFile(join(directory, 'source-cursor.key'), 'utf8')).toBe('invalid');
});

test('source complete-result pre-rename failure retains the exact admission and its restart-reconstructed allowance', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  const sourceWitness = { version: 1 as const, scope: 'scope', operationId: 'source-operation' };
  const id = createHash('sha256').update(JSON.stringify([sourceWitness.scope, sourceWitness.operationId])).digest('hex');
  await store.admitAssociation(id, 'fingerprint', ref('A'), true, undefined, sourceWitness);
  const prior = await fs.readFile(join(directory, 'state.json'), 'utf8');
  vi.mocked(fs.open).mockRejectedValueOnce(new Error('temporary result write unavailable'));
  await expect(store.completeSourceAssociation({ id, fingerprint: 'fingerprint', scope: 'scope', operationId: 'source-operation', source: ref('A'), reader: ref('\ud800'.repeat(512)) })).rejects.toMatchObject({ code: 'succession_publication_rejected' });
  expect(store.sourceResult(id, 'fingerprint')).toBeUndefined(); expect(await fs.readFile(join(directory, 'state.json'), 'utf8')).toBe(prior);
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  await expect(restored.admitAssociation(id, 'fingerprint', ref('A'), true, undefined, sourceWitness)).rejects.toThrow(/unresolved/);
  await restored.completeSourceAssociation({ id, fingerprint: 'fingerprint', scope: 'scope', operationId: 'source-operation', source: ref('A'), reader: ref('\ud800'.repeat(512)) });
  expect(restored.sourceResult(id, 'fingerprint')!.reader).toEqual(ref('\ud800'.repeat(512)));
});

test('source complete-result directory-sync uncertainty withholds in-memory settlement until exact restart readback', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  const sourceWitness = { version: 1 as const, scope: 'scope', operationId: 'source-operation' };
  const id = createHash('sha256').update(JSON.stringify([sourceWitness.scope, sourceWitness.operationId])).digest('hex');
  await store.admitAssociation(id, 'fingerprint', ref('A'), true, undefined, sourceWitness);
  const original = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') vi.spyOn(file, 'sync').mockRejectedValue(new Error('source result durability unknown'));
    return file;
  });
  await expect(store.completeSourceAssociation({ id, fingerprint: 'fingerprint', scope: 'scope', operationId: 'source-operation', source: ref('A'), reader: ref('B') })).rejects.toMatchObject({ code: 'succession_publication_unknown' });
  expect(() => store.sourceResult(id, 'fingerprint')).toThrow(/unknown|restart/i);
  await expect(store.settleAssociation(id, 'fingerprint')).rejects.toThrow(/unknown|restart/i);
  vi.mocked(fs.open).mockImplementation(original.open);
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.sourceResult(id, 'fingerprint')!.reader).toEqual(ref('B'));
  expect(JSON.parse(await fs.readFile(join(directory, 'state.json'), 'utf8')).associationAdmissions).toEqual([]);
});

test('role directory-sync uncertainty poisons reads and admission until restart readback', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  const original = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') vi.spyOn(file, 'sync').mockRejectedValue(new Error('directory durability lost'));
    return file;
  });
  await expect(store.begin(request)).rejects.toMatchObject({ code: 'succession_publication_unknown' });
  expect(() => store.read('role')).toThrow(/unknown|restart/i);
  expect(() => store.generation).toThrow(/unknown|restart/i);
  await expect(store.begin({ ...request, operationId: 'other' })).rejects.toThrow(/unknown|restart/i);
  vi.mocked(fs.open).mockImplementation(original.open);
  const reopened = new SessionSuccessionStore(directory); await reopened.ready;
  expect(reopened.operation('op').phase).toBe('unknown');
});

test('native acceptance stores only the SDK disposition and admits proof without replacing old evidence', async () => {
  const directory = await root(), store = new SessionSuccessionContextStore(directory); await store.ready;
  await store.attach({ operationId: 'op', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 1 }, text: '[]', itemCount: 0 });
  await store.begin('op', { operationId: 'input', roleId: 'role', roleRevision: 2, target: ref('B'), text: 'work' });
  const receipt = await store.settle('op', 'input', 'accepted', { disposition: 'queued', extra: 'x'.repeat(9 * 1024 * 1024) } as never);
  expect(receipt.inputAcceptance).toEqual({ disposition: 'queued' });
  await expect(store.reconcile('op', { operationId: 'input', roleRevision: 2, target: ref('B'), outcome: 'materialized', nativeEvidence: 'x'.repeat(9 * 1024 * 1024) })).rejects.toThrow(/capacity|limit/i);
  expect(store.delivery('input')).toEqual(receipt);
});

test('a pre-rename cancellation failure preserves the durable operation and source gate', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  await store.begin(request, true);
  const coordinator = new SessionSuccessionCoordinator(store, new LocalSuccessionPreparation('host', 'fixture', {} as never));
  vi.mocked(fs.open).mockRejectedValueOnce(new Error('cannot open temporary state'));
  await expect(coordinator.cancel('op')).rejects.toMatchObject({ code: 'succession_publication_rejected' });
  expect(store.operation('op').phase).toBe('preparing');
  expect(JSON.parse(await fs.readFile(join(directory, 'state.json'), 'utf8')).roles[0].operations[0].phase).toBe('preparing');
  expect(() => coordinator.assertAdmission(ref('A'))).toThrow(/reserved/);
});

test('context directory-sync uncertainty poisons reads and settlement until restart readback', async () => {
  const directory = await root(), store = new SessionSuccessionContextStore(directory); await store.ready;
  await store.attach({ operationId: 'op', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 1 }, text: '[]', itemCount: 0 });
  const original = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') vi.spyOn(file, 'sync').mockRejectedValue(new Error('directory durability lost'));
    return file;
  });
  await expect(store.begin('op', { operationId: 'input', roleId: 'role', roleRevision: 2, target: ref('B'), text: 'work' })).rejects.toMatchObject({ code: 'succession_publication_unknown' });
  expect(() => store.read('op')).toThrow(/unknown|restart/i);
  await expect(store.settle('op', 'input', 'rejected')).rejects.toThrow(/unknown|restart/i);
  vi.mocked(fs.open).mockImplementation(original.open);
  const restored = new SessionSuccessionContextStore(directory); await restored.ready;
  expect(restored.delivery('input')!.state).toBe('unknown');
});
