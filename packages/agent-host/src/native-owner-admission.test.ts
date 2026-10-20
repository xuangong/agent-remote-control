import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { createOperationCache } from '@orchardworks/agent-remote-relay';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { admitNativeOwnerTransfer } from './native-owner-admission.js';
import { acquireNativeSession, inspectNativeOwner, type NativeSessionLease, type NativeOwnerIdentity } from './native-session-owner.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 5000);
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'fixture', nativeSessionId });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(options?: Parameters<typeof createOperationCache>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'arc-owner-admission-'));
  const contexts = new SessionSuccessionContextStore(join(root, 'contexts')); await contexts.ready;
  const cache = createOperationCache(options);
  const boundary = new SessionSuccessionBoundary(contexts, () => {}, () => undefined, cache);
  const leases: NativeSessionLease[] = [];
  cleanup.push(async () => { await Promise.all(leases.map(lease => lease.release())); await boundary.close(); await cache.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const key = { root: join(root, 'owners'), providerId: 'fixture', sessionId: 'A' };
  const acquire = async (takeOver?: string) => { const lease = await acquireNativeSession({ ...key, kind: takeOver ? 'native_cli' : 'controller', takeOver, requestTimeoutMs: 1500 }); leases.push(lease); return lease; };
  const old = await acquire();
  const current: NativeOwnerIdentity = { kind: 'controller', generation: old.generation };
  return { root, cache, boundary, old, current, key, acquire };
}

test('reserved source and candidate refuse loopback transfer before fields or stop; unrelated target proceeds', async () => {
  const f = await fixture(); let stops = 0;
  f.old.activate(async () => { stops++; return 'requested'; }, undefined,
    next => admitNativeOwnerTransfer(f.cache, f.boundary, [ref('A'), ref('B')], f.current, next));
  f.boundary.reserve('handoff', ref('A')); f.boundary.registerCandidate('handoff', ref('B'));
  await expect(f.acquire(f.old.generation)).rejects.toMatchObject({ code: 'succession_admission_closed' });
  expect(f.old.active).toBe(true); expect(stops).toBe(0); expect(await inspectNativeOwner(f.key)).toEqual(f.current);
  f.boundary.releaseReservation('handoff');
  f.boundary.reserve('unrelated', ref('C'));
  await f.acquire(f.old.generation); expect(stops).toBe(1);
}, 5000);

test('early cache capacity failure consumes rejection and leaves the owner active', async () => {
  const f = await fixture({ maxEntries: 1 }); let stops = 0;
  await f.cache.execute({ operationId: '00000000-0000-4000-8000-000000000001', scope: 'test', kind: 'read', target: 'C', parameters: {} }, { dispatch: async () => 'done' });
  f.old.activate(async () => { stops++; return 'requested'; }, undefined, next => admitNativeOwnerTransfer(f.cache, f.boundary, [ref('A')], f.current, next));
  await expect(f.acquire(f.old.generation)).rejects.toMatchObject({ code: 'succession_admission_closed' });
  expect(stops).toBe(0); expect(f.old.active).toBe(true); expect(f.boundary.pending(ref('A'))).toBe(0);
}, 5000);

test('one synchronous grant spans stop and owner publication; exact lease retries do not stop twice', async () => {
  const f = await fixture(); const entered = deferred(), finish = deferred(); let grants = 0, stops = 0; let nextIdentity!: NativeOwnerIdentity;
  f.old.activate(async () => { stops++; entered.resolve(); await finish.promise; return 'requested'; }, undefined, next => {
    grants++; nextIdentity = next;
    return admitNativeOwnerTransfer(f.cache, f.boundary, [ref('A'), ref('B')], f.current, next);
  });
  const opening = f.acquire(f.old.generation);
  try {
    await entered.promise;
    expect(f.old.active).toBe(false); expect(f.boundary.pending(ref('A'))).toBe(1); expect(f.boundary.pending(ref('B'))).toBe(1);
    expect(() => f.boundary.reserve('handoff', ref('A'))).toThrow(/unsettled/);
    const files = await readdir(f.key.root);
    const oldFile = files.find(name => !name.includes('.'))!, nextFile = files.find(name => name.includes('.reservation-'))!;
    const oldRecord = JSON.parse(await readFile(join(f.key.root, oldFile), 'utf8'));
    const nextRecord = JSON.parse(await readFile(join(f.key.root, nextFile), 'utf8'));
    const retry = fetch(`http://127.0.0.1:${oldRecord.port}/takeover`, { method: 'POST', headers: { authorization: oldRecord.token }, body: JSON.stringify(nextRecord), signal: AbortSignal.timeout(1500) });
    await new Promise(resolve => setTimeout(resolve, 25));
    finish.resolve(); const next = await opening; expect((await retry).status).toBe(200);
    expect(grants).toBe(1); expect(stops).toBe(1); expect(await inspectNativeOwner(f.key)).toMatchObject({ generation: next.generation });
    expect(() => admitNativeOwnerTransfer(f.cache, f.boundary, [ref('A'), ref('B')], f.current, nextIdentity)).toThrow(/admission/);
    f.boundary.reserve('settled', ref('A')); f.boundary.releaseReservation('settled');
  } finally { finish.resolve(); await opening.catch(() => undefined); }
}, 5000);

test('native stop failure retains unknown evidence and cleanup remains available', async () => {
  const f = await fixture(); let stops = 0;
  f.old.activate(async () => { stops++; throw new Error('unconfirmed stop'); }, undefined,
    next => admitNativeOwnerTransfer(f.cache, f.boundary, [ref('A')], f.current, next));
  await expect(f.acquire(f.old.generation)).rejects.toMatchObject({ code: 'native_handoff_unknown' });
  expect(stops).toBe(1); expect(f.boundary.pending(ref('A'))).toBe(0);
  expect(() => f.boundary.reserve('unknown', ref('A'))).toThrow(/unsettled/);
  await f.old.release(); expect(await inspectNativeOwner(f.key)).toBeUndefined();
}, 5000);

test('owner publication failure after native stop remains unknown', async () => {
  const f = await fixture(); const entered = deferred(), finish = deferred(); let stopped = false;
  f.old.activate(async () => { entered.resolve(); await finish.promise; stopped = true; return 'requested'; }, undefined,
    next => admitNativeOwnerTransfer(f.cache, f.boundary, [ref('A')], f.current, next));
  const opening = f.acquire(f.old.generation);
  try {
    await entered.promise;
    const reservation = (await readdir(f.key.root)).find(name => name.includes('.reservation-'))!;
    await rm(join(f.key.root, reservation)); finish.resolve();
    await expect(opening).rejects.toMatchObject({ code: 'native_handoff_unknown' });
    expect(stopped).toBe(true); expect(() => f.boundary.reserve('unknown', ref('A'))).toThrow(/unsettled/);
  } finally { finish.resolve(); await opening.catch(() => undefined); }
}, 5000);

test('bounded receipt timeout retains evidence; late known completion settles the native effect', async () => {
  const f = await fixture(); const entered = deferred(), finish = deferred();
  f.old.activate(async () => { entered.resolve(); await finish.promise; return 'requested'; }, undefined,
    next => admitNativeOwnerTransfer(f.cache, f.boundary, [ref('A')], f.current, next, 20));
  const opening = f.acquire(f.old.generation);
  try {
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 45));
    expect(f.boundary.pending(ref('A'))).toBe(0); expect(() => f.boundary.reserve('waiting', ref('A'))).toThrow(/unsettled/);
    finish.resolve(); await opening;
    f.boundary.reserve('known-late', ref('A')); f.boundary.releaseReservation('known-late');
  } finally { finish.resolve(); await opening.catch(() => undefined); }
}, 5000);
