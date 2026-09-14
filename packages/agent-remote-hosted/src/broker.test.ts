import { afterEach, expect, it } from 'vitest';
import { createHostBroker, HostSharing, type RelaySocket, type RemoteHostBrokerState } from './index.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

function transportPair() {
  class Socket implements RelaySocket {
    readyState = 1;
    bufferedAmount = 0;
    peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void>();
    closes = new Set<() => void>();
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); });
    }
    close() {
      if (this.readyState !== 1) return;
      this.readyState = 3;
      for (const listener of this.closes) listener();
      this.peer.close();
    }
    onMessage(listener: (data: string, binary: boolean) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
    onError(_listener: () => void) { return () => {}; }
  }
  const server = new Socket(); const native = new Socket(); server.peer = native; native.peer = server;
  close.push(() => server.close());
  return { server, native };
}

it('pairs a portable Host and preserves its catalog and native creation request', async () => {
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000 });
  close.push(() => broker.close());
  const request = (path: string, body?: unknown) => new Request(`https://relay.example${path}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const pairing = await broker.handleRequest(request('/v1/remote/pairings', {}));
  expect(pairing?.status).toBe(201);
  const credential = await pairing!.json();
  expect(credential.key).toMatch(/^arc_[A-Za-z0-9_-]{43}$/);
  expect(credential.serverUrl).toBe('https://relay.example');
  const prepared = await broker.prepareUpgrade(new Request('https://relay.example/ws/remote-host', {
    headers: { authorization: `Bearer ${credential.key}` },
  }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const pair = transportPair();
  const registered = new Promise<{ hostId: string; type: string }>(resolve => {
    pair.native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'registered') resolve(message); });
  });
  prepared.accept(pair.server);
  pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'portable-native',
    name: 'Portable Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const host = await registered;
  expect(host.type).toBe('registered');
  expect(await (await broker.handleRequest(request('/v1/remote/hosts')))!.json()).toEqual({
    hosts: [{ id: host.hostId, name: 'Portable Host', online: true, providers: [{ providerId: 'codex', displayName: 'Codex' }], providerId: 'codex' }],
  });
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  pair.native.onMessage(data => {
    const message = JSON.parse(data);
    if (message.type !== 'rpc_request') return;
    calls.push({ method: message.method, path: message.path, ...(message.body === undefined ? {} : { body: message.body }) });
    pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200,
      body: message.path === '/remote/create'
        ? '{"agentId":"native-agent-7","nativeSessionId":"native-session-9"}'
        : '{"items":[{"providerId":"codex","nativeSessionId":"catalog-session"}],"revision":"revision-1"}' }));
  });
  expect(await (await broker.handleRequest(request(`/v1/remote/hosts/${host.hostId}/catalog?providerId=codex&limit=2`)))!.json()).toEqual({
    items: [{ providerId: 'codex', nativeSessionId: 'catalog-session' }], revision: 'revision-1',
  });
  expect(await (await broker.handleRequest(request(`/v1/remote/hosts/${host.hostId}/create`, {
    providerId: 'codex', requestId: 'portable-create', cwd: '/work/project', model: 'gpt-6', reasoningEffort: 'high', planning: true,
  })))!.json()).toEqual({ agentId: 'native-agent-7', nativeSessionId: 'native-session-9' });
  expect(calls).toEqual([
    { method: 'GET', path: '/remote/catalog?providerId=codex&limit=2' },
    { method: 'POST', path: '/remote/create', body: '{"providerId":"codex","requestId":"portable-create","cwd":"/work/project","model":"gpt-6","reasoningEffort":"high","planning":true}' },
  ]);
}, 10_000);

const restoredState: RemoteHostBrokerState = {
  keys: [['7a8ce1c8927a74e75f9bc855677bd2cb361d6b19a58f85296a8777022d022a14', { expires: 20_000, installationId: 'restored-installation' }]],
  hosts: [{ id: 'host', installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
  bindings: [{ hostId: 'host', providerId: 'codex', nativeSessionId: 'native-session', agentId: 'agent' }],
  creations: [],
};

async function restoredFixture() {
  const broker = createHostBroker({ origin: 'https://relay.example', initialState: restoredState, now: () => 10_000, rpcTimeoutMs: 1000 });
  close.push(() => broker.close());
  const prepared = await broker.prepareUpgrade(new Request('https://relay.example/ws/remote-host', { headers: { authorization: 'Bearer arc_fixture' } }));
  if (!prepared || prepared instanceof Response) throw new Error('Known SHA-256 credential was rejected');
  const pair = transportPair();
  const registered = new Promise<string>(resolve => pair.native.onMessage(data => {
    const message = JSON.parse(data); if (message.type === 'registered') resolve(message.hostId);
  }));
  prepared.accept(pair.server);
  pair.native.send('{"uplinkVersion":2,"type":"register","installationId":"restored-installation","name":"Restored Host","providers":[{"providerId":"codex","displayName":"Codex"}]}');
  expect(await registered).toBe('host');
  return { broker, native: pair.native };
}

it.each([204, 205, 304])('preserves a native RPC HTTP status %s that cannot carry a Web Response body', async status => {
  const { broker, native } = await restoredFixture();
  native.onMessage(data => {
    const message = JSON.parse(data);
    if (message.type === 'rpc_request') native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status, body: '' }));
  });
  const result = await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host/catalog?providerId=codex'));
  expect(result?.status).toBe(status);
  expect(await result!.text()).toBe('');
}, 10_000);

it('prepares a browser upgrade only after authorization and native binding recovery complete', async () => {
  const { broker, native } = await restoredFixture();
  const request = () => new Request('https://relay.example/v1/sessions/agent/events', { headers: { origin: 'https://relay.example' } });
  const denied = await broker.prepareUpgrade(request(), { authorize: () => false });
  expect(denied).toBeInstanceOf(Response);
  expect((denied as Response).status).toBe(403);
  const recovery = new Promise<{ requestId: string; method: string; path: string; sessionId: string; body: string }>(resolve => {
    native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'rpc_request') resolve(message); });
  });
  let prepared = false;
  const upgrade = broker.prepareUpgrade(request(), { authorize: async () => true }).then(value => { prepared = true; return value; });
  const rpc = await recovery;
  expect(prepared).toBe(false);
  expect({ method: rpc.method, path: rpc.path, sessionId: rpc.sessionId, body: rpc.body }).toEqual({
    method: 'POST', path: '/remote/attach', sessionId: 'agent', body: '{"providerId":"codex","nativeSessionId":"native-session"}',
  });
  native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: rpc.requestId, status: 200,
    body: '{"agentId":"agent","nativeSessionId":"native-session"}' }));
  const accepted = await upgrade;
  if (!accepted || accepted instanceof Response) throw new Error('Recovered stream rejected');
  const opened = new Promise<unknown>(resolve => native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'stream_open') resolve(message); }));
  accepted.accept(transportPair().server);
  expect(await opened).toMatchObject({ uplinkVersion: 2, type: 'stream_open', sessionId: 'agent' });
}, 10_000);

it('returns an explicit rejection when native recovery fails and leaves unowned routes untouched', async () => {
  const { broker, native } = await restoredFixture();
  native.onMessage(data => {
    const message = JSON.parse(data);
    if (message.type === 'rpc_request') native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 409, body: '{}' }));
  });
  const rejected = await broker.prepareUpgrade(new Request('https://relay.example/v1/sessions/agent/events', { headers: { origin: 'https://relay.example' } }));
  expect(rejected).toBeInstanceOf(Response);
  expect((rejected as Response).status).toBe(503);
  expect(await broker.handleRequest(new Request('https://relay.example/health'))).toBeUndefined();
  expect(await broker.prepareUpgrade(new Request('https://relay.example/v1/sessions/unowned/events'))).toBeUndefined();
}, 10_000);

it('counts request body bytes and rejects malformed JSON without issuing pairing credentials', async () => {
  const broker = createHostBroker({ origin: 'https://relay.example' }); close.push(() => broker.close());
  const request = (body: string) => new Request('https://relay.example/v1/remote/pairings', { method: 'POST', body });
  const tooLarge = await broker.handleRequest(request(JSON.stringify({ text: '界'.repeat(22_000) })));
  expect(tooLarge?.status).toBe(413);
  expect(await tooLarge!.json()).toMatchObject({ code: 'request_too_large' });
  expect((await broker.handleRequest(request('{')))!.status).toBe(400);
  expect(broker.snapshot().keys).toEqual([]);
}, 10_000);

it('keeps the persisted shared native request identity byte compatible', () => {
  const sharing = new HostSharing(undefined, () => {});
  sharing.set('host', 'bob', 'Bob', 1);
  expect(sharing.reserve('host', 'bob', 'codex', 'request-1', 'fingerprint').nativeRequestId).toBe(
    'shared:8346efd12290a4f47c75c7ca87fe63103fd34bc003df16e1f3fd685393cabfe8',
  );
}, 10_000);
