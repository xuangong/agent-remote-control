// @vitest-environment node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createGatewayRelay } from './gateway-relay.js';

const secret = 'bootstrap-test-secret-01234567890123456789';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const request = (url: string, init?: RequestInit) => fetch(url, { ...init, headers: { connection: 'close', ...init?.headers }, signal: AbortSignal.timeout(8000) });
const event = (socket: WebSocket, name: string) => once(socket, name, { signal: AbortSignal.timeout(5000) });
function sign(type: string, claims: object) {
  const input = [{ alg: 'HS256', typ: type }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
}
async function fixture() {
  const calls: Array<{ operation: string; body: Record<string, string> }> = [];
  let upstreamStatus = 200; let disabled = false; let reply: unknown;
  let hold: Promise<void> | undefined; let entered: (() => void) | undefined;
  const authority = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const proof = (req.headers.authorization ?? '').slice(7).split('.');
    const claims = JSON.parse(Buffer.from(proof[1]!, 'base64url').toString());
    const input = JSON.parse(body);
    expect(JSON.parse(Buffer.from(proof[0]!, 'base64url').toString()).typ).toBe('arc-relay-service+jwt');
    expect(proof[2]).toBe(createHmac('sha256', secret).update(proof.slice(0, 2).join('.')).digest('base64url'));
    expect(claims.bodyHash).toBe(createHash('sha256').update(body).digest('base64url'));
    expect(claims.op).toBe(req.url!.split('/').at(-1));
    expect(claims.aud).toBe(issuer); expect(claims.iss).toBe(url);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    if (claims.op === 'host-key' || claims.op === 'revoke-host-key') {
      calls.push({ operation: claims.op, body: input });
      entered?.(); await hold;
      res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply ?? (claims.op === 'host-key' ? credentials : { ok: true })));
    } else {
      res.writeHead(disabled ? 403 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ active: !disabled, subject: input.subject ?? input.continuation, authenticatedAt: Date.now(), expiresAt: Date.now() + 3600_000, validUntil: Date.now() + 60_000 }));
    }
  });
  authority.listen(0, '127.0.0.1'); await once(authority, 'listening');
  cleanups.push(async () => { authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve())); });
  const address = authority.address(); if (!address || typeof address === 'string') throw Error('Missing authority');
  const issuer = `http://127.0.0.1:${address.port}`;
  const credentials = { apiKey: 'sk-host-private-secret', keyId: 'key-host', baseUrl: issuer + '/v1', model: 'gpt-5.4' };
  const directory = await mkdtemp(join(tmpdir(), 'arc-bootstrap-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let url = 'http://127.0.0.1:0'; let relay: ReturnType<typeof createGatewayRelay>;
  async function start() {
    relay = createGatewayRelay({ origin: url, issuer, secret, stateFile: join(directory, 'relay.json') });
    url = (await relay.listen(Number(new URL(url).port))).url;
  }
  await start(); cleanups.push(() => relay.close());
  async function login(subject: string) {
    const begin = await request(url + '/auth/login', { redirect: 'manual' });
    const iat = Math.floor(Date.now() / 1000);
    const ticket = sign('arc-relay+jwt', { iss: issuer, aud: url, sub: subject, nonce: new URL(begin.headers.get('location')!).searchParams.get('challenge'),
      iat, exp: iat + 900, jti: randomUUID(), continuation: subject, sessionExpiresAt: Date.now() + 3600_000 });
    const exchange = await request(url + '/auth/session', { method: 'POST', headers: { origin: url, cookie: begin.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
    const { basePath } = await exchange.json() as { basePath: string };
    const browser = (path: string, body?: unknown) => request(url + basePath + path, { headers: { origin: url, cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { browser, cookie };
  }
  async function enroll(browser: Awaited<ReturnType<typeof login>>['browser']) {
    const pairing = await (await browser('v1/remote/pairings', {})).json() as { key: string };
    const host = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pairing.key}` } });
    cleanups.push(async () => { host.terminate(); });
    await event(host, 'open'); const issued = event(host, 'message');
    host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId: randomUUID(), name: 'Docker Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    const key = JSON.parse((await issued)[0].toString()).credential as string;
    const saved = event(host, 'message'); host.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
    const hostId = JSON.parse((await saved)[0].toString()).hostId as string;
    return { host, key, invitation: pairing.key, hostId };
  }
  const bootstrap = (key: string, body = '{}', headers: Record<string, string> = {}, query = '') => request(url + '/v1/remote/host/bootstrap' + query, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body,
  });
  return { login, enroll, bootstrap, calls, credentials, restart: async () => { await relay.close(); await start(); },
    disable: () => { disabled = true; }, upstream: (status: number, value?: unknown) => { upstreamStatus = status; reply = value; },
    hold: () => { let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; }); return { entered: new Promise<void>(resolve => { entered = resolve; }), release }; } };
}

it('bootstraps only an enrolled device using its persisted owner and Host identity across restart', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  expect((await f.bootstrap(device.invitation)).status).toBe(401);
  const response = await f.bootstrap(device.key);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(f.credentials);
  expect(f.calls).toEqual([{ operation: 'host-key', body: { subject: 'alice', hostId: device.hostId, hostName: 'Docker Host' } }]);
  const bob = await f.login('bob'); const other = await f.enroll(bob.browser);
  expect((await f.bootstrap(other.key)).status).toBe(200);
  expect(f.calls.at(-1)?.body).toEqual({ subject: 'bob', hostId: other.hostId, hostName: 'Docker Host' });
  await f.restart(); expect((await f.bootstrap(device.key)).status).toBe(200);
}, 15000);

it('rejects ambient credentials and identity overrides before requesting a Gateway key', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  const ambientHeaders: Array<Record<string, string>> = [{ origin: 'http://evil.example' }, { cookie: alice.cookie }];
  for (const headers of ambientHeaders) expect((await f.bootstrap(device.key, '{}', headers)).status).toBe(403);
  for (const body of ['{"hostId":"other"}', '{"subject":"bob"}', '[]', 'null', 'invalid']) expect((await f.bootstrap(device.key, body)).status).toBe(400);
  expect((await f.bootstrap(device.key, '{}', {}, '?hostId=other')).status).toBe(400);
  expect((await f.bootstrap(device.key, 'x'.repeat(17000))).status).toBe(413);
  expect(f.calls).toEqual([]);
}, 15000);

it('fails closed on disabled owner, upstream errors and untrusted credential responses without exposing secrets', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  for (const [status, value] of [[503, { error: f.credentials.apiKey }], [200, { ...f.credentials, baseUrl: 'https://evil.example/v1' }], [200, { ...f.credentials, apiKey: 'x'.repeat(20000) }], [200, { ...f.credentials, model: 'bad\nmodel' }]] as const) {
    f.upstream(status, value); const response = await f.bootstrap(device.key);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(f.credentials.apiKey);
  }
  f.disable(); expect((await f.bootstrap(device.key)).status).toBe(403);
}, 15000);

it('keeps failed revocations retryable and revokes the Gateway key before deleting the device after restart', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  expect((await f.bootstrap(device.key)).status).toBe(200); await f.restart();
  const revoke = () => alice.browser(`v1/remote/hosts/${device.hostId}/revoke`, {});
  const bob = await f.login('bob'); expect((await bob.browser(`v1/remote/hosts/${device.hostId}/revoke`, {})).status).not.toBe(200);
  f.upstream(503, { error: f.credentials.apiKey }); expect((await revoke()).status).toBe(503);
  expect((await (await alice.browser('v1/remote/hosts')).json()).hosts).toHaveLength(1);
  f.upstream(200); expect((await revoke()).status).toBe(200);
  expect(f.calls.at(-1)).toEqual({ operation: 'revoke-host-key', body: { subject: 'alice', hostId: device.hostId, hostName: 'Docker Host' } });
  expect((await f.bootstrap(device.key)).status).toBe(401);
}, 15000);

it('validates owner revocation before contacting the Gateway', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  expect((await f.bootstrap(device.key)).status).toBe(200);
  expect((await alice.browser(`v1/remote/hosts/${device.hostId}/revoke`, [])).status).toBe(400);
  expect(f.calls.map(call => call.operation)).toEqual(['host-key']);
  expect((await f.bootstrap(device.key)).status).toBe(200);
}, 15000);

it('retries Gateway revocation after uncertain provisioning and preserves legacy Host revocation', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  f.upstream(503); expect((await f.bootstrap(device.key)).status).toBe(503);
  await f.restart(); f.upstream(200);
  expect((await alice.browser(`v1/remote/hosts/${device.hostId}/revoke`, {})).status).toBe(200);
  expect(f.calls.at(-1)?.operation).toBe('revoke-host-key');
  const legacy = await f.enroll(alice.browser); const previous = f.calls.length;
  f.upstream(503);
  expect((await alice.browser(`v1/remote/hosts/${legacy.hostId}/revoke`, {})).status).toBe(200);
  expect(f.calls).toHaveLength(previous);
}, 15000);

it('serializes pending provisioning before Gateway revocation and denies later bootstrap', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  const hold = f.hold(); const pending = f.bootstrap(device.key); await hold.entered;
  const revoked = alice.browser(`v1/remote/hosts/${device.hostId}/revoke`, {});
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.calls.map(call => call.operation)).toEqual(['host-key']);
  hold.release(); expect((await pending).status).toBe(200); expect((await revoked).status).toBe(200);
  expect(f.calls.map(call => call.operation)).toEqual(['host-key', 'revoke-host-key']);
  expect((await f.bootstrap(device.key)).status).toBe(401);
}, 15000);

it('rejects a credential rotated while its bootstrap response is pending', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const device = await f.enroll(alice.browser);
  const hold = f.hold(); const pending = f.bootstrap(device.key); await hold.entered;
  const issued = event(device.host, 'message');
  expect((await alice.browser(`v1/remote/hosts/${device.hostId}/rotate`, {})).status).toBe(200);
  const next = JSON.parse((await issued)[0].toString()).credential as string;
  const saved = event(device.host, 'message'); device.host.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })); await saved;
  hold.release(); expect((await pending).status).toBe(401);
  expect((await f.bootstrap(device.key)).status).toBe(401);
  expect((await f.bootstrap(next)).status).toBe(200);
}, 15000);
