import { afterEach, expect, it } from 'vitest';
import { createHostBroker, HostSharing, type RelaySocket, type RemoteHostBrokerState } from './index.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

function transportPair() {
  class Socket implements RelaySocket {
    readyState = 1;
    bufferedAmount = 0;
    closeCode?: number;
    peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void | Promise<void>>();
    closes = new Set<() => void>();
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); });
    }
    close(code?: number) {
      if (this.readyState !== 1) return;
      this.readyState = 3;
      this.closeCode = code;
      for (const listener of this.closes) listener();
      this.peer.close(code);
    }
    onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
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

async function restoredFixture(options: Partial<import('./broker.js').HostBrokerOptions> = {}) {
  const broker = createHostBroker({ origin: 'https://relay.example', initialState: restoredState, now: () => 10_000, rpcTimeoutMs: 1000, ...options });
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

it('limits concurrently prepared streams at acceptance without reserving abandoned preparations', async () => {
  const { broker, native } = await restoredFixture();
  let opened = 0;
  native.onMessage(data => {
    const message = JSON.parse(data);
    if (message.type === 'rpc_request') native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200,
      body: '{"agentId":"agent","nativeSessionId":"native-session"}' }));
    if (message.type === 'stream_open') {
      opened += 1;
      native.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId: message.streamId }));
    }
  });
  const prepare = () => broker.prepareUpgrade(new Request('https://relay.example/v1/sessions/agent/events', { headers: { origin: 'https://relay.example' } }));
  await Promise.all(Array.from({ length: 129 }, prepare));
  const preparations = await Promise.all(Array.from({ length: 129 }, prepare));
  const browsers = preparations.map(preparation => {
    if (!preparation || preparation instanceof Response) throw new Error('Unaccepted preparations consumed stream capacity');
    const pair = transportPair(); preparation.accept(pair.server); return pair;
  });
  await Promise.resolve();
  expect(opened).toBe(128);
  expect(browsers.filter(pair => pair.native.readyState === 1)).toHaveLength(128);
  expect(browsers[128]!.native.closeCode).toBe(1013);
  browsers[0]!.native.close();
  const next = await prepare();
  if (!next || next instanceof Response) throw new Error('Closed stream capacity was not released');
  const replacement = transportPair(); next.accept(replacement.server);
  await Promise.resolve();
  expect(opened).toBe(129);
  expect(replacement.native.readyState).toBe(1);
}, 10_000);

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('waits for a durable quota reservation before native creation and releases the gate before the Host replies', async () => {
  let held: ReturnType<typeof deferred<void>> | undefined;
  const entered = deferred<void>();
  const { broker, native } = await restoredFixture({ ownerSubject: 'alice', onStateChange: () => {
    if (held) { entered.resolve(); return held.promise; }
  } });
  await broker.manageShares('alice', 'host', 'share', 'bob', 'Bob', 1);
  const calls: Array<{ requestId: string }> = [];
  const received = deferred<void>();
  native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'rpc_request') { calls.push(message); received.resolve(); } });
  held = deferred<void>();
  const result = broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host/create', {
    method: 'POST', body: JSON.stringify({ providerId: 'codex', requestId: 'first' }),
  }), { principalSubject: () => 'bob' });
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toHaveLength(0);
  held.resolve(); held = undefined;
  await received.promise;
  await broker.manageShares('alice', 'host', 'share', 'eve', 'Eve', 1);
  expect(broker.canAccessHost('host', 'eve')).toBe(true);
  native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: calls[0]!.requestId,
    status: 200, body: '{"agentId":"new-agent","nativeSessionId":"new-native"}' }));
  expect((await result)?.status).toBe(200);
}, 10_000);

it('fails closed when a quota commit fails without creating a native session', async () => {
  let fail = false; let calls = 0;
  const { broker, native } = await restoredFixture({ ownerSubject: 'alice', onStateChange: async () => {
    if (fail) throw new Error('Storage unavailable');
  } });
  await broker.manageShares('alice', 'host', 'share', 'bob', 'Bob', 1);
  native.onMessage(data => { if (JSON.parse(data).type === 'rpc_request') calls += 1; });
  fail = true;
  const result = await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host/create', {
    method: 'POST', body: JSON.stringify({ providerId: 'codex', requestId: 'first' }),
  }), { principalSubject: () => 'bob' });
  expect(result?.status).toBe(503);
  expect(calls).toBe(0);
  expect(broker.canAccessHost('host', 'bob')).toBe(false);
}, 10_000);

it('never exposes a new share while its commit is pending or after it fails', async () => {
  const held = deferred<void>(); const entered = deferred<void>(); let hold = false;
  const { broker } = await restoredFixture({ ownerSubject: 'alice', onStateChange: () => {
    if (hold) { entered.resolve(); return held.promise; }
  } });
  hold = true;
  const outcome = Promise.resolve(broker.manageShares('alice', 'host', 'share', 'bob', 'Bob', 1)).catch(error => error);
  await entered.promise;
  expect(broker.canAccessHost('host', 'bob')).toBe(false);
  expect(broker.visibleHosts('bob')).toEqual([]);
  held.reject(new Error('Storage unavailable'));
  expect(await outcome).toBeInstanceOf(Error);
  expect(broker.canAccessHost('host', 'bob')).toBe(false);
  expect((await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host/catalog?providerId=codex'),
    { principalSubject: () => 'bob' }))?.status).toBe(503);
}, 10_000);

it('does not publish pending permission changes after the broker closes', async () => {
  const held = deferred<void>(); const entered = deferred<void>(); let hold = false;
  const { broker } = await restoredFixture({ ownerSubject: 'alice', onStateChange: () => {
    if (hold) { entered.resolve(); return held.promise; }
  } });
  hold = true;
  const changing = broker.manageShares('alice', 'host', 'share', 'bob', 'Bob', 1).catch(error => error);
  await entered.promise; broker.close(); held.resolve();
  expect(await changing).toBeInstanceOf(Error);
  expect(broker.snapshot().sharing?.grants).toEqual([]);
}, 10000);

it('does not acknowledge or publish failed asynchronous Host registration', async () => {
  const held = deferred<void>(); const entered = deferred<void>(); const frames: string[] = [];
  const broker = createHostBroker({ origin: 'https://relay.example', ownerSubject: 'alice', durable: true,
    initialState: restoredState, now: () => 10_000, onStateChange: () => { entered.resolve(); return held.promise; } });
  close.push(() => broker.close());
  const prepared = await broker.prepareUpgrade(new Request('https://relay.example/ws/remote-host', { headers: { authorization: 'Bearer arc_fixture' } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host preparation failed');
  const pair = transportPair(); pair.native.onMessage(data => { frames.push(data); }); prepared.accept(pair.server);
  const receiving = Promise.all([...pair.server.messages].map(listener => listener('{"uplinkVersion":2,"type":"register","installationId":"restored-installation","name":"Changed name","providers":[{"providerId":"codex","displayName":"Codex"}]}', false)));
  await entered.promise;
  expect(frames).toEqual([]); expect(broker.visibleHosts('alice')[0]).toMatchObject({ online: false, name: 'Restored Host' });
  held.reject(new Error('Failed durable registration'));
  await receiving;
  expect(frames).toEqual([]); expect(pair.native.readyState).toBe(3); expect(broker.visibleHosts('alice')).toEqual([]);
}, 10000);

it('closes live streams and stops forwarding when a sharing commit fails', async () => {
  let fail = false;
  const initialState: RemoteHostBrokerState = { ...restoredState,
    bindings: restoredState.bindings.map(binding => ({ ...binding, creatorSubject: 'bob' })),
    sharing: { grants: [{ hostId: 'host', subject: 'bob', label: 'Bob', sessionLimit: 1, revoked: false }], reservations: [] } };
  const { broker, native } = await restoredFixture({ ownerSubject: 'alice', initialState, onStateChange: async () => { if (fail) throw new Error('Write failed'); } });
  let streamId = ''; let forwarded = 0; const opened = deferred<void>();
  native.onMessage(data => {
    const message = JSON.parse(data);
    if (message.type === 'rpc_request') native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: '{"agentId":"agent","nativeSessionId":"native-session"}' }));
    if (message.type === 'stream_open') { streamId = message.streamId; native.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId })); opened.resolve(); }
    if (message.type === 'stream_message') forwarded += 1;
  });
  const prepared = await broker.prepareUpgrade(new Request('https://relay.example/v1/sessions/agent/events', { headers: { origin: 'https://relay.example' } }), { principalSubject: () => 'bob' });
  if (!prepared || prepared instanceof Response) throw new Error('Shared stream failed');
  const delivered = deferred<void>();
  const browser = transportPair(); const received: string[] = []; browser.native.onMessage(data => { received.push(data); delivered.resolve(); }); prepared.accept(browser.server);
  await opened.promise; await Promise.resolve();
  native.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId, message: 'before' }));
  await delivered.promise; expect(received).toEqual(['before']);
  fail = true; await expect(broker.manageShares('alice', 'host', 'share', 'eve', 'Eve', 1)).rejects.toThrow();
  expect(browser.native.readyState).toBe(3); expect(broker.canAccessHost('host', 'eve')).toBe(false);
  expect(received).toEqual(['before']); expect(forwarded).toBe(0);
}, 10000);

it('does not restore a creation ledger entry after a concurrent device revocation', async () => {
  const held = deferred<void>(); const entered = deferred<void>(); let hold = true;
  const { broker, native } = await restoredFixture({ ownerSubject: 'alice', durable: true, onStateChange: state => {
    if (hold && state.bindings.some(binding => binding.agentId === 'new-agent')) { hold = false; entered.resolve(); return held.promise; }
  } });
  native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'rpc_request') native.send(JSON.stringify({
    uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: '{"agentId":"new-agent","nativeSessionId":"new-native"}',
  })); });
  const post = (action: string, body: unknown) => broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host/' + action, {
    method: 'POST', body: JSON.stringify(body),
  }), { principalSubject: () => 'alice' });
  const creating = post('create', { providerId: 'codex', requestId: 'new' }); await entered.promise;
  const revoking = post('revoke', {});
  await new Promise(resolve => setTimeout(resolve, 20)); held.resolve();
  expect((await revoking)?.status).toBe(200); await creating;
  expect(broker.snapshot().hosts).toEqual([]); expect(broker.snapshot().bindings).toEqual([]); expect(broker.snapshot().creations).toEqual([]);
}, 10000);

it('purges durable previews atomically when their Host is revoked', async () => {
  const initialState: RemoteHostBrokerState = { ...restoredState, previews: [{ hostId: 'host', pendingRemovals: [], snapshot: {
    epoch: 'controller', revision: 1, registrations: [{ id: 'preview', target: 'http://127.0.0.1:5173', status: 'active', createdAt: 1,
      expiresAt: 20_000, revision: 1, pathMode: 'strip', sources: [{ sessionId: 'session', itemId: 'item' }] }],
  } }] };
  let saved: RemoteHostBrokerState | undefined;
  const { broker } = await restoredFixture({ ownerSubject: 'alice', durable: true, initialState, onStateChange(state) { saved = structuredClone(state); } });
  const response = await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host/revoke', { method: 'POST', body: '{}' }),
    { principalSubject: () => 'alice' });
  expect(response?.status).toBe(200);
  expect(saved?.hosts).toEqual([]); expect(saved?.previews).toEqual([]); expect(broker.snapshot().previews).toEqual([]);
  const { createHostedRelay, emptyRelayState } = await import('./index.js');
  const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'preview-revoke-secret-01234567890123456789' };
  const restored = emptyRelayState(auth);
  restored.tenants.push({ subject: 'alice', namespace: '7c1c385902e0ae7f484f5274fbad49131a97fc0771fac9b71f56d093232f49cd', broker: saved! });
  const runtime = createHostedRelay({ ...auth, storage: { initial: restored, async commit() {} }, scheduler: { schedule() {}, cancel() {} } });
  close.push(() => runtime.close());
  expect((await runtime.fetch(new Request(auth.origin + '/health')))?.status).toBe(200);
}, 10000);

it('binds a temporary credential to only one installation during concurrent registration', async () => {
  const held = deferred<void>(); const entered = deferred<void>(); let commits = 0;
  const initialState = { ...restoredState, hosts: [], bindings: [], keys: restoredState.keys.map(([hash, value]) => [hash, { expires: value.expires }] as RemoteHostBrokerState['keys'][number]) };
  const broker = createHostBroker({ origin: 'https://relay.example', durable: true, initialState, now: () => 10000,
    onStateChange: async () => { if (++commits === 1) { entered.resolve(); await held.promise; } } });
  close.push(() => broker.close());
  const prepare = () => broker.prepareUpgrade(new Request('https://relay.example/ws/remote-host', { headers: { authorization: 'Bearer arc_fixture' } }));
  const first = await prepare(); const second = await prepare();
  if (!first || first instanceof Response || !second || second instanceof Response) throw new Error('Known key rejected');
  const a = transportPair(); const b = transportPair(); first.accept(a.server); second.accept(b.server);
  const registered = deferred<void>(); a.native.onMessage(data => { if (JSON.parse(data).type === 'registered') registered.resolve(); });
  const sendRegister = (pair: ReturnType<typeof transportPair>, installationId: string) => Promise.all([...pair.server.messages].map(listener => listener(JSON.stringify({
    uplinkVersion: 2, type: 'register', installationId, name: installationId, providers: [{ providerId: 'codex', displayName: 'Codex' }],
  }), false)));
  const receivingA = sendRegister(a, 'installation-a'); await entered.promise;
  const receivingB = sendRegister(b, 'installation-b'); held.resolve();
  await Promise.all([receivingA, receivingB, registered.promise]);
  expect(b.native.closeCode).toBe(1008);
  expect(broker.snapshot().hosts.map(host => host.installationId)).toEqual(['installation-a']);
}, 10000);

it.each(['create', 'attach'])('reserves the last binding slot before concurrent native %s and persists a restorable snapshot', async action => {
  const initialState: RemoteHostBrokerState = { ...restoredState, bindings: Array.from({ length: 4095 }, (_, index) => ({
    hostId: 'host', providerId: 'codex', agentId: `saved-agent-${index}`, nativeSessionId: `saved-native-${index}`,
  })) };
  let saved: RemoteHostBrokerState | undefined;
  const { broker, native } = await restoredFixture({ initialState, ownerSubject: 'alice', onStateChange(state) { saved = structuredClone(state); } });
  const calls: Array<{ requestId: string }> = []; const entered = deferred<void>();
  native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'rpc_request') { calls.push(message); entered.resolve(); } });
  const request = (id: string) => broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/host/${action}`, {
    method: 'POST', body: JSON.stringify({ providerId: 'codex', requestId: id, nativeSessionId: `native-${id}` }),
  }), { principalSubject: () => 'alice' });
  const first = request('first'); await entered.promise;
  const second = request('second');
  await new Promise(resolve => setTimeout(resolve, 20));
  const admitted = calls.length;
  for (const [index, call] of calls.entries()) native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: call.requestId,
    status: 200, body: JSON.stringify({ agentId: `new-agent-${index}`, nativeSessionId: index === 0 ? 'native-first' : 'native-second' }) }));
  const responses = await Promise.all([first, second]);
  expect(responses.map(response => response?.status)).toEqual([200, 429]); expect(admitted).toBe(1);
  expect(saved?.bindings).toHaveLength(4096);
  const { createHostedRelay, emptyRelayState } = await import('./index.js');
  const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'capacity-restore-secret-01234567890123456789' };
  const restored = emptyRelayState(auth);
  restored.tenants.push({ subject: 'alice', namespace: '7c1c385902e0ae7f484f5274fbad49131a97fc0771fac9b71f56d093232f49cd', broker: saved! });
  const runtime = createHostedRelay({ ...auth, storage: { initial: restored, async commit() {} }, scheduler: { schedule() {}, cancel() {} } });
  close.push(() => runtime.close());
  expect((await runtime.fetch(new Request(auth.origin + '/health')))?.status).toBe(200);
}, 10000);

it('releases an in-flight binding slot after a native rejection so the denied request can retry', async () => {
  const initialState: RemoteHostBrokerState = { ...restoredState, bindings: Array.from({ length: 4095 }, (_, index) => ({
    hostId: 'host', providerId: 'codex', agentId: `saved-agent-${index}`, nativeSessionId: `saved-native-${index}`,
  })) };
  const { broker, native } = await restoredFixture({ initialState });
  const entered = deferred<void>(); const calls: Array<{ requestId: string }> = [];
  native.onMessage(data => { const message = JSON.parse(data); if (message.type === 'rpc_request') { calls.push(message); entered.resolve(); } });
  const request = (id: string) => broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host/create', {
    method: 'POST', body: JSON.stringify({ providerId: 'codex', requestId: id }),
  }));
  const first = request('first'); await entered.promise;
  const rejected = await request('second'); expect(rejected?.status).toBe(429);
  native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: calls[0]!.requestId, status: 400, body: '{"code":"invalid_request"}' }));
  expect((await first)?.status).toBe(400);
  const retry = request('second');
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toHaveLength(2);
  native.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: calls[1]!.requestId, status: 200,
    body: '{"agentId":"retried-agent","nativeSessionId":"retried-native"}' }));
  expect((await retry)?.status).toBe(200); expect(broker.snapshot().bindings).toHaveLength(4096);
}, 10000);
