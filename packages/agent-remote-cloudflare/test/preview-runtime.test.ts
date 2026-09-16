import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createTunnelPeer, type PreviewRegistration, type TunnelSocket } from '@agent-remote-controller/agent-remote-tunnel';
import { createLoopbackTunnelHandlers } from '@agent-remote-controller/agent-remote-tunnel/node';
import { afterEach, expect, it, vi } from 'vitest';
import { event, fixture, origin, previewOrigin, send } from './fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function localApplication() {
  const server = createServer((request, response) => {
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
    close(code, reason) { socket.close(code, reason); },
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

async function previewFixture(target = 'http://127.0.0.1:4173') {
  const f = await fixture();
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
        expiresAt: Date.now() + 60_000, revision: ++revision, pathMode: body.pathMode, sources: [body.source] };
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
  const entered = await setup.f.previewRequest('/_arc/enter', { method: 'POST', headers: { origin: previewOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: new URL(entryUrl).hash.slice(1) }) });
  expect(entered.status).toBe(200);
  return entered.headers.get('set-cookie')!.split(';')[0]!;
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
