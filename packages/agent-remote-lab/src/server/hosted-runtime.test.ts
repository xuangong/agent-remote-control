// @vitest-environment node
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign as rsaSign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createGatewayRelay } from './gateway-relay.js';
import { createGatewayStaticPages } from './gateway-static.js';

const secret = 'hosted-runtime-secret-01234567890123456789';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); }, 10000);
const cookies = (response: Response) => response.headers.getSetCookie().filter(value => !value.includes('arc_login=;')).map(value => value.split(';')[0]).join('; ');
function signed(type: string, claims: object) {
  const body = [{ alg: 'HS256', typ: type }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}
async function assets() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-hosted-runtime-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><title>Controller</title></head><body><script src="/assets/main.js"></script></body></html>');
  await writeFile(join(directory, 'assets/main.js'), 'window.controller = true;');
  return directory;
}
async function fixture(provider: 'google' | 'gateway') {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const grants = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  const identity = createServer(async (request, response) => {
    const target = new URL(request.url!, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (target.pathname === '/authorize') {
      const code = randomUUID();
      grants.set(code, { nonce: target.searchParams.get('nonce')!, challenge: target.searchParams.get('code_challenge')!, redirect: target.searchParams.get('redirect_uri')! });
      const callback = new URL(target.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', code); callback.searchParams.set('state', target.searchParams.get('state')!);
      response.writeHead(302, { location: callback.href }); response.end(); return;
    }
    if (target.pathname === '/jwks') { response.end(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] })); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    if (target.pathname === '/token') {
      const input = new URLSearchParams(body), grant = grants.get(input.get('code')!); grants.delete(input.get('code')!);
      if (!grant || input.get('client_id') !== 'runtime-client' || input.get('client_secret') !== 'runtime-client-secret' || input.get('grant_type') !== 'authorization_code' || input.get('redirect_uri') !== grant.redirect || createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) {
        response.writeHead(400); response.end('{}'); return;
      }
      const now = Math.floor(Date.now() / 1000);
      const payload = [{ alg: 'RS256', kid: 'fixture' }, { iss: 'https://accounts.google.com', aud: 'runtime-client', sub: 'owner', email: 'owner@example.com', email_verified: true, nonce: grant.nonce, iat: now, exp: now + 600 }]
        .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
      response.end(JSON.stringify({ id_token: payload + '.' + rsaSign('RSA-SHA256', Buffer.from(payload), keys.privateKey).toString('base64url'), access_token: 'never-persist-access-token' })); return;
    }
    response.end(JSON.stringify({ active: true, subject: 'owner', authenticatedAt: Date.now(), expiresAt: Date.now() + 3_600_000, validUntil: Date.now() + 120_000 }));
  });
  await new Promise<void>(resolve => identity.listen(0, '127.0.0.1', resolve));
  closers.push(async () => { identity.closeAllConnections(); await new Promise<void>(resolve => identity.close(() => resolve())); });
  const issuer = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;
  const directory = await assets();
  let url = 'http://127.0.0.1:0'; let relay: ReturnType<typeof createGatewayRelay> | undefined;
  const start = async () => {
    relay = createGatewayRelay({ ...(provider === 'google' ? { provider, google: { clientId: 'runtime-client', clientSecret: 'runtime-client-secret', allowedEmails: ['owner@example.com'], endpoints: { authorization: issuer + '/authorize', token: issuer + '/token', jwks: issuer + '/jwks' } } } : { issuer }),
      origin: url, secret, stateFile: join(directory, 'state.json'), servePage: await createGatewayStaticPages(directory, { origin: url }) });
    url = (await relay.listen(Number(new URL(url).port))).url;
  };
  const stop = async () => { const active = relay; relay = undefined; await active?.close(); };
  closers.push(stop); await start();
  const request = (path: string, cookie = '', body?: object) => fetch(url + path, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { origin: url, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  async function begin() {
    const response = await request('/auth/login?host=chosen-host'); expect(response.status).toBe(303);
    const destination = new URL(response.headers.get('location')!);
    if (provider === 'google') {
      const consent = await fetch(destination, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      expect(consent.status).toBe(302);
      return { cookie: cookies(response), callback: new URL(consent.headers.get('location')!).pathname + new URL(consent.headers.get('location')!).search };
    }
    const iat = Math.floor(Date.now() / 1000);
    return { cookie: cookies(response), ticket: signed('arc-relay+jwt', { iss: issuer, aud: url, sub: 'owner', nonce: destination.searchParams.get('challenge'), iat, exp: iat + 900, jti: randomUUID(), continuation: 'owner', sessionExpiresAt: Date.now() + 3_600_000 }) };
  }
  async function finish(login: Awaited<ReturnType<typeof begin>>) {
    const response = login.callback ? await request(login.callback, login.cookie) : await request('/auth/session', login.cookie, { ticket: login.ticket });
    expect(response.status).toBe(provider === 'google' ? 303 : 200); return cookies(response);
  }
  async function upgrade(path: string, headers: Record<string, string>) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + path, { headers, handshakeTimeout: 3000 });
    closers.push(async () => { socket.terminate(); }); await once(socket, 'open'); return socket;
  }
  return { get url() { return url; }, issuer, directory, request, begin, finish, upgrade, restart: async () => { await stop(); await start(); } };
}
const frame = (socket: WebSocket) => once(socket, 'message', { signal: AbortSignal.timeout(5000) }).then(([raw]) => JSON.parse(raw.toString()));
const send = (socket: WebSocket, data: object) => socket.send(JSON.stringify({ uplinkVersion: 2, ...data }));
function rejectedUpgrade(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace('http:', 'ws:'), { headers, handshakeTimeout: 3000 });
    socket.on('error', reject);
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected accepted upgrade')); });
    socket.once('unexpected-response', (_, response) => { response.resume(); socket.removeListener('error', reject); socket.on('error', () => undefined); socket.terminate(); resolve(response.statusCode!); });
  });
}
async function handoff(f: Awaited<ReturnType<typeof fixture>>, socket: WebSocket, hostId: string, basePath: string, cookie: string) {
  const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
  const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
  let revision = 1, record: any;
  const role = () => ({ id: 'role', revision, origin: ref('A'), current: ref(revision === 1 ? 'A' : 'B'), workspace });
  const freezes: any[] = []; const effects: string[] = [];
  socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    if (request.type === 'heartbeat') { send(socket, { type: 'heartbeat_ack', nonce: request.nonce }); return; }
    if (request.type !== 'rpc_request') return;
    const input = JSON.parse(request.body ?? '{}'); let body: object = {};
    if (request.path === '/remote/succession/enrollment') {
      if (input.action === 'describe') body = { role: role(), lineage: revision === 1 ? [ref('A')] : [ref('A'), ref('B')] };
      else {
        freezes.push(input.freeze); effects.push(input.action);
        if (input.action === 'prepare') record = { ...input.freeze.request, phase: 'ready', to: ref('B'), startedAt: 'now', updatedAt: 'now', prepared: {
          ...input.freeze.request, to: ref('B'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } };
        if (input.action === 'commit') { record.phase = 'committed'; record.committedRevision = ++revision; }
        body = { record, role: role(), freeze: input.freeze };
      }
    }
    send(socket, { type: 'rpc_response', requestId: request.requestId, status: 200, body: JSON.stringify(body) });
  });
  const path = basePath + `v1/remote/hosts/${hostId}/succession/`;
  const prepared = await f.request(path + 'prepare', cookie, { operationId: 'handoff', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 });
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const committed = await f.request(path + 'commit', cookie, { operationId: 'handoff' });
  expect(committed.status, await committed.clone().text()).toBe(200);
  expect(effects.filter(action => action !== 'status')).toEqual(['prepare', 'commit', 'release']);
  expect(freezes.length).toBeGreaterThan(0);
  for (const freeze of freezes) { expect(Number.isSafeInteger(freeze.maxProjectionBytes)).toBe(true); expect(freeze.maxProjectionBytes).toBeGreaterThan(0); }
  const replay = await (await f.request(basePath + 'v1/session-successions', cookie)).json();
  expect(replay.successions).toMatchObject([{ to: { nativeSessionId: 'B' } }]);
  return replay;
}

it.each(['google', 'gateway'] as const)('Node %s keeps login, pairing credentials and browser admission through restart', async provider => {
  const f = await fixture(provider);
  expect((await f.request('/health')).status).toBe(200);
  const index = await f.request('/'); expect(await index.text()).toContain('agent-remote-auth');
  expect((await f.request('/assets/main.js')).status).toBe(200);
  const pending = await f.begin(); await f.restart(); const cookie = await f.finish(pending);
  const info = await (await f.request('/auth/status', cookie)).json();
  expect(info).toMatchObject({ user: { id: 'owner' }, auth: { provider } });
  expect(await rejectedUpgrade(f.url + '/ws/remote-host')).toBe(401);
  expect(await rejectedUpgrade(f.url + info.basePath + 'v1/session-channel?observation=session', { cookie, origin: 'https://other.example' })).toBe(403);
  const pairing = await f.request(info.basePath + 'v1/remote/pairings', cookie, { purpose: 'host-only' });
  expect(pairing.status).toBe(201); const { key } = await pairing.json();
  await f.restart();
  const host = await f.upgrade('/ws/remote-host?successionEnrollment=2', { authorization: `Bearer ${key}` });
  const issued = frame(host); send(host, { type: 'register', credentialRotation: true, installationId: 'installation', name: 'Host', providers: [{ providerId: 'fixture', displayName: 'Fixture' }] });
  const credential = await issued; expect(credential.type).toBe('credential_issued');
  const registered = frame(host); send(host, { type: 'credential_saved' }); const registration = await registered;
  expect(registration).toMatchObject({ type: 'registered', successionEnrollmentVersion: 2, successionEnrollment: { ownerSubject: 'owner' } });
  const replay = await handoff(f, host, registration.hostId, info.basePath, cookie);
  const closed = once(host, 'close'); host.close(); await closed; await f.restart();
  expect((await f.request('/auth/status', cookie)).status).toBe(200);
  expect(await (await f.request(info.basePath + 'v1/remote/hosts', cookie)).json()).toMatchObject({ hosts: [{ id: registration.hostId, online: false }] });
  expect(await (await f.request(info.basePath + 'v1/session-successions', cookie)).json()).toEqual(replay);
  const reconnected = await f.upgrade('/ws/remote-host', { authorization: `Bearer ${credential.credential}` });
  const restored = frame(reconnected); send(reconnected, { type: 'register', credentialRotation: true, installationId: 'installation', name: 'Host', providers: [{ providerId: 'fixture', displayName: 'Fixture' }] });
  expect(await restored).toMatchObject({ type: 'registered', hostId: registration.hostId });
  await f.upgrade(info.basePath + 'v1/session-channel?observation=session', { cookie, origin: f.url });
  const state = await readFile(join(f.directory, 'state.json'), 'utf8');
  expect(state).not.toContain('runtime-client-secret'); expect(state).not.toContain('never-persist-access-token');
  if (provider === 'google') {
    expect((await f.request(pending.callback!, pending.cookie)).status).toBe(401);
    expect((await f.request('/gateway/control', cookie, {})).status).toBe(404);
    expect((await f.request(info.basePath + 'v1/remote/pairings', cookie, { purpose: 'gateway-setup' })).status).toBe(403);
  } else {
    const envelope = JSON.parse(state), scope = JSON.stringify([f.url, f.issuer]);
    expect(envelope.signature).toBe(createHmac('sha256', secret).update('arc-state-v1\0' + scope + '\0' + envelope.payload).digest('hex'));
    expect(info.basePath).toBe('/u/' + createHash('sha256').update(JSON.stringify([f.issuer, 'owner'])).digest('hex') + '/');
  }
}, 20000);

it.each(['google', 'gateway'] as const)('Node entrypoint resolves %s authentication from environment', async provider => {
  const directory = await assets(), readyFile = join(directory, 'ready.json');
  const env = { ...process.env, AGENT_REMOTE_AUTH_PROVIDER: provider, AGENT_REMOTE_RELAY_URL: 'http://127.0.0.1:0', AGENT_REMOTE_SIGNING_SECRET: secret,
    AGENT_REMOTE_ISSUER: provider === 'gateway' ? 'https://gateway.example' : undefined, AGENT_REMOTE_GOOGLE_CLIENT_ID: 'runtime-client', AGENT_REMOTE_GOOGLE_CLIENT_SECRET: 'runtime-client-secret', AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS: 'owner@example.com',
    AGENT_REMOTE_PORT: '0', AGENT_REMOTE_STATE_DIR: join(directory, 'state'), AGENT_REMOTE_WEB_DIST: directory, AGENT_REMOTE_READY_FILE: readyFile };
  const child = spawn(process.execPath, ['--import', 'tsx/esm', new URL('./gateway.ts', import.meta.url).pathname], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', data => { output += data; });
  closers.push(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, 'exit'); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000); try { await exit; } finally { clearTimeout(force); } });
  let url = ''; const deadline = Date.now() + 7000;
  while (!url) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Relay startup failed: ${output}`);
    try { url = JSON.parse(await readFile(readyFile, 'utf8')).url; } catch { /* Wait for atomic readiness publication. */ }
    if (Date.now() > deadline) throw new Error(`Relay startup deadline exceeded: ${output}`);
    if (!url) await new Promise(resolve => setTimeout(resolve, 25));
  }
  const status = await fetch(url + '/auth/status', { signal: AbortSignal.timeout(3000) });
  expect(await status.json()).toMatchObject({ auth: { provider } });
  const login = await fetch(url + '/auth/login', { redirect: 'manual', signal: AbortSignal.timeout(3000) });
  expect(login.status).toBe(303); expect(new URL(login.headers.get('location')!).hostname).toBe(provider === 'google' ? 'accounts.google.com' : 'gateway.example');
}, 15000);
