// @vitest-environment node
import { createHmac, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { createGatewayRelay } from './gateway-relay.js';
const secret = 'lifecycle-test-secret-01234567890123456789';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
async function fixture() {
  let disabled = false; let unavailable = false;
  const authority = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const proof = (req.headers.authorization ?? '').slice(7).split('.');
    const claims = JSON.parse(Buffer.from(proof[1] ?? '', 'base64url').toString());
    expect(proof[2]).toBe(createHmac('sha256', secret).update(proof.slice(0, 2).join('.')).digest('base64url'));
    expect(claims.bodyHash).toBe(createHash('sha256').update(body).digest('base64url'));
    res.writeHead(unavailable ? 503 : disabled ? 401 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ active: !disabled, subject: 'alice', expiresAt: Date.now() + 3600_000, validUntil: Date.now() + 1500 }));
  }); authority.listen(0, '127.0.0.1'); await once(authority, 'listening');
  cleanups.push(async () => { authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve())); });
  const addr = authority.address(); if (!addr || typeof addr === 'string') throw Error();
  const issuer = `http://127.0.0.1:${addr.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'arc-lifecycle-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'relay.json');
  let relay: ReturnType<typeof createGatewayRelay>;
  let url: string;
  let closed = true;
  const start = async () => { relay = createGatewayRelay({ origin: url ?? 'http://127.0.0.1:0', issuer, secret, stateFile }); const address = await relay.listen(url ? Number(new URL(url).port) : 0); url = address.url; closed = false; };
  const stop = async () => { if (!closed) { closed = true; await relay.close(); } }; cleanups.push(stop);
  await start();
  const begin = await fetch(url! + '/auth/login', { redirect: 'manual' });
  const nonce = new URL(begin.headers.get('location')!).searchParams.get('challenge');
  const iat = Math.floor(Date.now() / 1000);
  const payload = { iss: issuer, aud: url!, sub: 'alice', nonce, iat, exp: iat + 900, jti: 'jti', continuation: 'opaque-test-continuation', sessionExpiresAt: Date.now() + 3600_000 };
  const input = [ { alg: 'HS256', typ: 'arc-relay+jwt' }, payload ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const ticket = input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
  const exchange = await fetch(url! + '/auth/session', { method: 'POST', headers: { origin: url!, cookie: begin.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  expect(exchange.status).toBe(200);
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  const state = await exchange.json() as { basePath: string; refreshAfterMs?: number };
  const request = (path: string, body?: unknown) => fetch(url! + path, { headers: { connection: 'close', origin: url!, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { get url() { return url!; }, state, request, cookie, ticket, start, stop, stateFile, disable: () => { disabled = true; }, outage: () => { unavailable = true; }, recover: () => { unavailable = false; } };
}
it('renews an opaque browser session, restores it after restart and revokes it on logout', async () => {
  const f = await fixture(); expect(f.cookie).not.toContain(f.ticket); expect(f.state.refreshAfterMs).toBeGreaterThan(0);
  const before = await (await f.request('/auth/status')).json();
  const renewed = await f.request('/auth/refresh', {}); expect(renewed.status).toBe(200);
  expect((await renewed.json()).expiresAt).toBeGreaterThanOrEqual(before.expiresAt);
  expect(await readFile(f.stateFile, 'utf8')).not.toContain(f.cookie.split('=')[1]);
  await f.stop(); await f.start(); expect((await f.request('/auth/status')).status).toBe(200);
  expect((await f.request('/auth/logout', {})).status).toBe(200);
  expect((await f.request('/auth/status')).status).toBe(401);
  await f.stop(); await f.start(); expect((await f.request('/auth/status')).status).toBe(401);
}, 10000);
it('fails closed when the original login is revoked or authority cannot renew its lease', async () => {
  const f = await fixture(); f.disable();
  expect((await f.request('/auth/refresh', {})).status).toBe(401);
  expect((await f.request('/auth/status')).status).toBe(401);
}, 10000);
it('restores enrolled Hosts with the same credentials and enforces device revocation', async () => {
  const f = await fixture(); const prefix = f.state.basePath;
  const pair = await (await f.request(prefix + 'v1/remote/pairings', {})).json();
  async function connect() {
    const host = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pair.key}` } });
    await once(host, 'open'); const result = once(host, 'message');
    host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'persistent', name: 'Saved Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    return { host, id: JSON.parse((await result)[0].toString()).hostId };
  }
  const first = await connect(); await f.stop(); await f.start(); const second = await connect(); expect(second.id).toBe(first.id);
  const closed = once(second.host, 'close');
  expect((await f.request(prefix + `v1/remote/hosts/${second.id}/revoke`, {})).status).toBe(200); await closed;
  expect(await (await f.request(prefix + 'v1/remote/hosts')).json()).toEqual({ hosts: [] });
}, 10000);

it('does not extend access during an authority outage', async () => {
  const f = await fixture(); const state = await (await f.request('/auth/status')).json(); f.outage();
  expect((await f.request('/auth/refresh', {})).status).toBe(503);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, state.expiresAt - Date.now() + 30)));
  expect((await f.request(f.state.basePath + 'v1/remote/hosts')).status).toBe(503);
}, 10000);

it('lets the production Host uplink reconnect after an authority outage without pairing again', async () => {
  const { createAgentRemoteRelay, createRemoteHostUplinkClient } = await import('@borgee/agent-remote-relay');
  const f = await fixture();
  const pair = await (await f.request(f.state.basePath + 'v1/remote/pairings', {})).json();
  const native = createAgentRemoteRelay({ providers: [] }); cleanups.push(() => native.close());
  const states: string[] = [];
  const uplink = createRemoteHostUplinkClient({ relay: native, installationId: 'automatic-reconnect', name: 'Recoverable Host',
    providers: [{ providerId: 'test', displayName: 'Test' }], remoteKey: pair.key, url: f.url.replace('http:', 'ws:') + '/ws/remote-host',
    resolveSession: () => undefined, control: async () => ({ status: 404, body: '{}' }),
    reconnectBaseDelayMs: 50, reconnectMaxDelayMs: 100, onStateChange: value => states.push(value) });
  cleanups.push(() => uplink.close()); await uplink.ready;
  f.outage();
  await vi.waitFor(() => expect(states).toContain('disconnected'), { timeout: 3500, interval: 20 });
  expect(states).not.toContain('rejected');
  await f.stop(); await f.start();
  f.recover();
  await vi.waitFor(() => expect(states.filter(value => value === 'registered')).toHaveLength(2), { timeout: 3500, interval: 20 });
  expect(states).not.toContain('rejected');
}, 10000);

it('enforces authority leases on Host upgrades that include a query string', async () => {
  const f = await fixture(); const pair = await (await f.request(f.state.basePath + 'v1/remote/pairings', {})).json();
  const host = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host?client=desktop', { headers: { authorization: `Bearer ${pair.key}` } });
  await once(host, 'open'); const registered = once(host, 'message');
  host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'query-peer', name: 'Query peer', providers: [{ providerId: 'test', displayName: 'Test' }] }));
  await registered; f.outage();
  expect((await once(host, 'close'))[0]).toBe(1013);
}, 5000);
