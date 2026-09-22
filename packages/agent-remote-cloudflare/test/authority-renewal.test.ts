import { expect, it } from 'vitest';
import { fixture } from './fixture.js';

it('renews authority before the lease expires without browser requests or reconnecting the Host', async () => {
  const f = await fixture();
  f.setAuthority(200, 1600);
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket } = await f.host(pairing.key);
  const calls = f.authorityCalls;
  const closes: number[] = [];
  socket.addEventListener('close', event => closes.push(event.code));
  await new Promise(resolve => setTimeout(resolve, 4200));
  expect(closes).toEqual([]);
  expect(socket.readyState).toBe(1);
  expect(f.authorityCalls).toBeGreaterThan(calls + 1);
}, 15000);

it('retries a failed owner renewal before expiry while preserving the same Host socket', async () => {
  const f = await fixture(); f.setAuthority(200, 2000);
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket } = await f.host(pairing.key);
  const closes: number[] = [];
  socket.addEventListener('close', event => closes.push(event.code));
  f.failOwnerChecks(1);
  await new Promise(resolve => setTimeout(resolve, 4600));
  expect(closes).toEqual([]);
  expect(socket.readyState).toBe(1);
}, 15000);

it.each([403, 503])('still disconnects on denied or persistently unavailable authority (%s)', async status => {
  const f = await fixture(); f.setAuthority(200, 1600);
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket } = await f.host(pairing.key);
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
  f.setAuthority(status);
  expect(await closed).toBe(status === 403 ? 1008 : 1013);
}, 10000);

it('checks Host authority ahead of a bounded batch of browser renewals', async () => {
  const f = await fixture();
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket } = await f.host(pairing.key);
  for (let index = 0; index < 8; index++) await f.login('alice');
  f.delayRenewals(80);
  await f.inspect('alarm');
  expect(f.authorityOperations[0]).toBe('user-status');
  expect(f.peakRenewals).toBeLessThanOrEqual(4);
  expect(f.authorityOperations.filter(value => value === 'renew')).toHaveLength(9);
  expect(socket.readyState).toBe(1);
}, 15000);

it('rechecks Host authority during a long browser renewal batch', async () => {
  const f = await fixture(); f.setAuthority(200, 2000);
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket } = await f.host(pairing.key);
  for (let index = 0; index < 16; index++) await f.login('alice');
  const closes: number[] = [];
  socket.addEventListener('close', event => closes.push(event.code));
  f.delayRenewals(350);
  await f.inspect('alarm');
  expect(closes).toEqual([]);
  expect(f.authorityOperations.filter(value => value === 'user-status').length).toBeGreaterThanOrEqual(2);
  expect(f.peakRenewals).toBeLessThanOrEqual(4);
}, 15000);

it('delivers authority renewal failures and recovery to the owning Controller', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket } = await f.host(pairing.key);
  const entries: Array<Record<string, unknown>> = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'rpc_request') return;
    if (frame.path === '/remote/diagnostics/relay') entries.push(...JSON.parse(frame.body).entries);
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: frame.requestId,
      status: frame.path === '/remote/controller-update' ? 200 : 204, body: JSON.stringify({ diagnosticDelivery: 2 }) }));
  });
  f.failOwnerChecks(1); await f.inspect('alarm'); await f.inspect('alarm');
  await expect.poll(() => entries.filter(value => value.event === 'authority_refresh_completed').length).toBeGreaterThanOrEqual(2);
  expect(entries).toContainEqual(expect.objectContaining({ event: 'authority_refresh_completed', reason: 'authority_http_error', status: 503,
    durationMs: expect.any(Number), leaseRemainingMs: expect.any(Number), retryDelayMs: expect.any(Number) }));
  expect(entries).toContainEqual(expect.objectContaining({ event: 'authority_refresh_completed', reason: 'authority_active', status: 200 }));
  expect(JSON.stringify(entries)).not.toMatch(/Bearer|alice|continuation/);
}, 10000);
