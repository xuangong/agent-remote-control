// @vitest-environment node
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createRemoteHostBroker, type RemoteHostBrokerState } from './remote-host-broker.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const event = (socket: WebSocket, name: string) => once(socket, name, { signal: AbortSignal.timeout(3000) });
async function fixture(initialState?: RemoteHostBrokerState, initialTime = Date.now()) {
  let time = initialTime; let saved: RemoteHostBrokerState | undefined;
  const server = createServer();
  const broker = createRemoteHostBroker({ origin: 'http://127.0.0.1:6175', durable: true, keyLifetimeMs: 1000, initialState,
    now: () => time, onStateChange: state => { saved = state; } });
  broker.install(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => { await broker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = (path = '', method = 'GET', body = {}) => fetch(url + '/v1/remote/pairings' + path, { method, signal: AbortSignal.timeout(3000),
    ...(method !== 'GET' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const pair = async (purpose = 'host-only') => { const response = await request('', 'POST', { purpose }); expect(response.status).toBe(201); return response.json(); };
  async function connect(key: string) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
    cleanups.push(async () => socket.terminate()); await event(socket, 'open'); return socket;
  }
  async function enroll(key: string, installationId = 'installation') {
    const socket = await connect(key); const issued = event(socket, 'message');
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId, name: 'Worker', providers: [] }));
    const credential = JSON.parse((await issued)[0].toString()).credential;
    expect(credential).toMatch(/^arc_device_/);
    const ready = event(socket, 'message'); socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
    return { credential, ready: JSON.parse((await ready)[0].toString()), socket };
  }
  async function rejected(key: string) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
    cleanups.push(async () => socket.terminate());
    const status = await new Promise<number>(resolve => socket.once('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode!); }));
    socket.on('error', () => {}); socket.terminate(); expect(status).toBe(401);
  }
  return { pair, request, connect, enroll, rejected, advance: () => { time += 2000; }, saved: () => saved, now: () => time };
}

it('lists purposes and one-use status without secrets, retains history and preserves device access when deleting used keys', async () => {
  const f = await fixture();
  const pairing = await f.pair('gateway-setup');
  const before = await (await f.request()).json();
  expect(before).toMatchObject({ availablePurposes: ['host-only', 'gateway-setup'], pairings: [{ id: pairing.id, purpose: 'gateway-setup', status: 'unused' }] });
  expect(JSON.stringify(before)).not.toContain(pairing.key);
  const enrolled = await f.enroll(pairing.key);
  expect(enrolled.ready.pairingPurpose).toBe('gateway-setup');
  await f.rejected(pairing.key);
  expect(await (await f.request()).json()).toMatchObject({ pairings: [{ status: 'used', hostId: enrolled.ready.hostId, hostName: 'Worker' }] });
  expect((await f.request('/' + pairing.id + '/revoke', 'POST')).status).toBe(409);
  expect((await f.request('/' + pairing.id, 'DELETE')).status).toBe(200);
  const restored = await fixture(f.saved(), f.now());
  expect(await (await restored.request()).json()).toMatchObject({ pairings: [] });
  const socket = await restored.connect(enrolled.credential); const ready = event(socket, 'message');
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId: 'installation', name: 'Worker', providers: [] }));
  expect(JSON.parse((await ready)[0].toString())).toMatchObject({ type: 'registered', pairingPurpose: 'gateway-setup' });
}, 10000);

it('lists obsolete and revoked keys after restart and invalidates an unused key on deletion', async () => {
  const f = await fixture(); const obsolete = await f.pair(); f.advance();
  const revoked = await f.pair(); expect((await f.request('/' + revoked.id + '/revoke', 'POST')).status).toBe(200);
  await f.rejected(revoked.key);
  const deleted = await f.pair(); expect((await f.request('/' + deleted.id, 'DELETE')).status).toBe(200); await f.rejected(deleted.key);
  const restored = await fixture(f.saved(), f.now());
  expect(await (await restored.request()).json()).toMatchObject({ pairings: expect.arrayContaining([
    expect.objectContaining({ id: obsolete.id, status: 'obsolete' }), expect.objectContaining({ id: revoked.id, status: 'revoked' }),
  ]) });
}, 10000);

it('atomically claims an invitation even when two sockets preauthenticate the same installation', async () => {
  const f = await fixture(); const pairing = await f.pair();
  const sockets = await Promise.all([f.connect(pairing.key), f.connect(pairing.key)]);
  const outcomes = sockets.map(socket => new Promise<string>(resolve => { socket.once('message', raw => resolve(JSON.parse(raw.toString()).type)); socket.once('close', () => resolve('closed')); }));
  for (const socket of sockets) socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId: 'same-installation', name: 'Host', providers: [] }));
  expect((await Promise.all(outcomes)).sort()).toEqual(['closed', 'credential_issued']);
  expect(f.saved()?.hosts).toHaveLength(1);
}, 10000);

it.each([
  { gatewayKeyRequested: undefined, expectedPurpose: 'host-only' },
  { gatewayKeyRequested: true, expectedPurpose: 'gateway-setup' },
])('preserves legacy Host authority on re-pairing when gatewayKeyRequested is $gatewayKeyRequested', async ({ gatewayKeyRequested, expectedPurpose }) => {
  const f = await fixture({
    keys: [], bindings: [], creations: [],
    hosts: [{ id: 'legacy-host', installationId: 'legacy-installation', name: 'Legacy worker', providers: [], legacyDsh: false,
      ...(gatewayKeyRequested ? { gatewayKeyRequested } : {}) }],
  });
  const invitation = await f.pair('gateway-setup');
  const enrolled = await f.enroll(invitation.key, 'legacy-installation');
  expect(enrolled.ready).toMatchObject({ type: 'registered', hostId: 'legacy-host', pairingPurpose: expectedPurpose });
  expect(f.saved()?.hosts).toEqual([expect.objectContaining({ id: 'legacy-host', pairingPurpose: expectedPurpose })]);
  expect(await (await f.request()).json()).toMatchObject({ pairings: [{ id: invitation.id, status: 'used', purpose: 'gateway-setup', hostId: 'legacy-host' }] });
}, 10000);


it('defaults to host-only and rejects unknown or client-chosen setup parameters', async () => {
  const f = await fixture();
  const response = await f.request('', 'POST');
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ purpose: 'host-only', status: 'unused' });
  for (const body of [{ purpose: 'codex' }, { purpose: 'gateway-setup', provider: 'codex' }, { purpose: 'admin' }]) {
    expect((await f.request('', 'POST', body)).status).toBe(400);
  }
  expect((await (await f.request()).json()).pairings).toHaveLength(1);
}, 10000);
