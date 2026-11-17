// @vitest-environment node
import { createServer } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createWindowView, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import * as hosted from '@orchardworks/agent-relay-core';
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';
import * as sqliteNode from '@orchardworks/agent-remote-journal-sqlite/node';
import { openNodeJournalDatabase } from '@orchardworks/agent-remote-journal-sqlite/node';
import { createDevboxServer } from './devbox.js';
import { createGatewayRelay } from './gateway-relay.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

async function fixture(hostname = '127.0.0.1', extra: Partial<Parameters<typeof createDevboxServer>[0]> = {}, listen = true) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-devbox-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const webDist = join(directory, 'web'); await mkdir(webDist);
  await writeFile(join(webDist, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://${hostname}:${port}`;
  const options = { origin, stateDir: join(directory, 'state'), webDist, ...extra };
  let server = await createDevboxServer(options); if (listen) await server.listen(port, '127.0.0.1');
  cleanups.push(() => server.close());
  return { origin, port, options, directory, get server() { return server; },
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
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/remote-host?control=1', { headers: { authorization: `Bearer ${connection.remoteKey}` }, handshakeTimeout: 3000 });
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
  const recovered = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/remote-host?control=1', { headers: { authorization: `Bearer ${initial.credential}` }, handshakeTimeout: 3000 });
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
  const host = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/remote-host?control=1', { headers: { authorization: `Bearer ${connection.remoteKey}` }, handshakeTimeout: 3000 });
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
    if (message.type === 'stream_message' && JSON.parse(message.message).type === 'negotiate') { host.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {} }) })); return; }
    if (message.type === 'stream_message') complete({ forwarded: JSON.parse(message.message) });
  });
  const status = await request(f.origin + '/auth/status'); const state = await status.json();
  const headers = { cookie: cookies(status), origin: f.origin, 'content-type': 'application/json' };
  expect((await request(f.origin + state.basePath + `v1/remote/hosts/${hostId}/attach`, { method: 'POST', headers,
    body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native' }) })).status).toBe(200);
  /** Negotiates and acquires control from the Relay, as a page does; the token that grants it. */
  const acquire = async (socket: WebSocket, agentId: string): Promise<string> => {
    const seen: any[] = [];
    socket.on('message', raw => { try { seen.push(JSON.parse(raw.toString())); } catch { /* not a protocol frame */ } });
    const next = async (match: (frame: any) => boolean) => { for (let attempt = 0; attempt < 400; attempt++) { const at = seen.findIndex(match); if (at >= 0) return seen.splice(at, 1)[0]; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('No control frame.'); };
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
    const announced = await next(frame => frame.type === 'session_control');
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { agentId, requestId: 'acquire', revision: announced.payload.revision, action: 'acquire' } }));
    return (await next(frame => frame.payload?.requestId === 'acquire')).payload.token;
  };
  const stream = new WebSocket((f.origin + state.basePath + 'v1/sessions/permissions-agent/events').replace('http:', 'ws:'), { headers, handshakeTimeout: 3000 });
  cleanups.push(async () => { stream.terminate(); });
  expect((await once(stream, 'message'))[0].toString()).toBe('connected');
  const token = await acquire(stream, 'permissions-agent');
  stream.on('message', raw => complete(JSON.parse(raw.toString())));
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (let minute = 0; minute < 11; minute++) { now += 60_000; await runtime!.refresh(); }
  expect((await request(f.origin + '/auth/refresh', { method: 'POST', headers, body: '{}' })).status).toBe(200);
  expect((await (await request(f.origin + '/auth/sessions', { headers })).json()).recentAuthentication).toBe(true);
  expect(stream.readyState).toBe(WebSocket.OPEN);
  const setting = { protocolVersion: PROTOCOL_VERSION, type: 'set_session_setting', controlToken: token, payload: { agentId: 'permissions-agent', settingId: 'sandbox', value: 'workspace-write',
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

/** Connects a Controller that asks for journals and completes the credential handshake; returns what the Relay sends, by type. */
async function journalController(origin: string, remoteKey: string) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/remote-host?journal=1', { headers: { authorization: `Bearer ${remoteKey}` }, handshakeTimeout: 3000 });
  cleanups.push(async () => { socket.terminate(); });
  await once(socket, 'open');
  const inbox: Array<Record<string, any>> = [];
  socket.on('message', data => { inbox.push(JSON.parse(data.toString())); });
  const take = async (type: string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const at = inbox.findIndex(message => message.type === type);
      if (at >= 0) return inbox.splice(at, 1)[0]!;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`The Relay sent no ${type}.`);
  };
  const send = (fields: Record<string, unknown>) => socket.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
  send({ type: 'register', installationId: 'journal-host', name: 'Journal Host', credentialRotation: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  expect(await take('credential_issued')).toMatchObject({ credential: expect.any(String) });
  send({ type: 'credential_saved' });
  return { socket, send, take, registered: await take('registered') };
}

it('stores Host journals in SQLite beside the state when journals are on, and grants them only then', async () => {
  const off = await fixture();
  expect(existsSync(join(off.options.stateDir, 'relay', 'journals.sqlite'))).toBe(false);
  const offController = await journalController(off.origin, (await off.server.getConnection()).remoteKey);
  expect(offController.registered).toMatchObject({ type: 'registered' });
  expect(offController.registered).not.toHaveProperty('journal');

  const f = await fixture('127.0.0.1', { journals: true });
  expect(existsSync(join(f.options.stateDir, 'relay', 'journals.sqlite'))).toBe(true);
  const controller = await journalController(f.origin, (await f.server.getConnection()).remoteKey);
  expect(controller.registered).toMatchObject({ type: 'registered', journal: 1 });
  controller.send({ type: 'journal_open', requestId: 'open-1', sessionKey: 'codex:thread-1', publisherId: 'controller-1' });
  expect(await controller.take('journal_opened')).toMatchObject({ generation: 1, watermark: 0 });
  controller.send({ type: 'journal_publish', sessionKey: 'codex:thread-1', generation: 1, entries: [
    { sequence: 1, op: 'append', row: { itemKey: 'm1', providerId: 'codex', sourceKey: 'm1:1', occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'assistant_message', text: 'Hello', messageId: 'm1' } } },
  ] });
  expect(await controller.take('journal_ack')).toMatchObject({ generation: 1, watermark: 1 });
  controller.socket.terminate();
  await f.server.close();
  const database = await openNodeJournalDatabase(join(f.options.stateDir, 'relay', 'journals.sqlite'));
  try {
    const stored = await new SqlJournalStore(database).load(`${controller.registered.hostId}:codex:thread-1`);
    expect(stored?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  } finally { database.close(); }
}, 30000);

it('refuses journals without a state file', () => {
  expect(() => createGatewayRelay({ origin: 'http://127.0.0.1:0', issuer: 'http://127.0.0.1:0', secret: 'journal-secret-01234567890123456789', journalFile: join(tmpdir(), 'arc-never.sqlite') })).toThrow(/state file/);
});

/** Observes the journal database the Node host opens: every handle it hands out and whether it was closed. */
function watchJournalDatabases() {
  const handles: Array<{ closed: boolean }> = [];
  const open = sqliteNode.openNodeJournalDatabase;
  vi.spyOn(sqliteNode, 'openNodeJournalDatabase').mockImplementation(async file => {
    const database = await open(file);
    const handle = { closed: false };
    const close = database.close.bind(database);
    database.close = () => { handle.closed = true; close(); };
    handles.push(handle);
    return database;
  });
  return handles;
}
/** Wraps the journal service the Node host builds so a test can see its head index being loaded, and make that load fail. */
function watchJournalService(failure?: Error) {
  const loads: string[] = [];
  const create = hosted.createHostJournals;
  vi.spyOn(hosted, 'createHostJournals').mockImplementation(options => {
    const service = create(options);
    const load = service.loadAllServed.bind(service);
    service.loadAllServed = async () => { loads.push('load'); if (failure) throw failure; await load(); };
    return service;
  });
  return loads;
}

it('loads the head index of the journal store before the Relay listens', async () => {
  const loads = watchJournalService();
  const f = await fixture('127.0.0.1', { journals: true });
  expect(loads).toEqual(['load']);
  expect((await request(f.origin + '/auth/status')).status).toBe(200);
});

it('closes the journal database when the Relay stops', async () => {
  const handles = watchJournalDatabases();
  const f = await fixture('127.0.0.1', { journals: true });
  expect(handles).toHaveLength(1);
  expect(handles[0]!.closed).toBe(false);
  await f.server.close();
  expect(handles[0]!.closed).toBe(true);
});

it('does not listen, builds no Relay and closes the journal database when the head index cannot be loaded', async () => {
  const handles = watchJournalDatabases();
  watchJournalService(new Error('journal index unavailable'));
  const create = vi.spyOn(hosted, 'createHostedRelay');
  const f = await fixture('127.0.0.1', { journals: true }, false);
  await expect(f.server.listen(f.port, '127.0.0.1')).rejects.toThrow('journal index unavailable');
  expect(handles).toHaveLength(1);
  expect(handles[0]!.closed).toBe(true);
  expect(create).not.toHaveBeenCalled();
  await expect(request(f.origin + '/auth/status')).rejects.toThrow();
});

it('closes the journal database and stops listening when the Relay cannot be built', async () => {
  const handles = watchJournalDatabases();
  vi.spyOn(hosted, 'createHostedRelay').mockImplementation(() => { throw new Error('relay unavailable'); });
  const f = await fixture('127.0.0.1', { journals: true }, false);
  await expect(f.server.listen(f.port, '127.0.0.1')).rejects.toThrow('relay unavailable');
  expect(handles[0]!.closed).toBe(true);
  await expect(request(f.origin + '/auth/status')).rejects.toThrow();
});

it('closes the journal database when the port is taken', async () => {
  const handles = watchJournalDatabases();
  const f = await fixture('127.0.0.1', { journals: true }, false);
  const occupied = createServer(); occupied.listen(f.port, '127.0.0.1'); await once(occupied, 'listening');
  cleanups.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  await expect(f.server.listen(f.port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
  expect(handles[0]!.closed).toBe(true);
});

it('fails on the state lock, before it opens the journal database, when another Relay holds the state directory', async () => {
  const handles = watchJournalDatabases();
  const first = await fixture('127.0.0.1', { journals: true });
  expect(handles).toHaveLength(1);
  const second = await createDevboxServer(first.options);
  await expect(second.listen(first.port, '127.0.0.1')).rejects.toThrow(/lock|another/i);
  expect(handles).toHaveLength(1);
  expect((await request(first.origin + '/auth/status')).status).toBe(200);
});
