import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createHostedRelay } from './gateway.js';
import { emptyRelayState, migrateLegacyNodeState, type HostedRelayState, type RelayStateStore } from './state.js';
import type { RelayScheduler } from './scheduler.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'portable-relay-secret-01234567890123456789' };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const scheduler: RelayScheduler = { schedule() {}, cancel() {} };
function setup(storage?: RelayStateStore, customScheduler = scheduler) {
  const relay = createHostedRelay({ ...auth, storage, scheduler: customScheduler }); closers.push(() => relay.close()); return relay;
}
function control(operation = 'hosts') {
  const body = JSON.stringify({ subject: 'alice', operation }); const iat = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'HS256', typ: 'arc-gateway-service+jwt' }, { iss: auth.issuer, aud: auth.origin, op: 'control',
    bodyHash: createHash('sha256').update(body).digest('base64url'), iat, exp: iat + 60, jti: randomUUID() }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const token = input + '.' + createHmac('sha256', auth.secret).update(input).digest('base64url');
  return () => new Request(auth.origin + '/gateway/control', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
}

it('awaits the alarm update before publishing a durable login challenge', async () => {
  const held = deferred<void>(); const entered = deferred<void>(); let schedules = 0;
  const relay = setup({ async commit() {} }, { schedule() { if (++schedules > 1) { entered.resolve(); return held.promise; } }, cancel() {} });
  let finished = false;
  const result = relay.fetch(new Request(auth.origin + '/auth/login')).then(response => { finished = true; return response; });
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 20));
  const early = finished; held.resolve(); await result;
  expect(early).toBe(false);
}, 10000);

it('commits a proof only once across concurrent requests and rejects it after restart', async () => {
  const held = deferred<void>(); const entered = deferred<void>(); let saved: HostedRelayState | undefined; let commits = 0;
  const relay = setup({ async commit(value) { commits += 1; entered.resolve(); await held.promise; saved = structuredClone(value); } });
  const request = control(); let finished = false;
  const first = relay.fetch(request()).then(response => { finished = true; return response; });
  await entered.promise; const second = relay.fetch(request());
  await new Promise(resolve => setTimeout(resolve, 20)); expect(finished).toBe(false);
  held.resolve();
  expect((await first)?.status).toBe(200); expect((await second)?.status).toBe(401); expect(commits).toBe(1);
  await relay.close();
  const restarted = setup({ initial: saved, async commit(value) { saved = value; } });
  expect((await restarted.fetch(request()))?.status).toBe(401);
}, 10000);

it('fails closed after a login challenge storage error without returning a cookie', async () => {
  const relay = setup({ async commit() { throw new Error('Disk is full'); } });
  const result = await relay.fetch(new Request(auth.origin + '/auth/login'));
  expect(result?.status).toBe(503); expect(result?.headers.getSetCookie()).toEqual([]);
  expect((await relay.fetch(control()()))?.status).toBe(503);
  expect((await relay.prepareUpgrade(new Request(auth.origin + '/ws/remote-host'))) as Response).toHaveProperty('status', 503);
}, 10000);

it('validates the portable state version and configuration and explicitly migrates authenticated Node v1 snapshots', () => {
  const legacy = { version: 1, sessions: [], tenants: [] };
  expect(() => setup({ initial: legacy, async commit() {} })).toThrow(/state/i);
  const migrated = migrateLegacyNodeState(legacy, auth);
  expect(migrated).toEqual(emptyRelayState(auth));
  const valid = emptyRelayState(auth);
  for (const initial of [null, { ...valid, version: 99 }, { ...valid, config: { ...valid.config, issuer: 'https://elsewhere.example' } },
    { ...valid, tenants: [{ subject: 'alice', namespace: 'forged', broker: {} }] }, { ...valid, consumedProofs: [['short', 100]] },
    { ...valid, loginChallenges: [['x'.repeat(43), { expiresAt: 'later' }]] }]) {
    expect(() => setup({ initial, async commit() {} })).toThrow(/state/i);
  }
}, 10000);

it('prunes expired replay records and schedules the earliest remaining durable deadline', async () => {
  const now = Date.now(); const initial = emptyRelayState(auth); const deadlines: number[] = [];
  initial.loginChallenges = [['x'.repeat(43), { expiresAt: now - 1 }], ['y'.repeat(43), { expiresAt: now + 30_000 }]];
  initial.consumedProofs = [['expired-proof-identifier', Math.floor(now / 1000) - 1]];
  let saved: HostedRelayState | undefined;
  const relay = setup({ initial, async commit(value) { saved = value; } }, { schedule(deadline) { deadlines.push(deadline); }, cancel() {} });
  await relay.refresh();
  expect(saved?.loginChallenges).toEqual([initial.loginChallenges[1]]); expect(saved?.consumedProofs).toEqual([]);
  expect(deadlines.at(-1)).toBe(now + 30_000);
}, 10000);
