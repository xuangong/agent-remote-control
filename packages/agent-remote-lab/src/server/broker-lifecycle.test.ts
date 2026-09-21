// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createRemoteHostBroker, type RemoteHostBrokerState } from './remote-host-broker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
async function fixture(initialState?: RemoteHostBrokerState, afterPersist?: (state: RemoteHostBrokerState) => void) {
  let state: RemoteHostBrokerState | undefined;
  const server = createServer((_, res) => { res.writeHead(404); res.end(); });
  const broker = createRemoteHostBroker({ origin: 'http://localhost', durable: true, initialState,
    accessPolicy: { authorize: () => true }, mutationPolicy: { validate: () => ({ status: 'allowed' }) },
    onStateChange: value => { state = structuredClone(value); afterPersist?.(state); } });
  broker.install(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No listener');
  const url = `http://127.0.0.1:${address.port}`;
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await broker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  cleanups.push(close);
  const request = (path: string, body?: unknown) => fetch(url + '/v1/' + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pair = async () => (await (await request('remote/pairings', {})).json()).key as string;
  const connect = async (key: string, installationId = 'workstation') => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
    await once(ws, 'open'); const registered = once(ws, 'message');
    ws.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId, name: 'Workstation', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    let message = JSON.parse((await registered)[0].toString());
    if (message.type === 'credential_issued') {
      key = message.credential; const saved = once(ws, 'message');
      ws.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
      message = JSON.parse((await saved)[0].toString());
    }
    expect(message.type).toBe('registered');
    const hostId = message.hostId as string;
    const calls: string[] = [];
    ws.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.type === 'rpc_request') {
      calls.push(msg.path); ws.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: msg.requestId, status: 200,
        body: JSON.stringify(msg.path === '/remote/attach' ? { agentId: 'agent-one', nativeSessionId: 'native-one' } : { restored: true }) }));
    } });
    return { ws, hostId, calls, key };
  };
  return { url, request, pair, connect, close, saved: () => state };
}
it('restores an enrolled device and native binding with the same identities after restart', async () => {
  const first = await fixture(); const key = await first.pair(); const host = await first.connect(key);
  await first.request(`remote/hosts/${host.hostId}/attach`, { providerId: 'codex', nativeSessionId: 'native-one' });
  const state = first.saved(); expect(state?.hosts).toHaveLength(1);
  expect(JSON.stringify(state)).not.toContain(key);
  await first.close();
  const second = await fixture(state); const restored = await second.connect(host.key);
  expect(restored.hostId).toBe(host.hostId);
  expect(await (await second.request('sessions/agent-one/snapshot')).json()).toEqual({ restored: true });
  expect(restored.calls).toEqual(['/remote/attach', '/v1/sessions/agent-one/snapshot']);
}, 10000);
it('rotates the credential for an installation and revokes its active connection durably', async () => {
  const f = await fixture(); const oldKey = await f.pair(); const first = await f.connect(oldKey);
  const oldClosed = once(first.ws, 'close');
  const newKey = await f.pair(); const next = await f.connect(newKey); await oldClosed;
  expect(next.hostId).toBe(first.hostId);
  const denied = async (url: string, key: string) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
    ws.on('error', () => undefined); ws.once('open', () => { ws.terminate(); reject(Error('Accepted revoked key')); });
    ws.once('unexpected-response', (_, res) => { res.resume(); ws.terminate(); resolve(res.statusCode ?? 0); });
  });
  expect(await denied(f.url, oldKey)).toBe(401);
  const closed = once(next.ws, 'close');
  expect((await f.request(`remote/hosts/${next.hostId}/revoke`, {})).status).toBe(200); await closed;
  expect(await (await f.request('remote/hosts')).json()).toEqual({ hosts: [] });
  const state = f.saved(); await f.close(); const restarted = await fixture(state);
  expect(await denied(restarted.url, newKey)).toBe(401);
}, 10000);
it('rejects late registration on a revoked pending socket without restoring its credential', async () => {
  const f = await fixture(); const invitation = await f.pair(); const { key: oldKey } = await f.connect(invitation);
  const pending = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${oldKey}` } });
  await once(pending, 'open');
  // An uncooperative peer can send frames while the server is awaiting its close acknowledgement.
  const transport = (pending as unknown as { _socket: import('node:net').Socket })._socket;
  transport.pause();
  try {
    const newKey = await f.pair(); const current = await f.connect(newKey);
    pending.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'workstation', name: 'Late revoked peer', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await (await f.request('remote/hosts')).json()).toMatchObject({ hosts: [{ id: current.hostId, name: 'Workstation', online: true }] });
    const reconnect = await f.connect(current.key); expect(reconnect.hostId).toBe(current.hostId);
  } finally { transport.resume(); pending.terminate(); }
}, 10000);

it('consumes invitations, rotates only after durable acknowledgement, and restores a saved offer after disconnect', async () => {
  const f = await fixture(); const invitation = await f.pair(); const host = await f.connect(invitation);
  expect(host.key).toMatch(/^arc_device_/); expect(host.key).not.toBe(invitation);
  const rejected = (key: string) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
    socket.on('error', () => {}); socket.once('open', () => { socket.terminate(); reject(Error('Credential unexpectedly accepted')); });
    socket.once('unexpected-response', (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
  });
  expect(await rejected(invitation)).toBe(401);
  const offer = once(host.ws, 'message');
  expect(await (await f.request(`remote/hosts/${host.hostId}/rotate`, {})).json()).toEqual({ ok: true, status: 'pending' });
  const credential = JSON.parse((await offer)[0].toString()); expect(credential.type).toBe('credential_issued');
  expect((await f.request(`remote/hosts/${host.hostId}/rotate`, {})).status).toBe(409);
  expect(JSON.stringify(f.saved())).not.toContain(credential.credential);
  // The Host has saved the offer but the acknowledgement is lost with its connection.
  host.ws.terminate();
  const restored = await f.connect(credential.credential); expect(restored.hostId).toBe(host.hostId);
  expect(await rejected(host.key)).toBe(401);
  const nextOffer = once(restored.ws, 'message');
  expect((await f.request(`remote/hosts/${host.hostId}/rotate`, {})).status).toBe(200);
  const next = JSON.parse((await nextOffer)[0].toString());
  const registered = once(restored.ws, 'message'); restored.ws.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  expect(JSON.parse((await registered)[0].toString())).toMatchObject({ type: 'registered', hostId: host.hostId });
  expect(await rejected(credential.credential)).toBe(401);
  const saved = f.saved(); await f.close(); const restarted = await fixture(saved);
  expect((await restarted.connect(next.credential)).hostId).toBe(host.hostId);
}, 10000);

it('rejects obsolete clients for new invitations and forwards explicit stop outcomes without revoking the Host', async () => {
  const f = await fixture(); const invitation = await f.pair();
  const obsolete = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${invitation}` } });
  await once(obsolete, 'open'); const closed = once(obsolete, 'close');
  obsolete.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'old', name: 'Old', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  expect((await closed)[0]).toBe(1008);
  const host = await f.connect(invitation);
  expect((await f.request(`remote/hosts/${host.hostId}/stop`, { operationId: '00000000-0000-4000-8000-000000000001' })).status).toBe(200);
  expect(host.calls).toContain('/remote/stop');
  expect(host.ws.readyState).toBe(WebSocket.OPEN);
  expect((await f.request(`remote/hosts/${host.hostId}/rotate`, { credential: 'browser-supplied' })).status).toBe(400);
}, 10000);

it('keeps a claimed invitation consumed after interrupted enrollment and recovers with a new invitation', async () => {
  const first = await fixture(undefined, state => {
    // The durable write completes, but the process cannot publish it or offer a credential.
    if (state.hosts.length) throw Error('Registration interrupted after persistence');
  });
  const invitation = await first.pair(); const originalExpiry = first.saved()!.keys[0]![1].expires;
  const socket = new WebSocket(first.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${invitation}` } });
  await once(socket, 'open'); const closed = once(socket, 'close');
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId: 'interrupted', name: 'Interrupted Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  expect((await closed)[0]).toBe(1011);
  const saved = first.saved()!;
  expect(saved.keys[0]![1]).toMatchObject({ installationId: 'interrupted', requiresRotation: true, expires: originalExpiry });
  await first.close();
  const restored = await fixture(saved);
  const denied = await new Promise<number>((resolve, reject) => {
    const replay = new WebSocket(restored.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${invitation}` } });
    replay.on('error', () => undefined);
    replay.once('open', () => { replay.terminate(); reject(Error('Consumed invitation was accepted')); });
    replay.once('unexpected-response', (_, response) => { response.resume(); replay.terminate(); resolve(response.statusCode ?? 0); });
  });
  expect(denied).toBe(401);
  expect(saved.keys[0]![1].claimedAt).toBeTypeOf('number');
  expect(await (await restored.request('remote/pairings')).json()).toMatchObject({ pairings: [{ status: 'used', hostId: saved.hosts[0]!.id }] });
  const replacement = await restored.pair();
  const recovered = await restored.connect(replacement, 'interrupted');
  expect(recovered.hostId).toBe(saved.hosts[0]!.id);
}, 10000);

it('keeps enrollment offline until credential acknowledgment while an existing Host stays online during rotation', async () => {
  const f = await fixture(); const invitation = await f.pair();
  const socket = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${invitation}` } });
  await once(socket, 'open'); const offered = once(socket, 'message');
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId: 'pending', name: 'Pending Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  expect(JSON.parse((await offered)[0].toString()).type).toBe('credential_issued');
  const before = await (await f.request('remote/hosts')).json(); const hostId = before.hosts[0].id;
  expect(before.hosts[0].online).toBe(false);
  expect((await f.request(`remote/hosts/${hostId}/workspaces?providerId=codex`)).status).toBe(503);
  expect((await f.request(`remote/hosts/${hostId}/stop`, { operationId: '00000000-0000-4000-8000-000000000002' })).status).toBe(503);
  const acknowledged = once(socket, 'message'); socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  expect(JSON.parse((await acknowledged)[0].toString())).toMatchObject({ type: 'registered', hostId });
  expect((await (await f.request('remote/hosts')).json()).hosts[0].online).toBe(true);
  socket.on('message', raw => { const message = JSON.parse(raw.toString());
    if (message.type === 'rpc_request') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: '{"results":[]}' }));
  });
  const rotation = once(socket, 'message');
  expect((await f.request(`remote/hosts/${hostId}/rotate`, {})).status).toBe(200);
  expect(JSON.parse((await rotation)[0].toString()).type).toBe('credential_issued');
  expect((await (await f.request('remote/hosts')).json()).hosts[0].online).toBe(true);
  expect((await f.request(`remote/hosts/${hostId}/stop`, { operationId: '00000000-0000-4000-8000-000000000003' })).status).toBe(200);
}, 10000);
