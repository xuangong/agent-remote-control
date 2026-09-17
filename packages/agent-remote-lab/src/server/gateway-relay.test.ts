// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';
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

async function control(url: string, value: Record<string, unknown>) {
  const body = JSON.stringify(value); const iat = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'HS256', typ: 'arc-gateway-service+jwt' }, { iss: issuer, aud: url, op: 'control',
    bodyHash: createHash('sha256').update(body).digest('base64url'), iat, exp: iat + 60, jti: crypto.randomUUID() }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return fetch(url + '/gateway/control', { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: `Bearer ${input}.${createHmac('sha256', secret).update(input).digest('base64url')}` }, body });
}
it('shares one Host with cumulative quotas and revokes only the recipient streams', async () => {
  const f = await setup(); const alice = await f.login('alice'); const bob = await f.login('bob'); const eve = await f.login('eve');
  const pair = await (await alice.request('v1/remote/pairings', {})).json() as { key: string };
  const host = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pair.key}` } });
  await once(host, 'open'); const registration = once(host, 'message');
  host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'shared-host', name: 'Shared Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const hostId = JSON.parse((await registration)[0].toString()).hostId as string;
  let creates = 0;
  host.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'rpc_request') {
      const creating = message.path === '/remote/create'; if (creating) creates++;
      const body = creating ? { agentId: `shared-agent-${creates}`, nativeSessionId: `native-${creates}` }
        : message.path === '/remote/attach' ? { agentId: 'private-agent', nativeSessionId: 'private-native' }
        : message.path === '/remote/child/attach' ? { agentId: 'child-agent', nativeSessionId: 'child-native' }
        : message.path.startsWith('/v1/sessions/') ? { payload: { runtimeInfo: { childSessions: [{ nativeSessionId: 'child-native' }] } } }
        : { title: 'Topic', nativeSessionId: 'native-1', providerId: 'codex', state: 'idle', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(body) }));
    }
    if (message.type === 'stream_open') host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId: message.streamId }));
  });
  const share = { subject: 'alice', operation: 'share', hostId, targetSubject: 'bob', targetLabel: 'Bob', sessionLimit: 1 };
  expect((await control(f.url, share)).status).toBe(200);
  expect(await (await bob.request('v1/remote/hosts')).json()).toMatchObject({ hosts: [{ id: hostId, access: 'shared', sessionQuota: { limit: 1, used: 0 } }] });
  expect((await control(f.url, { ...share, subject: 'bob', targetSubject: 'eve' })).status).toBe(403);
  const operationIds = { one: '00000000-0000-4000-8000-000000000001', two: '00000000-0000-4000-8000-000000000002', three: '00000000-0000-4000-8000-000000000003' };
  const create = (id: keyof typeof operationIds) => bob.request(`v1/remote/hosts/${hostId}/create`, { providerId: 'codex', operationId: operationIds[id] });
  const responses = await Promise.all([create('one'), create('two')]);
  expect(responses.map(value => value.status).sort()).toEqual([200, 409]); expect(creates).toBe(1);
  const index = responses.findIndex(value => value.status === 200); const binding = await responses[index]!.json() as { agentId: string; nativeSessionId: string };
  expect((await create(index === 0 ? 'one' : 'two')).status).toBe(200); expect(creates).toBe(1);
  expect((await bob.request(`v1/remote/hosts/${hostId}/attach`, { providerId: 'codex', nativeSessionId: 'private-native' })).status).toBe(403);
  expect((await eve.request(`v1/sessions/${binding.agentId}/snapshot`)).status).toBe(404);
  expect((await bob.request(`v1/sessions/${binding.agentId}/snapshot`)).status).toBe(200);
  const childBody = { providerId: 'codex', nativeSessionId: 'child-native', parentNativeSessionId: binding.nativeSessionId };
  expect((await alice.request(`v1/remote/hosts/${hostId}/child/attach`, childBody)).status).toBe(200);
  expect((await bob.request(`v1/remote/hosts/${hostId}/child/attach`, childBody)).status).toBe(200);
  expect((await bob.request('v1/sessions/child-agent/snapshot')).status).toBe(200);
  const bobStream = new WebSocket((f.url + bob.state.basePath + `v1/sessions/${binding.agentId}/events`).replace('http:', 'ws:'), { headers: { cookie: bob.cookie, origin: f.url } });
  await once(bobStream, 'open');
  const ownerStream = new WebSocket((f.url + alice.state.basePath + `v1/sessions/${binding.agentId}/events`).replace('http:', 'ws:'), { headers: { cookie: alice.cookie, origin: f.url } });
  await once(ownerStream, 'open'); const ended = once(bobStream, 'close');
  expect((await control(f.url, { subject: 'alice', operation: 'revoke-share', hostId, targetSubject: 'bob' })).status).toBe(200);
  expect((await ended)[0]).toBe(1008); expect(ownerStream.readyState).toBe(WebSocket.OPEN); expect(host.readyState).toBe(WebSocket.OPEN);
  expect((await bob.request(`v1/sessions/${binding.agentId}/snapshot`)).status).toBe(404);
  expect((await control(f.url, share)).status).toBe(200);
  expect((await create('three')).status).toBe(409); expect(creates).toBe(1);
  ownerStream.close(); host.close();
}, 10000);

async function sharedFixture() {
  const f = await setup(); const owner = await f.login('owner'); const user = await f.login('user');
  const pair = await (await owner.request('v1/remote/pairings', {})).json() as { key: string };
  const host = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pair.key}` } });
  await once(host, 'open'); const registered = once(host, 'message');
  host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'quota-host', name: 'Quota Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const hostId = JSON.parse((await registered)[0].toString()).hostId as string;
  const setLimit = (limit: number) => control(f.url, { operation: 'share', subject: 'owner', hostId, targetSubject: 'user', targetLabel: 'User', sessionLimit: limit });
  expect((await setLimit(1)).status).toBe(200);
  const operationIds = { first: '00000000-0000-4000-8000-000000000001', second: '00000000-0000-4000-8000-000000000002' };
  const create = (id: keyof typeof operationIds, settings = {}) => user.request(`v1/remote/hosts/${hostId}/create`, { providerId: 'codex', operationId: operationIds[id], ...settings });
  return { ...f, owner, user, host, hostId, create, setLimit };
}
it.each([{ status: 503, code: 'mutation_outcome_unknown' }, { status: 409, code: 'session_binding_conflict' }])('retains quota and never redispatches ambiguous native creation ($code)', async ({ status, code }) => {
  const f = await sharedFixture(); let calls = 0;
  f.host.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'rpc_request') return;
    calls++;
    f.host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status, body: JSON.stringify({ code, error: 'Native outcome cannot be proven.' }) }));
  });
  expect((await f.create('first')).status).toBe(status);
  expect(await (await f.create('first')).json()).toMatchObject({ code: 'creation_outcome_unknown' });
  expect(await (await f.create('second')).json()).toMatchObject({ code: 'session_quota_exceeded' });
  expect(calls).toBe(1); f.host.close();
}, 10000);

it('releases definitively rejected creation and permits a safe same-request retry', async () => {
  const f = await sharedFixture(); let calls = 0;
  f.host.on('message', raw => {
    const message = JSON.parse(raw.toString()); if (message.type !== 'rpc_request') return;
    calls++;
    f.host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: calls === 1 ? 400 : 200,
      body: JSON.stringify(calls === 1 ? { code: 'invalid_request', error: 'Pre-creation validation rejected.' } : { agentId: 'retried', nativeSessionId: 'retried-native' }) }));
  });
  expect((await f.create('first')).status).toBe(400);
  expect((await f.create('first')).status).toBe(200); expect(calls).toBe(2);
  expect((await f.create('second')).status).toBe(409); f.host.close();
}, 10000);

it('drops buffered user commands when sharing is revoked before the Host acknowledges the stream', async () => {
  const f = await sharedFixture(); let commands = 0; let streamId: string | undefined;
  let opened!: () => void; const opening = new Promise<void>(resolve => { opened = resolve; });
  f.host.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'rpc_request') f.host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify({ agentId: 'buffered', nativeSessionId: 'buffered-native' }) }));
    if (message.type === 'stream_open') { streamId = message.streamId; opened(); }
    if (message.type === 'stream_message') commands++;
  });
  expect((await f.create('first')).status).toBe(200);
  const browser = new WebSocket((f.url + f.user.state.basePath + 'v1/sessions/buffered/events').replace('http:', 'ws:'), { headers: { cookie: f.user.cookie, origin: f.url } });
  await once(browser, 'open'); await opening;
  browser.send(JSON.stringify({ protocolVersion: '1.4.0', type: 'send_message', payload: { agentId: 'buffered', requestId: 'message', operationId: '00000000-0000-4000-8000-000000000003', text: 'queued command' } }));
  const ended = once(browser, 'close');
  expect((await control(f.url, { subject: 'owner', operation: 'revoke-share', hostId: f.hostId, targetSubject: 'user' })).status).toBe(200);
  f.host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId }));
  await ended;
  // A ping/pong round trip is a processing barrier for earlier frames on the Host socket.
  const pong = once(f.host, 'pong'); f.host.ping(); await pong;
  expect(commands).toBe(0); expect(f.host.readyState).toBe(WebSocket.OPEN); f.host.close();
}, 10000);
