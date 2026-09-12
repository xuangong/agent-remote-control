// @vitest-environment node
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createGatewayRelay } from './gateway-relay.js';

const secret = 'test-only-32-byte-secret-value-0123456789';
const issuer = 'https://gateway.example';
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });
function ticket(audience: string, sub = 'alice', changes: Record<string, unknown> = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'arc-relay+jwt' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub, nonce: 'n'.repeat(43), iat, exp: iat + 900, jti: crypto.randomUUID(), ...changes })).toString('base64url');
  const value = `${head}.${payload}`;
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}
async function setup(options = {}) {
  const relay = createGatewayRelay({ origin: 'http://127.0.0.1:0', issuer, secret, ...options });
  close = () => relay.close();
  const { url } = await relay.listen(0);
  const begin = async () => {
    const response = await fetch(url + '/auth/login', { redirect: 'manual' });
    expect(response.status).toBe(303);
    return { cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '', nonce: new URL(response.headers.get('location')!).searchParams.get('challenge')! };
  };
  const login = async (sub: string) => {
    const pending = await begin();
    const grant = ticket(url, sub, { nonce: pending.nonce });
    const res = await fetch(url + '/auth/session', { method: 'POST', headers: { origin: url, cookie: pending.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: grant }) });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    const state = await res.json() as { basePath: string };
    const request = (path: string, body?: unknown) => fetch(url + state.basePath + path, { headers: { cookie, origin: url, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { cookie, state, request, grant };
  };
  return { url, login, begin };
}
function rejected(url: string, headers = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace('http:', 'ws:'), { headers, handshakeTimeout: 1000 });
    socket.on('error', () => undefined);
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected accepted upgrade')); });
    socket.once('unexpected-response', (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
  });
}
it('isolates real Host registration, catalog and session forwarding by gateway user', async () => {
  const f = await setup(); const alice = await f.login('alice'); const bob = await f.login('bob');
  const pair = await (await alice.request('v1/remote/pairings', {})).json() as { key: string; serverUrl: string };
  expect(pair.serverUrl).toBe(f.url);
  const host = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pair.key}` } });
  await once(host, 'open');
  const registered = once(host, 'message');
  host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'same-installation', name: 'Alice Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const [raw] = await registered;
  const hostId = (JSON.parse(raw.toString()) as { hostId: string }).hostId;
  host.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'rpc_request') host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(message.path === '/remote/attach' ? { agentId: 'private-agent', nativeSessionId: 'native-1' } : { private: 'alice' }) }));
    if (message.type === 'stream_open') {
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId: message.streamId }));
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: 'alice-event' }));
    }
  });
  expect(await (await alice.request('v1/remote/hosts')).json()).toMatchObject({ hosts: [{ id: hostId, online: true }] });
  expect(await (await bob.request('v1/remote/hosts')).json()).toEqual({ hosts: [] });
  expect((await bob.request(`v1/remote/hosts/${hostId}/catalog?providerId=codex`)).status).toBe(404);
  expect((await fetch(f.url + alice.state.basePath + 'v1/remote/hosts', { headers: { cookie: bob.cookie } })).status).toBe(403);
  expect((await alice.request(`v1/remote/hosts/${hostId}/attach`, { providerId: 'codex', nativeSessionId: 'native-1' })).status).toBe(200);
  expect(await (await alice.request('v1/sessions/private-agent/snapshot')).json()).toEqual({ private: 'alice' });
  expect((await bob.request('v1/sessions/private-agent/snapshot')).status).toBe(404);
  expect(await rejected(f.url + bob.state.basePath + 'v1/sessions/private-agent/events', { cookie: bob.cookie, origin: f.url })).toBe(404);
  const stream = new WebSocket((f.url + alice.state.basePath + 'v1/sessions/private-agent/events').replace('http:', 'ws:'), { headers: { cookie: alice.cookie, origin: f.url } });
  const event = once(stream, 'message');
  expect((await event)[0].toString()).toBe('alice-event');
  stream.close(); host.close();
}, 10000);
it('rejects unauthenticated, tampered, expired and wrong-audience requests before dispatch', async () => {
  const f = await setup();
  expect((await fetch(f.url + '/v1/remote/hosts')).status).toBe(401);
  for (const value of [ticket(f.url) + 'bad', ticket(f.url, 'alice', { exp: 0 }), ticket('https://other.example'), ticket(f.url, 'alice', { iat: 1, exp: 9999999999 })]) {
    expect((await fetch(f.url + '/auth/session', { method: 'POST', headers: { origin: f.url, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: value }) })).status).toBe(401);
  }
  expect(await rejected(f.url + '/ws/remote-host')).toBe(401);
  const alice = await f.login('alice');
  expect(await rejected(f.url + '/ws/remote-host', { authorization: `Bearer ${alice.grant}` })).toBe(401);
  const pair = await (await alice.request('v1/remote/pairings', {})).json() as { key: string };
  expect((await fetch(f.url + alice.state.basePath + 'v1/remote/hosts', { headers: { authorization: `Bearer ${pair.key}` } })).status).toBe(401);
}, 10000);
it('enforces exact Origin, HttpOnly cookie and no query token authentication', async () => {
  const f = await setup(); const alice = await f.login('alice');
  expect((await fetch(f.url + '/auth/status?ticket=' + alice.grant)).status).toBe(401);
  expect((await fetch(f.url + alice.state.basePath + 'v1/remote/pairings', { method: 'POST', headers: { cookie: alice.cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect((await fetch(f.url + '/auth/session', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ ticket: alice.grant }) })).status).toBe(403);
  expect(await rejected(f.url + alice.state.basePath + 'v1/sessions/private/events', { cookie: alice.cookie, origin: 'https://evil.example' })).toBe(403);
  const pending = await f.begin();
  const cookie = (await fetch(f.url + '/auth/session', { method: 'POST', headers: { origin: f.url, cookie: pending.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket(f.url, 'alice', { nonce: pending.nonce }) }) })).headers.get('set-cookie');
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
}, 10000);
it('stops an already-open browser stream when its grant expires', async () => {
  const f = await setup(); const alice = await f.login('alice');
  const pair = await (await alice.request('v1/remote/pairings', {})).json() as { key: string };
  const host = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pair.key}` } });
  await once(host, 'open'); const registered = once(host, 'message');
  host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'expiry-host', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const [raw] = await registered; const { hostId } = JSON.parse(raw.toString());
  host.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'rpc_request') host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify({ agentId: 'expires-agent', nativeSessionId: 'native' }) }));
    if (message.type === 'stream_open') host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId: message.streamId }));
  });
  await alice.request(`v1/remote/hosts/${hostId}/attach`, { providerId: 'codex', nativeSessionId: 'native' });
  const short = ticket(f.url, 'alice', { exp: Math.floor(Date.now() / 1000) + 2 });
  const stream = new WebSocket((f.url + alice.state.basePath + 'v1/sessions/expires-agent/events').replace('http:', 'ws:'), { headers: { authorization: `Bearer ${short}`, origin: f.url } });
  const closed = once(stream, 'close');
  await once(stream, 'open');
  expect((await closed)[0]).toBe(1008);
  expect((await fetch(f.url + '/auth/status', { headers: { authorization: `Bearer ${short}` } })).status).toBe(401);
  host.close();
}, 5000);
it('keeps the same installation ID isolated across users and restores an owner Host on reconnect', async () => {
  const f = await setup(); const alice = await f.login('alice'); const bob = await f.login('bob');
  async function connect(key: string) {
    const host = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
    await once(host, 'open'); const received = once(host, 'message');
    host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'collision', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    return { host, id: JSON.parse((await received)[0].toString()).hostId as string };
  }
  const aKey = (await (await alice.request('v1/remote/pairings', {})).json()).key as string;
  const bKey = (await (await bob.request('v1/remote/pairings', {})).json()).key as string;
  const a = await connect(aKey); const b = await connect(bKey);
  expect(a.id).not.toBe(b.id);
  a.host.close(); await once(a.host, 'close');
  const again = await connect(aKey); expect(again.id).toBe(a.id);
  expect(await (await bob.request('v1/remote/hosts')).json()).toMatchObject({ hosts: [{ id: b.id, online: true }] });
  again.host.close(); b.host.close();
}, 5000);

it('rejects new tenants at capacity while preserving existing user access', async () => {
  const f = await setup({ maxTenants: 1 }); const alice = await f.login('alice');
  const pending = await f.begin();
  const response = await fetch(f.url + '/auth/session', { method: 'POST', headers: { origin: f.url, cookie: pending.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket(f.url, 'bob', { nonce: pending.nonce }) }) });
  expect(response.status).toBe(429);
  expect((await alice.request('v1/remote/hosts')).status).toBe(200);
}, 5000);
it('does not exchange a forwarded login grant without a matching browser login challenge', async () => {
  const f = await setup();
  const response = await fetch(f.url + '/auth/session', { method: 'POST', headers: { origin: f.url, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket(f.url, 'attacker') }) });
  expect(response.status).toBe(401);
  expect(response.headers.get('set-cookie')).toBeNull();
}, 5000);

it('consumes login challenges once and rejects another browser cookie', async () => {
  const f = await setup(); const first = await f.begin(); const other = await f.begin();
  const grant = ticket(f.url, 'alice', { nonce: first.nonce });
  const exchange = (cookie: string) => fetch(f.url + '/auth/session', { method: 'POST', headers: { origin: f.url, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: grant }) });
  expect((await exchange(other.cookie)).status).toBe(401);
  expect((await exchange(first.cookie)).status).toBe(200);
  expect((await exchange(first.cookie)).status).toBe(401);
}, 5000);
