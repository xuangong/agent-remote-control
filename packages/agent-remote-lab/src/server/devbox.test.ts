// @vitest-environment node
import { createServer } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createWindowView, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import * as hosted from '@orchardworks/agent-remote-hosted';
import { createDevboxServer } from './devbox.js';
import { createGatewayRelay } from './gateway-relay.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

async function fixture(hostname = '127.0.0.1') {
  const directory = await mkdtemp(join(tmpdir(), 'arc-devbox-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const webDist = join(directory, 'web'); await mkdir(webDist);
  await writeFile(join(webDist, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://${hostname}:${port}`;
  const options = { origin, stateDir: join(directory, 'state'), webDist };
  let server = await createDevboxServer(options); await server.listen(port, '127.0.0.1');
  cleanups.push(() => server.close());
  return { origin, options, directory, get server() { return server; },
    async restart() { await server.close(); server = await createDevboxServer(options); await server.listen(port, '127.0.0.1'); },
  };
}

function rawRequest(origin: string, host: string, path = '/', method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: new URL(origin).port, path, method, headers: { ...headers, host }, signal: AbortSignal.timeout(5000) }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    });
    request.on('error', reject); request.end();
  });
}

it('serves Devbox loopback aliases without sending browsers or preview proxies to another origin', async () => {
  const f = await fixture('localhost'); const { port, host } = new URL(f.origin);
  const target = '/?window=example&session=a%2Fb&provider=codex';
  for (const hostname of ['127.0.0.1', 'LOCALHOST', 'localhost.', '[::1]']) for (const method of ['GET', 'HEAD']) {
    const result = await rawRequest(f.origin, `${hostname}:${port}`, target, method);
    expect(result.status, `${method} ${hostname}`).toBe(method === 'GET' ? 200 : 401);
    expect(result.headers.location).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
  }
  expect((await rawRequest(f.origin, host, target)).status).toBe(200);
  const alias = `http://127.0.0.1:${port}`;
  const opened = await request(alias + '/auth/status?entry=local', { headers: { origin: alias } });
  expect(opened.status).toBe(200); expect(opened.url).toBe(alias + '/auth/status?entry=local');
  const state = await opened.json();
  expect(state).toMatchObject({ user: { id: 'devbox' } });
  const headers = { origin: alias, cookie: cookies(opened) };
  expect((await request(alias + state.basePath + 'v1/windows', { headers })).status).toBe(200);
  expect((await request(alias + '/auth/refresh', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  const socket = new WebSocket((alias + state.basePath + 'v1/session-channel?observation=activity').replace('http:', 'ws:'), { headers, handshakeTimeout: 3000 });
  cleanups.push(async () => { socket.terminate(); });
  await once(socket, 'open'); expect(socket.readyState).toBe(WebSocket.OPEN);
}, 15000);

it('rejects foreign origins and malformed request authorities at Devbox aliases', async () => {
  const f = await fixture('localhost'); const { port } = new URL(f.origin);
  const alias = `127.0.0.1:${port}`;
  for (const [host, target, method] of [
    [`outside.example:${port}`, '/', 'GET'], [`localhost:${Number(port) + 1}`, '/', 'GET'],
    [`user@localhost:${port}`, '/', 'GET'],
    [`${alias}/ignored`, '/', 'GET'], [`${alias}\\outside.example`, '/', 'GET'],
    [`0x7f000001:${port}`, '/', 'GET'],
    [alias, '//outside.example/path', 'GET'], [alias, '/\\outside.example/path', 'GET'],
    [alias, 'http://outside.example/path', 'GET'], [alias, f.origin + '/auth/status', 'GET'],
  ]) {
    const result = await rawRequest(f.origin, host!, target, method);
    expect(result.status, `${method} ${host} ${target}`).toBe(400);
    expect(result.headers.location).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
  }
  expect((await rawRequest(f.origin, alias, '/auth/status', 'GET', { origin: 'https://outside.example' })).status).toBe(403);
  expect((await rawRequest(f.origin, alias, '/auth/status', 'GET', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/remote-host`, { headers: { host: `outside.example:${port}`, origin: f.origin }, handshakeTimeout: 3000 });
  socket.on('error', () => undefined); cleanups.push(async () => { socket.terminate(); });
  const [_, response] = await once(socket, 'unexpected-response');
  expect(response.statusCode).toBe(400); expect(response.headers.location).toBeUndefined(); response.resume(); socket.terminate();
}, 15000);

it('keeps production Host validation strict when no entry aliases are configured', async () => {
  const server = createGatewayRelay({ origin: 'http://localhost:0', issuer: 'https://issuer.example', secret: 'production-test-secret-01234567890123456789' });
  cleanups.push(() => server.close()); const { url } = await server.listen(0); const { port, host } = new URL(url);
  for (const hostname of ['127.0.0.1', 'LOCALHOST', 'localhost.', '[::1]']) {
    const result = await rawRequest(url, `${hostname}:${port}`, '/auth/status');
    expect(result.status).toBe(400); expect(result.headers.location).toBeUndefined();
  }
  expect((await rawRequest(url, host, '/auth/status')).status).toBe(401);
}, 15000);

it('opens the hosted product without sign-in and retains its opaque browser session and Window after restart', async () => {
  const f = await fixture();
  const page = await (await request(f.origin)).text();
  expect(page).toContain('name="agent-remote-auth" content="gateway"');
  expect(page).toContain('name="agent-remote-devbox" content="true"');
  const first = await request(f.origin + '/auth/status');
  expect(first.status).toBe(200);
  const state = await first.json(); const cookie = cookies(first);
  expect(state).toMatchObject({ user: { id: 'devbox', name: 'Devbox' }, auth: { capabilities: { hostOnlyPairing: true, gatewaySetup: false, gatewayControl: false } } });
  expect(first.headers.getSetCookie().find(value => value.startsWith('devbox_session='))).toMatch(/^devbox_session=[A-Za-z0-9_-]{43};.*HttpOnly/);
  const headers = { cookie, origin: f.origin, 'content-type': 'application/json' };
  const windows = f.origin + state.basePath + 'v1/windows';
  const created = await request(windows, { method: 'POST', headers, body: JSON.stringify({ operationId: 'create-window', issuedAt: Date.now(),
    window: { schemaVersion: 3, id: 'devbox-window', title: 'Feature validation', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] } }) });
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ result: { status: 'committed' } });
  for (const route of ['v1/favorites', 'v1/remote/teams', 'v1/session-relations']) {
    expect((await request(f.origin + state.basePath + route, { headers })).status, route).toBe(200);
  }
  const second = await request(f.origin + '/auth/status', { headers });
  expect(second.status).toBe(200);
  expect(second.headers.getSetCookie().some(value => value.startsWith('devbox_session='))).toBe(false);
  expect((await (await request(f.origin + '/auth/sessions', { headers })).json()).sessions).toHaveLength(1);
  await f.restart();
  const restored = await request(f.origin + '/auth/status', { headers });
  expect(restored.status).toBe(200);
  expect(restored.headers.getSetCookie().some(value => value.startsWith('devbox_session='))).toBe(false);
  expect(await (await request(windows, { headers })).json()).toMatchObject({ windows: [{ id: 'devbox-window', title: 'Feature validation' }] });
  const renewed = await request(f.origin + '/auth/refresh', { method: 'POST', headers, body: '{}' });
  expect(renewed.status).toBe(200);
  expect(await renewed.json()).toMatchObject({ auth: { capabilities: { gatewaySetup: false } } });
  expect((await (await request(f.origin + '/auth/sessions', { headers })).json()).recentAuthentication).toBe(true);
}, 15000);

it('bootstraps an ordinary Host invitation and preserves its registered identity across restart', async () => {
  const f = await fixture(); const connection = await f.server.getConnection();
  expect(connection.serverUrl).toBe(f.origin);
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${connection.remoteKey}` }, handshakeTimeout: 3000 });
  cleanups.push(async () => { socket.terminate(); });
  await once(socket, 'open');
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'devbox-native-host', name: 'Devbox Host', credentialRotation: true,
    providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const initial = JSON.parse((await message)[0].toString());
  expect(initial).toMatchObject({ type: 'credential_issued', credential: expect.any(String) });
  const registered = once(socket, 'message'); socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  const registration = JSON.parse((await registered)[0].toString());
  expect(registration).toMatchObject({ type: 'registered', hostId: expect.any(String) });
  const first = await request(f.origin + '/auth/status'); const state = await first.json(); const headers = { cookie: cookies(first) };
  expect(await (await request(f.origin + state.basePath + 'v1/remote/hosts', { headers })).json()).toMatchObject({ hosts: [{ id: registration.hostId, online: true }] });
  socket.terminate(); await f.restart();
  const recovered = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${initial.credential}` }, handshakeTimeout: 3000 });
  cleanups.push(async () => { recovered.terminate(); });
  await once(recovered, 'open'); const next = once(recovered, 'message');
  recovered.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'devbox-native-host', name: 'Devbox Host', credentialRotation: true,
    providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  expect(JSON.parse((await next)[0].toString())).toMatchObject({ type: 'registered', hostId: registration.hostId });
  expect((await (await request(f.origin + '/auth/sessions', { headers })).json()).sessions).toHaveLength(1);
}, 15000);

it('renews local authority and replaces an expired browser session without changing the user namespace', async () => {
  const f = await fixture();
  const opened = await request(f.origin + '/auth/status'); const first = await opened.json();
  const headers = { cookie: cookies(opened), origin: f.origin, 'content-type': 'application/json' };
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000);
  const renewed = await request(f.origin + '/auth/refresh', { method: 'POST', headers, body: '{}' });
  expect(renewed.status).toBe(200);
  expect(renewed.headers.getSetCookie().some(value => value.startsWith('devbox_session='))).toBe(false);
  expect((await (await request(f.origin + '/auth/sessions', { headers })).json()).recentAuthentication).toBe(true);
  clock.mockReturnValue(now + 13 * 60 * 60_000);
  const replaced = await request(f.origin + '/auth/status', { headers });
  expect(replaced.status).toBe(200);
  expect((await replaced.json()).basePath).toBe(first.basePath);
  expect(replaced.headers.getSetCookie().find(value => value.startsWith('devbox_session='))).toBeDefined();
  clock.mockRestore();
}, 15000);

it('keeps permission changes available on the same Devbox WebSocket after eleven minutes of renewal', async () => {
  // Capture the real scheduler callback without changing the server or its HTTP/WebSocket transports.
  const create = hosted.createHostedRelay;
  let runtime: ReturnType<typeof create> | undefined;
  vi.spyOn(hosted, 'createHostedRelay').mockImplementation(options => runtime = create(options));
  const f = await fixture(); const connection = await f.server.getConnection();
  const host = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${connection.remoteKey}` }, handshakeTimeout: 3000 });
  cleanups.push(async () => { host.terminate(); });
  await once(host, 'open');
  const issued = once(host, 'message');
  host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'permission-host', name: 'Devbox Host', credentialRotation: true,
    providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  expect(JSON.parse((await issued)[0].toString()).type).toBe('credential_issued');
  const registered = once(host, 'message'); host.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  const { hostId } = JSON.parse((await registered)[0].toString());
  let complete!: (value: unknown) => void;
  const outcome = new Promise(resolve => { complete = resolve; });
  host.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'rpc_request') host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200,
      body: JSON.stringify({ agentId: 'permissions-agent', nativeSessionId: 'native' }) }));
    if (message.type === 'stream_open') {
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId: message.streamId }));
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: 'connected' }));
    }
    if (message.type === 'stream_message') complete({ forwarded: JSON.parse(message.message) });
  });
  const status = await request(f.origin + '/auth/status'); const state = await status.json();
  const headers = { cookie: cookies(status), origin: f.origin, 'content-type': 'application/json' };
  expect((await request(f.origin + state.basePath + `v1/remote/hosts/${hostId}/attach`, { method: 'POST', headers,
    body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native' }) })).status).toBe(200);
  const stream = new WebSocket((f.origin + state.basePath + 'v1/sessions/permissions-agent/events').replace('http:', 'ws:'), { headers, handshakeTimeout: 3000 });
  cleanups.push(async () => { stream.terminate(); });
  expect((await once(stream, 'message'))[0].toString()).toBe('connected');
  stream.on('message', raw => complete(JSON.parse(raw.toString())));
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (let minute = 0; minute < 11; minute++) { now += 60_000; await runtime!.refresh(); }
  expect((await request(f.origin + '/auth/refresh', { method: 'POST', headers, body: '{}' })).status).toBe(200);
  expect((await (await request(f.origin + '/auth/sessions', { headers })).json()).recentAuthentication).toBe(true);
  expect(stream.readyState).toBe(WebSocket.OPEN);
  const setting = { protocolVersion: PROTOCOL_VERSION, type: 'set_session_setting', payload: { agentId: 'permissions-agent', settingId: 'sandbox', value: 'workspace-write',
    requestId: 'permission-change', operationId: '00000000-0000-4000-8000-000000000001' } };
  stream.send(JSON.stringify(setting));
  expect(await outcome).toEqual({ forwarded: setting });
}, 15000);

it('rejects cross-origin bootstrap and authority forgery while production Relay still requires sign-in', async () => {
  const f = await fixture();
  const deniedHeaders: Record<string, string>[] = [{ origin: 'https://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }, { authorization: 'Bearer irrelevant' }];
  for (const headers of deniedHeaders) {
    expect((await request(f.origin + '/auth/status', { headers })).status).toBe(403);
  }
  expect((await request(f.origin + '/api/agent-remote/user-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"subject":"devbox"}' })).status).toBe(401);
  expect((await request(f.origin + '/auth/status', { headers: { cookie: 'devbox_session=expired' } })).status).toBe(200);
  await expect(createDevboxServer({ ...f.options, origin: 'https://public.example' })).rejects.toThrow(/loopback/);
  await expect(createDevboxServer({ ...f.options, origin: 'http://127.0.0.1:1' })).rejects.toThrow(/origin/);
  const production = createGatewayRelay({ origin: 'http://127.0.0.1:0', issuer: 'https://issuer.example', secret: 'production-test-secret-01234567890123456789' });
  cleanups.push(() => production.close()); const { url } = await production.listen(0);
  expect((await request(url + '/auth/status')).status).toBe(401);
  const identity = JSON.parse(await readFile(join(f.options.stateDir, 'identity.json'), 'utf8'));
  expect(identity.origin).toBe(f.origin);
}, 15000);
