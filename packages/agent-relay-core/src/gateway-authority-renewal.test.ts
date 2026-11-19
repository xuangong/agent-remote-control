import { expect, it } from 'vitest';
import { send } from './test-utils/relay-harness.js';
import { world } from './test-utils/relay-world.js';

async function connectedHost(w: Awaited<ReturnType<typeof world>>) {
  const alice = await w.signIn('alice');
  const pairing = await (await w.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await w.host(pairing.key);
  const closes: number[] = [];
  host.socket.addEventListener('close', event => closes.push(event.code));
  return { alice, host, closes };
}

it('renews authority before the lease expires without browser requests or reconnecting the Host', async () => {
  const w = await world(); w.authority.answer(200, 1600);
  const { alice, host, closes } = await connectedHost(w);
  void alice;
  const calls = w.authority.calls;
  await w.advance(4200);
  expect(closes).toEqual([]);
  expect(host.socket.readyState).toBe(1);
  expect(w.authority.calls).toBeGreaterThan(calls + 1);
});

it('retries a failed owner renewal before expiry while preserving the same Host socket', async () => {
  const w = await world(); w.authority.answer(200, 2000);
  const { host, closes } = await connectedHost(w);
  w.authority.failOwnerChecks(1);
  await w.advance(4600);
  expect(closes).toEqual([]);
  expect(host.socket.readyState).toBe(1);
});

it.each([403, 503])('still disconnects on denied or persistently unavailable authority (%s)', async status => {
  const w = await world({ authorityOutageGraceMs: 0 }); w.authority.answer(200, 1600);
  const { closes } = await connectedHost(w);
  w.authority.answer(status);
  await w.advance(1700);
  expect(closes).toEqual([status === 403 ? 1008 : 1013]);
});

it('checks Host authority ahead of a bounded batch of browser renewals', async () => {
  const w = await world();
  const { host } = await connectedHost(w);
  for (let index = 0; index < 8; index++) await w.signIn('alice');
  w.authority.delayRenewals(80);
  const refresh = w.refreshNow(); await w.advance(1000); await refresh;
  expect(w.authority.operations[0]).toBe('user-status');
  expect(w.authority.peakRenewals).toBeLessThanOrEqual(4);
  expect(w.authority.operations.filter(value => value === 'renew')).toHaveLength(9);
  expect(host.socket.readyState).toBe(1);
});

it('rechecks Host authority during a long browser renewal batch', async () => {
  const w = await world(); w.authority.answer(200, 2000);
  const { closes } = await connectedHost(w);
  for (let index = 0; index < 16; index++) await w.signIn('alice');
  w.authority.delayRenewals(350);
  const refresh = w.refreshNow();
  await w.advance(2000); await refresh;
  expect(closes).toEqual([]);
  expect(w.authority.operations.filter(value => value === 'user-status').length).toBeGreaterThanOrEqual(2);
  expect(w.authority.peakRenewals).toBeLessThanOrEqual(4);
});

it('delivers authority renewal failures and recovery to the owning Controller', async () => {
  const w = await world();
  const { host } = await connectedHost(w);
  const entries: Array<Record<string, unknown>> = [];
  host.socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'rpc_request') return;
    if (frame.path === '/remote/diagnostics/relay') entries.push(...JSON.parse(frame.body).entries);
    send(host.socket, { type: 'rpc_response', requestId: frame.requestId, status: frame.path === '/remote/controller-update' ? 200 : 204, body: JSON.stringify({ diagnosticDelivery: 2 }) });
  });
  w.authority.failOwnerChecks(1); await w.refreshNow(); await w.refreshNow(); await w.advance(1000); await w.refreshNow(); await w.advance(1000);
  expect(entries.filter(value => value.event === 'authority_refresh_completed').length).toBeGreaterThanOrEqual(2);
  expect(entries).toContainEqual(expect.objectContaining({ event: 'authority_refresh_completed', reason: 'authority_http_error', status: 503,
    durationMs: expect.any(Number), leaseRemainingMs: expect.any(Number), retryDelayMs: expect.any(Number) }));
  expect(entries).toContainEqual(expect.objectContaining({ event: 'authority_refresh_completed', reason: 'authority_active', status: 200 }));
  expect(JSON.stringify(entries)).not.toMatch(/Bearer|alice|continuation/);
});

it('keeps a Host connected through an authority outage until the grace after its last confirmation ends', async () => {
  const w = await world({ authorityOutageGraceMs: 5000 }); w.authority.answer(200, 1600);
  const { host, closes } = await connectedHost(w);
  w.authority.answer(503);
  await w.advance(3000);
  expect(host.socket.readyState).toBe(1);
  await w.advance(3000);
  expect(closes).toEqual([1013]);
});

it('renews a browser session through an authority outage and stops at an explicit denial', async () => {
  const w = await world({ authorityOutageGraceMs: 60_000 }); w.authority.answer(200, 1600);
  const alice = await w.signIn('alice');
  w.authority.answer(503);
  const during = await w.json('/auth/refresh', alice.cookie, {});
  expect(during.status).toBe(200);
  expect((await during.json() as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now() + 30_000);
  w.authority.answer(403);
  expect((await w.json('/auth/refresh', alice.cookie, {})).status).toBe(401);
});
