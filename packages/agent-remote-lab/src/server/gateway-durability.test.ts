// @vitest-environment node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGatewayRelay } from './gateway-relay.js';

const secret = 'durability-test-secret-01234567890123456789';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
});
function sign(type: string, payload: Record<string, unknown>) {
  const input = [{ alg: 'HS256', typ: type }, payload]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
}
async function fixture() {
  const authority = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the signed request. */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ active: true, subject: 'alice', expiresAt: Date.now() + 3_600_000, validUntil: Date.now() + 120_000 }));
  });
  authority.listen(0, '127.0.0.1'); await once(authority, 'listening');
  cleanups.push(async () => { authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve())); });
  const address = authority.address();
  if (!address || typeof address === 'string') throw new Error('Authority did not listen');
  const issuer = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'arc-durability-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let url = 'http://127.0.0.1:0';
  let relay: ReturnType<typeof createGatewayRelay> | undefined;
  const start = async () => {
    relay = createGatewayRelay({ origin: url, issuer, secret, stateFile: join(directory, 'state.json') });
    url = (await relay.listen(Number(new URL(url).port))).url;
  };
  const stop = async () => { const active = relay; relay = undefined; await active?.close(); };
  cleanups.push(stop);
  await start();
  return { get url() { return url; }, issuer, restart: async () => { await stop(); await start(); } };
}

it('does not accept a consumed Gateway control proof after the Relay restarts', async () => {
  const f = await fixture();
  const body = JSON.stringify({ subject: 'alice', operation: 'hosts' });
  const iat = Math.floor(Date.now() / 1000);
  const proof = sign('arc-gateway-service+jwt', {
    iss: f.issuer, aud: f.url, op: 'control', bodyHash: createHash('sha256').update(body).digest('base64url'),
    iat, exp: iat + 60, jti: randomUUID(),
  });
  const request = () => fetch(f.url + '/gateway/control', {
    method: 'POST', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json' }, body,
  });
  expect((await request()).status).toBe(200);
  await f.restart();
  expect((await request()).status).toBe(401);
}, 10000);

it('preserves an unconsumed browser challenge through restart and consumes it exactly once', async () => {
  const f = await fixture();
  const begin = await fetch(f.url + '/auth/login?host=selected-host', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const location = begin.headers.get('location');
  const cookie = begin.headers.get('set-cookie')?.split(';')[0];
  if (!location || !cookie) throw new Error('Login did not issue a browser challenge');
  const iat = Math.floor(Date.now() / 1000);
  const ticket = sign('arc-relay+jwt', {
    iss: f.issuer, aud: f.url, sub: 'alice', nonce: new URL(location).searchParams.get('challenge'),
    iat, exp: iat + 900, jti: randomUUID(), continuation: 'opaque-fixture-continuation', sessionExpiresAt: Date.now() + 3_600_000,
  });
  const exchange = () => fetch(f.url + '/auth/session', {
    method: 'POST', signal: AbortSignal.timeout(5000), headers: { origin: f.url, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  await f.restart();
  const accepted = await exchange();
  expect(accepted.status).toBe(200);
  expect(accepted.headers.getSetCookie()).toHaveLength(2);
  expect(accepted.headers.getSetCookie()[0]).toContain('arc_session=');
  expect(accepted.headers.getSetCookie()[1]).toContain('arc_login=;');
  expect(await accepted.json()).toMatchObject({ hostId: 'selected-host' });
  await f.restart();
  expect((await exchange()).status).toBe(401);
}, 10000);
