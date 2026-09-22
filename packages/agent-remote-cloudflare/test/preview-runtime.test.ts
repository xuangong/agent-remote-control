import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createTunnelPeer, type PreviewRegistration, type TunnelSocket } from '@orchardworks/agent-remote-tunnel';
import { createLoopbackTunnelHandlers } from '@orchardworks/agent-remote-tunnel/node';
import { afterEach, expect, it, vi } from 'vitest';
import { event, fixture, issuer, origin, previewOrigin, send, sign } from './fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function localApplication() {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/module-')) { response.setHeader('content-type', 'text/javascript'); response.end(Buffer.alloc(128 * 1024, 97)); return; }
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(Buffer.from([0, 128, 255, 65]));
      setTimeout(() => response.end('second'), 400);
      return;
    }
    response.end('not found');
  });
  const requireFromHost = createRequire(new URL('../../agent-host/package.json', import.meta.url));
  const { WebSocketServer } = requireFromHost('ws') as any;
  const webSockets = new WebSocketServer({ server, handleProtocols: (protocols: Set<string>) => protocols.has('echo-v1') ? 'echo-v1' : false });
  webSockets.on('connection', (socket: any) => socket.on('message', (data: Buffer, binary: boolean) => socket.send(data, { binary })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of webSockets.clients as Set<any>) socket.terminate();
    await new Promise<void>(resolve => webSockets.close(resolve));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as import('node:net').AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function tunnelSocket(socket: import('miniflare').WebSocket): TunnelSocket {
  return {
    send(data) { socket.send(data); },
    close(code, reason) { if (socket.readyState < 2) socket.close(code, reason); },
    onMessage(listener) {
      const receive = (message: MessageEvent) => listener(typeof message.data === 'string'
        ? message.data
        : new Uint8Array(message.data as ArrayBuffer));
      socket.addEventListener('message', receive);
      return () => socket.removeEventListener('message', receive);
    },
    onClose(listener) {
      const close = (closed: CloseEvent) => listener(closed.code, closed.reason);
      socket.addEventListener('close', close);
      return () => socket.removeEventListener('close', close);
    },
  };
}

function socketMessage(socket: import('miniflare').WebSocket): Promise<{ data: string | Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview WebSocket message deadline exceeded')), 5000);
    socket.addEventListener('message', message => {
      clearTimeout(timer);
      resolve({ data: typeof message.data === 'string' ? message.data : new Uint8Array(message.data as ArrayBuffer) });
    }, { once: true });
  });
}

async function previewFixture(target = 'http://127.0.0.1:4173', ttlMs = 60_000, previewDomain?: string) {
  const f = await fixture({ previewDomain });
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.host(pairing.key);
  let revision = 0;
  let registration: PreviewRegistration | undefined;
  const publish = () => send(host.socket, {
    type: 'preview_snapshot',
    snapshot: { epoch: 'workers-controller', revision, registrations: registration ? [registration] : [] },
  });
  host.socket.addEventListener('message', message => {
    const request = JSON.parse(String(message.data));
    if (request.type !== 'rpc_request') return;
    if (request.path === '/remote/attach') {
      send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: 200,
        body: JSON.stringify({ agentId: 'preview-agent', nativeSessionId: 'preview-native' }) });
      return;
    }
    if (request.path === '/remote/previews') {
      const body = JSON.parse(request.body);
      registration = { id: 'workers-preview', target: body.target, status: 'active', createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs, revision: ++revision, pathMode: body.pathMode, sources: [body.source] };
    } else if (request.path === '/remote/previews/renew' && registration) {
      registration = { ...registration, expiresAt: Date.now() + ttlMs, revision: ++revision };
    } else if (request.path === '/remote/previews/unregister' && registration) {
      registration = { ...registration, status: 'unregistered', revision: ++revision };
    } else return;
    send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: 200,
      body: JSON.stringify({ registration }) });
    publish();
  });
  const attached = await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/attach`, alice.cookie,
    { providerId: 'codex', nativeSessionId: 'preview-native' });
  expect(attached.status, await attached.clone().text()).toBe(200);
  const created = await f.json(alice.basePath + 'v1/sessions/preview-agent/previews', alice.cookie,
    { target, itemId: 'preview-item' });
  expect(created.status, await created.clone().text()).toBe(200);
  registration = (await created.json() as { registration: PreviewRegistration }).registration;
  const dataSocket = await f.upgrade('/ws/preview-tunnel', { authorization: `Bearer ${host.tunnelToken}` });
  return { f, alice, host, dataSocket, get registration() { return registration!; } };
}

async function previewCookie(setup: Awaited<ReturnType<typeof previewFixture>>, path: string) {
  const opened = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews/${setup.registration.id}/open`,
    setup.alice.cookie, { url: setup.registration.target + path });
  expect(opened.status, await opened.clone().text()).toBe(200);
  const { entryUrl } = await opened.json() as { entryUrl: string };
  const entered = await setup.f.previewRequest('/_arc/enter', { method: 'POST', headers: { cookie: setup.alice.cookie, origin: previewOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: new URL(entryUrl).hash.slice(1) }) });
  expect(entered.status).toBe(200);
  return entered.headers.get('set-cookie')!.split(';')[0]! + '; ' + setup.alice.cookie;
}

it('streams binary HTTP through real Miniflare control and preview uplinks and rejects unauthenticated access', async () => {
  const target = await localApplication();
  const setup = await previewFixture(target);
  expect((await setup.f.request('/ws/preview-tunnel', { headers: { upgrade: 'websocket', authorization: 'Bearer invalid' } })).status).toBe(401);
  const cookie = await previewCookie(setup, '/events');
  const path = `/p/${setup.registration.id}/events`;
  expect((await setup.f.previewRequest(path)).status).toBe(401);

  createTunnelPeer(tunnelSocket(setup.dataSocket), createLoopbackTunnelHandlers({
    lookup: id => id === setup.registration.id ? { target, pathMode: 'strip' } : undefined,
  }));
  const started = Date.now();
  const response = await setup.f.previewRequest(path, { headers: { cookie } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect([...first.value!]).toEqual([0, 128, 255, 65]);
  expect(Date.now() - started).toBeLessThan(350);
  const second = await reader.read();
  expect(new TextDecoder().decode(second.value)).toBe('second');
  await reader.cancel();
}, 20_000);

it('negotiates protocol, transports text and binary, and propagates preview revocation over Miniflare WebSockets', async () => {
  const target = await localApplication();
  const setup = await previewFixture(target);
  const cookie = await previewCookie(setup, '/socket');
  createTunnelPeer(tunnelSocket(setup.dataSocket), createLoopbackTunnelHandlers({
    lookup: id => id === setup.registration.id ? { target, pathMode: 'strip' } : undefined,
  }));
  const upgraded = await setup.f.upgradeResponse(`/p/${setup.registration.id}/socket`, {
    cookie, origin: previewOrigin, 'sec-websocket-protocol': 'echo-v1',
  }, previewOrigin);
  const { socket } = upgraded;
  expect(upgraded.response.headers.get('sec-websocket-protocol')).toBe('echo-v1');
  let received = socketMessage(socket); socket.send('hello');
  expect((await received).data).toBe('hello');
  received = socketMessage(socket); socket.send(new Uint8Array([0, 255, 128]));
  expect([...(await received).data as Uint8Array]).toEqual([0, 255, 128]);
  const previousExpiry = setup.registration.expiresAt;
  const renewed = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews/${setup.registration.id}/renew`, setup.alice.cookie, {});
  expect(renewed.status).toBe(200);
  expect((await renewed.json() as any).registration.expiresAt).toBeGreaterThan(previousExpiry);
  const cookieRenewed = await setup.f.previewRequest(`/p/${setup.registration.id}/_arc/renew`, { method: 'POST',
    headers: { cookie, origin: previewOrigin, 'content-type': 'application/json' }, body: '{}' });
  expect(cookieRenewed.status).toBe(200);
  expect(cookieRenewed.headers.get('set-cookie')).toContain(cookie.split(';')[0]!);
  received = socketMessage(socket); socket.send('still connected');
  expect((await received).data).toBe('still connected');
  const closed = event(socket, 'close');
  const removed = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews/${setup.registration.id}/unregister`, setup.alice.cookie, {});
  expect(removed.status).toBe(200);
  expect((await closed).code).toBe(1008);
}, 20_000);

it('persists preview snapshots and pending unregister intent across Durable Object replacement', async () => {
  const setup = await previewFixture();
  const saved = structuredClone(setup.registration);
  await vi.waitFor(async () => {
    const response = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`, setup.alice.cookie);
    expect((await response.json() as any).registrations[0]?.id).toBe(saved.id);
  }, { timeout: 5000 });
  await setup.f.restart();
  let previews = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`, setup.alice.cookie);
  expect(previews.status).toBe(200);
  expect((await previews.json() as any).registrations[0]).toMatchObject({ id: saved.id, availability: 'controller_offline' });

  const pending = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews/${saved.id}/unregister`, setup.alice.cookie, {});
  expect(pending.status).toBe(200);
  await setup.f.restart();
  previews = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`, setup.alice.cookie);
  expect((await previews.json() as any).registrations[0]).toMatchObject({ id: saved.id, pendingUnregister: true });

  const reconnected = await setup.f.host(setup.host.key);
  const removal = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Pending preview unregister was not reconciled')), 5000);
    reconnected.socket.addEventListener('message', message => {
      const request = JSON.parse(String(message.data));
      if (request.type !== 'rpc_request' || request.path !== '/remote/previews/unregister') return;
      clearTimeout(timer);
      send(reconnected.socket, { type: 'rpc_response', requestId: request.requestId, status: 200,
        body: JSON.stringify({ registration: { ...saved, status: 'unregistered', revision: saved.revision + 2 } }) });
      resolve();
    });
  });
  send(reconnected.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: saved.revision + 1, registrations: [{ ...saved, revision: saved.revision + 1 }],
  } });
  await removal;
  await setup.f.upgrade('/ws/preview-tunnel', { authorization: `Bearer ${reconnected.tunnelToken}` });
  const reopened = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews/${saved.id}/open`, setup.alice.cookie,
    { url: saved.target + '/bytes' });
  expect(reopened.status).toBe(503);
}, 20_000);


it('keeps a pinned name after history pruning and durable restart with a new Controller registration', async () => {
  const setup = await previewFixture('http://127.0.0.1:4173/docs', 60_000, 'preview.example.test');
  const path = setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`;
  const snapshot = async () => (await (await setup.f.json(path, setup.alice.cookie)).json() as any);
  const original = (await snapshot()).registrations[0];
  expect(original.tunnelOrigin).toMatch(/^https:\/\//);
  expect((await setup.f.json(`${path}/${original.id}/pin`, setup.alice.cookie, { pinned: true })).status).toBe(200);
  send(setup.host.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: setup.registration.revision + 1, registrations: [],
  } });
  await vi.waitFor(async () => expect((await snapshot()).registrations).toEqual([]), { timeout: 5000 });
  await setup.f.restart();
  const reconnected = await setup.f.host(setup.host.key);
  send(reconnected.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'restarted-controller', revision: 1, registrations: [{ ...setup.registration,
      id: 'new-controller-preview', target: 'http://localhost:4173/another-path', revision: 1 }],
  } });
  await vi.waitFor(async () => expect((await snapshot()).registrations).toEqual([
    expect.objectContaining({ id: 'new-controller-preview', tunnelOrigin: original.tunnelOrigin, tunnelNamePinned: true }),
  ]), { timeout: 5000 });
}, 20_000);

it('persists owner unpin of an inactive name while the Controller stays disconnected', async () => {
  const setup = await previewFixture('http://127.0.0.1:4173', 60_000, 'preview.example.test');
  const path = setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`;
  const snapshot = async () => await (await setup.f.json(path, setup.alice.cookie)).json() as any;
  const original = (await snapshot()).registrations[0];
  expect((await setup.f.json(`${path}/${original.id}/pin`, setup.alice.cookie, { pinned: true })).status).toBe(200);
  send(setup.host.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: setup.registration.revision + 1, registrations: [],
  } });
  await vi.waitFor(async () => expect((await snapshot()).registrations).toEqual([]), { timeout: 5000 });
  await setup.f.restart();
  expect((await snapshot()).pinnedNames).toEqual([{ nameId: original.id, target: original.target, tunnelOrigin: original.tunnelOrigin }]);
  expect((await setup.f.json(`${path}/pins/${original.id}/unpin`, setup.alice.cookie, {})).status).toBe(200);
  expect((await snapshot()).pinnedNames).toEqual([]);
  await setup.f.restart();
  expect((await snapshot()).pinnedNames).toEqual([]);
  const reconnected = await setup.f.host(setup.host.key);
  send(reconnected.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'restarted-controller', revision: 1, registrations: [{ ...setup.registration, id: 'fresh-preview', revision: 1 }],
  } });
  await vi.waitFor(async () => {
    const next = (await snapshot()).registrations[0];
    expect(next?.id).toBe('fresh-preview');
    expect(next?.tunnelNamePinned).toBe(false);
    expect(next?.tunnelOrigin).toBeTruthy();
    expect(next?.tunnelOrigin).not.toBe(original.tunnelOrigin);
  }, { timeout: 5000 });
}, 20_000);

it('returns only active previews from mixed Controller history, including after durable recovery', async () => {
  const setup = await previewFixture();
  const active = setup.registration;
  send(setup.host.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: active.revision + 1,
    registrations: [active, { ...active, id: 'expired-preview', status: 'expired' },
      { ...active, id: 'removed-preview', status: 'unregistered' }],
  } });
  const path = setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`;
  await vi.waitFor(async () => {
    const response = await setup.f.json(path, setup.alice.cookie);
    expect(response.status).toBe(200);
    const snapshot = await response.json() as any;
    expect(snapshot.revision).toBe(active.revision + 1);
    expect(snapshot.registrations).toEqual([expect.objectContaining({ id: active.id, status: 'active' })]);
  }, { timeout: 5000 });
  await setup.f.restart();
  const restored = await setup.f.json(path, setup.alice.cookie);
  expect((await restored.json() as any).registrations).toEqual([
    expect.objectContaining({ id: active.id, status: 'active', availability: 'controller_offline' }),
  ]);
  expect((await setup.f.json(path + '/removed-preview/renew', setup.alice.cookie, {})).status).toBe(409);
}, 20_000);

it.each(['http', 'websocket'] as const)('renews Miniflare previews from %s traffic without browser keepalives', async mode => {
  const target = await localApplication();
  const setup = await previewFixture(target, 2000);
  const originalExpiry = setup.registration.expiresAt;
  const cookie = await previewCookie(setup, '/events');
  createTunnelPeer(tunnelSocket(setup.dataSocket), createLoopbackTunnelHandlers({ lookup: () => ({ target, pathMode: 'strip' }) }));
  const path = '/p/' + setup.registration.id;
  if (mode === 'http') {
    while (Date.now() < originalExpiry + 700) {
      const response = await setup.f.previewRequest(path + '/events', { headers: { cookie } });
      expect(response.status).toBe(200); await response.arrayBuffer();
    }
  } else {
    const { socket } = await setup.f.upgradeResponse(path + '/socket', { cookie, origin: previewOrigin, 'sec-websocket-protocol': 'echo-v1' }, previewOrigin);
    while (Date.now() < originalExpiry + 700) {
      const received = socketMessage(socket); socket.send('activity'); expect((await received).data).toBe('activity');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    socket.close();
  }
  expect(setup.registration.expiresAt).toBeGreaterThan(originalExpiry + 700);
  await vi.waitFor(async () => expect((await setup.f.previewRequest(path + '/events')).status).toBe(401));
  await new Promise(resolve => setTimeout(resolve, 3000));
  expect((await setup.f.previewRequest(path + '/events', { headers: { cookie } })).status).toBe(401);
}, 20000);


it('routes copied tunnel navigation through login and current ownership before issuing a browser-bound handoff', async () => {
  const setup = await previewFixture();
  const path = setup.alice.basePath + 'v1/remote/hosts/' + setup.host.hostId + '/previews/' + setup.registration.id + '/open';
  const copied = await setup.f.json(path, setup.alice.cookie, { url: setup.registration.target + '/docs?q=1#section', mode: 'link' });
  expect(copied.status).toBe(200);
  const { tunnelUrl } = await copied.json() as { tunnelUrl: string };
  const url = new URL(tunnelUrl);
  const target = url.pathname + url.search;
  const signedOut = await setup.f.request(target);
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get('location')).toBe('/auth/login' + url.search);
  const login = await setup.f.request(signedOut.headers.get('location')!);
  expect(login.status).toBe(303);
  const nonce = new URL(login.headers.get('location')!).searchParams.get('challenge');
  const iat = Math.floor(Date.now() / 1000);
  const ticket = sign('arc-relay+jwt', { iss: issuer, aud: origin, sub: 'alice', nonce, iat, exp: iat + 900, jti: crypto.randomUUID(), continuation: 'alice', sessionExpiresAt: Date.now() + 3_600_000 });
  const signedIn = await setup.f.json('/auth/session', login.headers.get('set-cookie')!.split(';')[0]!, { ticket });
  expect(signedIn.status).toBe(200);
  expect((await signedIn.json() as { returnPath: string }).returnPath).toBe(target);
  const bob = await setup.f.login('bob');
  expect((await setup.f.request(target, { headers: { cookie: bob.cookie } })).status).toBe(403);
  const allowed = await setup.f.request(target, { headers: { cookie: setup.alice.cookie } });
  expect(allowed.status).toBe(303);
  const code = new URL(allowed.headers.get('location')!).hash.slice(1);
  const redeem = (cookie = '') => setup.f.previewRequest('/_arc/enter', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  expect((await redeem()).status).toBe(401);
  expect((await redeem(bob.cookie)).status).toBe(401);
  const response = await redeem(setup.alice.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: '/p/' + setup.registration.id + '/docs?q=1#section' });
}, 20000);


it('routes isolated preview origins through the Worker and redeems control-authorized browser proofs', async () => {
  const target = await localApplication();
  const setup = await previewFixture(target, 60_000, 'preview.test');
  const { f, alice, host, registration } = setup;
  createTunnelPeer(tunnelSocket(setup.dataSocket), createLoopbackTunnelHandlers({ lookup: id => id === registration.id ? { target, pathMode: 'strip' } : undefined }));
  const policy = (await f.request('/')).headers.get('content-security-policy');
  expect(policy).toContain("connect-src 'self' https://*.preview.test");
  expect(policy).toContain("frame-src 'self' https://*.preview.test");
  const link = await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/previews/${registration.id}/open`, alice.cookie, { url: target + '/events', mode: 'link' });
  const tunnel = new URL((await link.json() as { tunnelUrl: string }).tunnelUrl);
  expect(tunnel.hostname).toMatch(/^[a-z]+-[a-z]+-[a-f0-9]{12}\.preview\.test$/);
  expect(tunnel.pathname).toBe('/events');
  expect((await f.requestAt(tunnel.origin, '/events')).status).toBe(401);
  const challenge = await f.requestAt(tunnel.origin, '/_arc/challenge', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/events' }) });
  expect(challenge.status).toBe(200); expect(challenge.headers.get('access-control-allow-origin')).toBe(origin);
  const cookie = challenge.headers.get('set-cookie')!.split(';')[0]!;
  const id = (await challenge.json() as { challenge: string }).challenge;
  const approval = await f.json('/_arc/preview-authorize', alice.cookie, { challenge: id });
  expect(approval.status).toBe(200);
  const code = (await approval.json() as { code: string }).code;
  const entered = await f.requestAt(tunnel.origin, '/_arc/enter', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  expect(entered.status).toBe(200);
  const session = entered.headers.get('set-cookie')!.split(';')[0]!;
  const response = await f.requestAt(tunnel.origin, '/events', { headers: { cookie: session } });
  expect(response.status).toBe(200); const reader = response.body!.getReader();
  expect([...((await reader.read()).value!)]).toEqual([0, 128, 255, 65]); await reader.cancel();
  const modules = await Promise.all(Array.from({ length: 128 }, async (_, index) => {
    const module = await f.requestAt(tunnel.origin, `/module-${index}.js`, { headers: { cookie: session } });
    return { status: module.status, bytes: (await module.arrayBuffer()).byteLength };
  }));
  expect(modules).toEqual(Array.from({ length: 128 }, () => ({ status: 200, bytes: 128 * 1024 })));
  expect((await f.requestAt('https://unexpected.preview.test', '/')).status).toBe(403);
}, 20000);
