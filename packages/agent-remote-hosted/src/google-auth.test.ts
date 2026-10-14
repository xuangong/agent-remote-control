import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { RelaySocket } from './transport.js';
import { createHostedRelay } from './gateway.js';
import { emptyRelayState, type HostedRelayState } from './state.js';

const origin = 'https://relay.example';
const secret = 'local-google-relay-secret-01234567890123456789';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });
function relaySocket(socket: WebSocket): RelaySocket {
  return { get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; },
    send: data => socket.send(data), close: (code, reason) => socket.close(code, reason),
    onMessage(listener) { const receive = (data: Buffer, binary: boolean) => { void listener(data.toString(), binary); }; socket.on('message', receive); return () => { socket.off('message', receive); }; },
    onClose(listener) { const close = (code: number) => listener({ code }); socket.on('close', close); return () => { socket.off('close', close); }; },
    onError(listener) { socket.on('error', listener); return () => { socket.off('error', listener); }; } };
}
async function fixture(durable = true) {
  const keys = await generateKeyPair('RS256');
  const wrongKeys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  let claims: JWTPayload = {};
  let invalidSignature = false;
  let now = () => Date.now();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/jwks') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ keys: [jwk] })); return; }
    if (url.pathname === '/authorize') {
      if (url.searchParams.get('client_id') !== 'fixture-client' || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('scope')?.split(' ').includes('openid')) {
        response.writeHead(400); response.end(); return;
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')! });
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state')!);
      response.writeHead(302, { location: redirect.href }); response.end(); return;
    }
    if (url.pathname === '/token') {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = new URLSearchParams(body); const code = input.get('code')!;
      const grant = codes.get(code); codes.delete(code);
      if (!grant || input.get('client_id') !== 'fixture-client' || input.get('client_secret') !== 'fixture-secret' || input.get('grant_type') !== 'authorization_code' || input.get('redirect_uri') !== grant.redirect || createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) {
        response.writeHead(400); response.end(JSON.stringify({ error: 'invalid_grant' })); return;
      }
      const seconds = Math.floor(now() / 1000);
      const token = await new SignJWT({ iss: 'https://accounts.google.com', aud: 'fixture-client', sub: 'google-sub-123', email: 'allowed@example.com', email_verified: true, name: 'Fixture User', nonce: grant.nonce, iat: seconds, exp: seconds + 600, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(invalidSignature ? wrongKeys.privateKey : keys.privateKey);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id_token: token, token_type: 'Bearer', access_token: 'discard-this-token' })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const providerOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { provider: 'google' as const, origin, secret, google: { clientId: 'fixture-client', clientSecret: 'fixture-secret', allowedEmails: ['allowed@example.com'], sessionLifetimeMs: 3_600_000,
    endpoints: { authorization: providerOrigin + '/authorize', token: providerOrigin + '/token', jwks: providerOrigin + '/jwks' } } };
  let saved: HostedRelayState | undefined;
  function start(initial?: HostedRelayState, options = auth) {
    const relay = createHostedRelay({ ...options, ...(durable ? { storage: { initial, async commit(value: HostedRelayState) { saved = structuredClone(value); } } } : {}), scheduler: { schedule() {}, cancel() {} } });
    closers.push(() => relay.close()); return relay;
  }
  const relay = start();
  const request = (path: string, cookie?: string, body?: unknown) => new Request(origin + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) } });
  async function begin(target = relay, cookie?: string, path = '/auth/login') {
    const login = (await target.fetch(request(path, cookie)))!;
    expect(login.status).toBe(303);
    const destination = new URL(login.headers.get('location')!);
    expect(destination.origin).toBe(providerOrigin);
    const consent = await fetch(destination, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    return { callback: new URL(consent.headers.get('location')!), cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), login, destination };
  }
  async function finish(login: Awaited<ReturnType<typeof begin>>, target = relay, extraCookie = '') {
    return (await target.fetch(new Request(login.callback, { headers: { cookie: [login.cookie, extraCookie].filter(Boolean).join('; ') } })))!;
  }
  async function signIn() { const login = await begin(); const callback = await finish(login); expect(callback.status).toBe(303); return { callback, cookie: callback.headers.getSetCookie().filter(value => !value.includes('arc_login=')).map(value => value.split(';')[0]).join('; ') }; }
  return { auth, relay, start, begin, finish, signIn, request, saved: () => saved!, claims: (value: JWTPayload) => { claims = value; }, wrongSignature: () => { invalidSignature = true; } };
}

it('admits a signed allowlisted Google identity through bound PKCE and keeps its opaque session after restart', async () => {
  const f = await fixture(); const { cookie, callback } = await f.signIn();
  expect(callback.headers.get('location')).toBe('/');
  const status = (await f.relay.fetch(f.request('/auth/status', cookie)))!;
  expect(status.status).toBe(200);
  const info = await status.json();
  expect(info).toMatchObject({ user: { id: 'google-sub-123', email: 'allowed@example.com' }, auth: { provider: 'google', capabilities: { hostOnlyPairing: true, gatewaySetup: false, gatewayControl: false } } });
  const snapshot = f.saved(); expect(JSON.stringify(snapshot)).not.toContain('discard-this-token');
  expect(snapshot.sessions[0]!.grant).not.toHaveProperty('ticket');
  expect(snapshot.sessions[0]!.grant).not.toHaveProperty('continuation');
  await f.relay.close(); const restarted = f.start(snapshot);
  expect((await restarted.fetch(f.request('/auth/status', cookie)))!.status).toBe(200);
}, 10000);

it.each([
  ['wrong audience', { aud: 'other-client' }], ['wrong issuer', { iss: 'https://attacker.example' }],
  ['unverified email', { email_verified: false }], ['unlisted email', { email: 'other@example.com' }],
  ['missing email', { email: undefined }], ['wrong nonce', { nonce: 'attacker-nonce' }],
  ['expired token', { exp: 1 }], ['missing subject', { sub: undefined }], ['invalid subject type', { sub: 123 as unknown as string }], ['future issued token', { iat: 9999999999 }],
])('rejects %s before creating any session', async (_name, claims) => {
  const f = await fixture(); f.claims(claims); const login = await f.begin();
  expect((await f.finish(login)).status).toBe(401);
  expect(f.saved().sessions).toEqual([]);
}, 10000);

it('rejects an invalid signature and consumes a failed callback once', async () => {
  const f = await fixture(); f.wrongSignature(); const login = await f.begin();
  expect((await f.finish(login)).status).toBe(401); expect((await f.finish(login)).status).toBe(401);
}, 10000);

it('requires the initiating browser and state and persists one-time callback consumption', async () => {
  const f = await fixture(); const login = await f.begin();
  expect((await f.relay.fetch(new Request(login.callback)))!.status).toBe(401);
  const forged = { ...login, callback: new URL(login.callback) }; forged.callback.searchParams.set('state', randomBytes(32).toString('base64url'));
  expect((await f.finish(forged)).status).toBe(401);
  const responses = await Promise.all([f.finish(login), f.finish(login)]);
  expect(responses.map(value => value.status).sort()).toEqual([303, 401]);
  await f.relay.close(); const restarted = f.start(f.saved()); expect((await f.finish(login, restarted)).status).toBe(401);
}, 10000);

it('keeps Google account authority separate from browser logout and denies removed allowlist entries on restart', async () => {
  const f = await fixture(); const { cookie } = await f.signIn();
  expect((await f.relay.fetch(f.request('/auth/logout', cookie, {})))!.status).toBe(200);
  expect((await f.relay.fetch(f.request('/auth/status', cookie)))!.status).toBe(401);
  expect(f.saved().googleIdentities).toEqual([{ subject: 'google-sub-123', email: 'allowed@example.com' }]);
  const restarted = f.start(f.saved(), { ...f.auth, google: { ...f.auth.google, allowedEmails: ['another@example.com'] } });
  expect((await restarted.fetch(f.request('/auth/status', cookie)))!.status).toBe(401);
}, 10000);

it('keeps Gateway control and setup endpoints unavailable under Google mode', async () => {
  const f = await fixture(); const { cookie } = await f.signIn();
  for (const path of ['/gateway/control', '/v1/remote/host/bootstrap', '/auth/session']) expect((await f.relay.fetch(f.request(path, cookie, {})))!.status).toBe(404);
  const status = await (await f.relay.fetch(f.request('/auth/status', cookie)))!.json();
  expect((await f.relay.fetch(f.request(status.basePath + 'v1/remote/pairings', cookie, { purpose: 'gateway-setup' })))!.status).toBe(403);
  expect((await f.relay.fetch(f.request(status.basePath + 'v1/remote/pairings', cookie, { purpose: 'host-only' })))!.status).toBe(201);
}, 10000);

it('never loads a Gateway snapshot into Google deployment even for identical subjects', async () => {
  const f = await fixture(); const snapshot = emptyRelayState({ origin, secret, issuer: 'https://accounts.google.com' });
  expect(() => f.start(snapshot)).toThrow(/state/i);
}, 10000);

it('groups repeated sign-ins on one browser and revokes the whole browser without revoking another device', async () => {
  const f = await fixture(); const first = await f.signIn();
  const login = await f.begin(f.relay, first.cookie); const second = await f.finish(login, f.relay);
  const secondCookie = second.headers.getSetCookie().filter(value => !value.includes('arc_login=')).map(value => value.split(';')[0]).join('; ');
  const other = await f.signIn();
  const listing = await (await f.relay.fetch(f.request('/auth/sessions', first.cookie)))!.json();
  expect(listing.recentAuthentication).toBe(true); expect(listing.sessions).toHaveLength(2);
  const current = listing.sessions.find((value: { current: boolean }) => value.current);
  expect(current.sessionCount).toBe(2);
  expect((await f.relay.fetch(f.request('/auth/sessions/revoke', first.cookie, { id: current.id })))!.status).toBe(200);
  for (const cookie of [first.cookie, secondCookie]) expect((await f.relay.fetch(f.request('/auth/status', cookie)))!.status).toBe(401);
  expect((await f.relay.fetch(f.request('/auth/status', other.cookie)))!.status).toBe(200);
}, 10000);

it('retains finite local session expiry and requires another local sign-in for sensitive operations', async () => {
  const f = await fixture(); const { cookie } = await f.signIn(); const snapshot = f.saved();
  const record = snapshot.sessions[0]!;
  expect(record.sessionExpiresAt - record.grant.authenticatedAt!).toBe(3_600_000);
  record.grant.authenticatedAt = Date.now() - 20 * 60_000;
  await f.relay.close(); const restarted = f.start(snapshot);
  const status = await (await restarted.fetch(f.request('/auth/status', cookie)))!.json();
  const refresh = await (await restarted.fetch(f.request('/auth/refresh', cookie, {})))!.json();
  expect(refresh.user.id).toBe('google-sub-123');
  const pairing = (await restarted.fetch(f.request(status.basePath + 'v1/remote/pairings', cookie, { purpose: 'host-only' })))!;
  expect(pairing.status).toBe(403); expect(await pairing.json()).toMatchObject({ code: 'reauthentication_required' });
  const expired = f.saved(); expired.sessions[0]!.sessionExpiresAt = Date.now() - 1;
  expired.sessions[0]!.grant.sessionExpiresAt = Date.now() - 1;
  await restarted.close(); const afterExpiry = f.start(expired);
  expect((await afterExpiry.fetch(f.request('/auth/status', cookie)))!.status).toBe(401);
}, 10000);

it('does not persist Google login secrets or credentials after callback completion', async () => {
  const f = await fixture(); const login = await f.begin(); const verifier = f.saved().loginChallenges[0]![1].google!.verifier;
  expect(login.login.headers.getSetCookie().join(';')).toContain('SameSite=Lax');
  const result = await f.finish(login);
  expect(result.status).toBe(303);
  expect(f.saved().loginChallenges).toEqual([]);
  const snapshot = JSON.stringify(f.saved());
  for (const secret of ['fixture-secret', 'discard-this-token', verifier]) expect(snapshot).not.toContain(secret);
}, 10000);

it('requires recent Google authentication even when no persistence adapter is provided', async () => {
  const f = await fixture(false); const { cookie } = await f.signIn();
  const status = await (await f.relay.fetch(f.request('/auth/status', cookie)))!.json();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  const result = (await f.relay.fetch(f.request(status.basePath + 'v1/remote/pairings', cookie, { purpose: 'host-only' })))!;
  expect(result.status).toBe(403); expect(await result.json()).toMatchObject({ code: 'reauthentication_required' });
}, 10000);

it('rejects a delayed real Host WebSocket acceptance after its prepared account lease expires', async () => {
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const f = await fixture(false); const { cookie } = await f.signIn();
  const status = await (await f.relay.fetch(f.request('/auth/status', cookie)))!.json();
  const pairing = await (await f.relay.fetch(f.request(status.basePath + 'v1/remote/pairings', cookie, { purpose: 'host-only' })))!.json();
  const prepared = await f.relay.prepareUpgrade(new Request(origin + '/ws/remote-host', { headers: { authorization: `Bearer ${pairing.key}` } }));
  if (!prepared || prepared instanceof Response) throw Error('Host upgrade rejected');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closers.push(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.on('connection', socket => prepared.accept(relaySocket(socket)));
  clock += 180_000;
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  closers.push(async () => { socket.terminate(); });
  let closeCode: number | undefined; socket.on('close', code => { closeCode = code; });
  await expect.poll(() => closeCode, { timeout: 1500 }).toBe(1013);
}, 10000);

it('closes an established Google Host socket at its account lease deadline when local renewal is not scheduled', async () => {
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const f = await fixture(false); const { cookie } = await f.signIn();
  const status = await (await f.relay.fetch(f.request('/auth/status', cookie)))!.json();
  const pairing = await (await f.relay.fetch(f.request(status.basePath + 'v1/remote/pairings', cookie, { purpose: 'host-only' })))!.json();
  const server = createServer(); const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (request, socket, head) => {
    const prepared = await f.relay.prepareUpgrade(new Request(origin + request.url, { headers: { authorization: request.headers.authorization! } }));
    if (!prepared || prepared instanceof Response) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, client => prepared.accept(relaySocket(client)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => { for (const client of sockets.clients) client.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/remote-host`, { headers: { authorization: `Bearer ${pairing.key}` } });
  closers.push(async () => { socket.terminate(); });
  const registered = new Promise<void>(resolve => socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'credential_issued') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
    if (message.type === 'heartbeat') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: message.nonce }));
    if (message.type === 'rpc_request') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 404, body: '{}' }));
    if (message.type === 'registered') resolve();
  }));
  const closed = new Promise<{ code: number; reason: string; at: number }>(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString(), at: Date.now() })));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'google-lease-fixture', name: 'Google lease fixture', providers: [], credentialRotation: true }));
  await registered;
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(status.expiresAt).toBeGreaterThan(Date.now());
  // The fixture's no-op Relay scheduler withholds local account renewal. Broker
  // expiry timers and the real transport remain active, including heartbeat ACKs.
  while (Date.now() < status.expiresAt - 1) {
    const elapsed = Math.min(15_000, status.expiresAt - 1 - clock); clock += elapsed;
    await vi.advanceTimersByTimeAsync(elapsed);
    await new Promise<void>(resolve => { socket.once('pong', () => resolve()); socket.ping(); });
  }
  expect(socket.readyState).toBe(WebSocket.OPEN);
  clock += 1; await vi.advanceTimersByTimeAsync(1);
  expect(await closed).toEqual({ code: 1013, reason: 'Credential expired', at: status.expiresAt });
}, 10000);


it('renders a private readable callback failure and preserves only the validated return target', async () => {
  const f = await fixture(); f.wrongSignature();
  const login = await f.begin(f.relay, undefined, '/auth/login?host=studio&provider=codex&session=one');
  const response = await f.finish(login);
  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const html = await response.text();
  expect(html).toContain('Sign in again');
  expect(html).toContain('/auth/login?host=studio&amp;provider=codex&amp;session=one');
  expect(html).not.toContain(login.callback.searchParams.get('code'));
  expect(html).not.toContain('/auth/session');
  const invalid = await f.relay.fetch(f.request('/auth/callback?error_description=%3Cscript%3Eevil%3C/script%3E'));
  expect(await invalid!.text()).not.toContain('evil');
});

it('renders a safe retry with the saved target when a signed Google callback reaches session capacity', async () => {
  const f = await fixture(); await f.signIn();
  const snapshot = f.saved();
  snapshot.sessions = Array.from({ length: 1024 }, (_, index) => ({ ...structuredClone(snapshot.sessions[0]!),
    hash: createHash('sha256').update(`capacity-session-${index}`).digest('hex'), id: `capacity-session-${index}` }));
  await f.relay.close(); const restarted = f.start(snapshot);
  const login = await f.begin(restarted, undefined, '/auth/login?host=studio&provider=codex&session=one');
  const response = await f.finish(login, restarted);
  expect(response.status).toBe(429);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(response.headers.getSetCookie()).toEqual([]);
  const html = await response.text();
  expect(html).toContain('account capacity');
  expect(html).toContain('href="/auth/login?host=studio&amp;provider=codex&amp;session=one">Sign in again');
  expect(html).toContain('href="/">Back to Agent Remote');
  for (const value of [login.callback.searchParams.get('code')!, login.callback.searchParams.get('state')!, '/auth/session', '<script']) expect(html).not.toContain(value);
  expect(f.saved().sessions).toHaveLength(1024);
  expect(f.saved().loginChallenges).toEqual([]);
}, 10000);
