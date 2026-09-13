// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createRemoteHostBroker, type RemoteHostBrokerState } from './remote-host-broker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
async function fixture(initialState?: RemoteHostBrokerState) {
  let state: RemoteHostBrokerState | undefined;
  const server = createServer((_, res) => { res.writeHead(404); res.end(); });
  const broker = createRemoteHostBroker({ origin: 'http://localhost', durable: true, initialState,
    accessPolicy: { authorize: () => true }, mutationPolicy: { validate: () => ({ status: 'allowed' }) },
    onStateChange: value => { state = structuredClone(value); } });
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
    ws.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId, name: 'Workstation', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    const hostId = JSON.parse((await registered)[0].toString()).hostId as string;
    const calls: string[] = [];
    ws.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.type === 'rpc_request') {
      calls.push(msg.path); ws.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: msg.requestId, status: 200,
        body: JSON.stringify(msg.path === '/remote/attach' ? { agentId: 'agent-one', nativeSessionId: 'native-one' } : { restored: true }) }));
    } });
    return { ws, hostId, calls };
  };
  return { url, request, pair, connect, close, saved: () => state };
}
it('restores an enrolled device and native binding with the same identities after restart', async () => {
  const first = await fixture(); const key = await first.pair(); const host = await first.connect(key);
  await first.request(`remote/hosts/${host.hostId}/attach`, { providerId: 'codex', nativeSessionId: 'native-one' });
  const state = first.saved(); expect(state?.hosts).toHaveLength(1);
  expect(JSON.stringify(state)).not.toContain(key);
  await first.close();
  const second = await fixture(state); const restored = await second.connect(key);
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
  const f = await fixture(); const oldKey = await f.pair(); await f.connect(oldKey);
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
    const reconnect = await f.connect(newKey); expect(reconnect.hostId).toBe(current.hostId);
  } finally { transport.resume(); pending.terminate(); }
}, 10000);
