// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { HttpWebSocketTransport } from './http-websocket-transport.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
function replay(): SessionSuccessionReplay {
  const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: ref('A') };
  return { version: 1, from: { hostId: 'host', providerId: 'fixture', nativeSessionId: 'A' }, to: { hostId: 'host', providerId: 'fixture', nativeSessionId: 'B' },
    projection: { version: 1, role: { id: 'role', revision: 2, origin: ref('A'), current: ref('B'), workspace }, receipt: { ...request, to: ref('B'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: ref('B'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } } };
}
async function fixture(enabled = true, advertise = true) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const sockets: WebSocket[] = [], urls: string[] = [], requests: any[] = [], responses: any[] = [];
  server.on('connection', (socket, request) => { sockets.push(socket); urls.push(request.url!); socket.on('message', data => requests.push(JSON.parse(String(data))));
    socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'ready', ...(advertise ? { successions: 1 } : {}) })); });
  const address = server.address() as { port: number };
  const transport = new HttpWebSocketTransport(`http://127.0.0.1:${address.port}/`, { sessionChannels: true, sessionSuccessions: enabled, WebSocket });
  cleanups.push(() => new Promise<void>(resolve => { transport.dispose(); for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  const connect = () => {
    const connection = transport.connect('session', { onOpen() { connection.send({ protocolVersion: '1.8.0', type: 'negotiate' }); }, onMessage(message) { responses.push(message); }, onDisconnect() {} });
    return connection;
  };
  connect();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  return { transport, sockets, urls, requests, responses, connect };
}
test('opts in explicitly, delivers exact duplicates once and replays immutable evidence to late subscribers', async () => {
  const f = await fixture(); expect(f.urls[0]).toContain('&successions=1'); expect(f.transport.sessionSuccessionSupport).toBe('supported');
  const received = vi.fn(); f.transport.onSessionSuccession(received); const succession = replay();
  for (let i = 0; i < 2; i++) f.sockets[0]!.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_succession_committed', succession }));
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  received.mock.calls[0]![0].to.nativeSessionId = 'mutated';
  const late = vi.fn(); f.transport.onSessionSuccession(late); expect(late).toHaveBeenCalledWith(succession);
  const diagnostic = vi.fn(); f.transport.onDiagnostic(diagnostic);
  const changed = replay(); changed.projection.receipt.updatedAt = 'changed';
  f.sockets[0]!.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_succession_committed', succession: changed }));
  await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'succession_replay_conflict' })));
  expect(received).toHaveBeenCalledOnce();
}, 10000);
test('keeps default off and treats an old ready as unsupported while ordinary channel subscriptions work', async () => {
  const disabled = await fixture(false, false); expect(disabled.urls[0]).not.toContain('successions'); expect(disabled.transport.sessionSuccessionSupport).toBe('disabled');
  const old = await fixture(true, false); expect(old.transport.sessionSuccessionSupport).toBe('unsupported'); expect(old.requests[0].type).toBe('subscribe');
  const receive = vi.fn(); old.transport.onSessionSuccession(receive); const diagnostics = vi.fn(); old.transport.onDiagnostic(diagnostics);
  old.sockets[0]!.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_succession_committed', succession: replay() }));
  await vi.waitFor(() => expect(diagnostics).toHaveBeenCalled()); expect(receive).not.toHaveBeenCalled();
}, 10000);
test('validates explicit HTTP replay and current lookup without creating a native binding', async () => {
  const requests: string[] = []; let malformed = false;
  const succession = replay();
  const transport = new HttpWebSocketTransport('https://relay.example/u/tenant/', { fetch: vi.fn(async (url) => {
    requests.push(String(url)); const value = String(url).includes('/current?') ? { version: 1, role: succession.projection.role, locator: succession.to }
      : String(url).includes('/operation?') ? succession : { version: 1, successions: [succession], nextCursor: null };
    return new Response(JSON.stringify(malformed ? { ...value, forged: true } : value));
  }) as typeof fetch });
  const page = await transport.fetchSessionSuccessions({ roleId: 'role', limit: 1 }); expect(page.successions[0]!.to).not.toHaveProperty('agentId');
  expect((await transport.fetchSessionSuccessionOperation('role', 'op')).projection.role.revision).toBe(2);
  expect((await transport.fetchSessionSuccessionCurrent('role')).locator.nativeSessionId).toBe('B');
  expect(requests).toHaveLength(3); expect(requests.every(url => url.includes('/v1/session-successions'))).toBe(true);
  malformed = true; await expect(transport.fetchSessionSuccessions()).rejects.toThrow(/invalid/);
}, 10000);

test('rejects succession before ready and semantically malformed locators without delivery', () => {
  for (const beforeReady of [true, false]) {
    const socket = { readyState: 1, onopen: null as any, onmessage: null as any, onclose: null as any, onerror: null as any, send() {}, close() {} };
    const transport = new HttpWebSocketTransport('https://relay.example/', { sessionChannels: true, sessionSuccessions: true, webSocketFactory: () => socket }); cleanups.push(() => transport.dispose());
    const received = vi.fn(); transport.onSessionSuccession(received); const diagnostics = vi.fn(); transport.onDiagnostic(diagnostics);
    transport.connect('session', { onOpen() {}, onMessage() {}, onDisconnect() {} }).send({ protocolVersion: '1.8.0', type: 'negotiate' });
    if (!beforeReady) socket.onmessage({ data: JSON.stringify({ protocolVersion: '1.8.0', type: 'ready', successions: 1 }) });
    const succession = replay(); if (!beforeReady) succession.to.nativeSessionId = 'forged';
    socket.onmessage({ data: JSON.stringify({ protocolVersion: '1.8.0', type: 'session_succession_committed', succession }) });
    expect(received).not.toHaveBeenCalled(); expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_wire_body' }));
  }
}, 10000);

test('retires succession replay and listeners on actual transport disposal, preserving active reconnect replay', async () => {
  const f = await fixture(); const received = vi.fn(); f.transport.onSessionSuccession(received); const succession = replay();
  f.sockets[0]!.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_succession_committed', succession }));
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  f.sockets[0]!.terminate(); await vi.waitFor(() => expect(f.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
  f.connect(); await vi.waitFor(() => expect(f.requests).toHaveLength(2));
  f.sockets[1]!.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_succession_committed', succession }));
  f.sockets[1]!.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'message', subscriptionId: f.requests[1].subscriptionId, message: { protocolVersion: '1.8.0', type: 'protocol_error', payload: { code: 'fixture', message: 'After replay', recoverable: false } } }));
  await vi.waitFor(() => expect(f.responses).toHaveLength(1));
  const activeLate = vi.fn(); f.transport.onSessionSuccession(activeLate); expect(activeLate).toHaveBeenCalledWith(succession);
  f.transport.dispose(); expect(f.transport.sessionSuccessionSupport).toBe('disabled');
  const retiredLate = vi.fn(); const remove = f.transport.onSessionSuccession(retiredLate); remove();
  expect(retiredLate).not.toHaveBeenCalled(); expect(received).toHaveBeenCalledOnce();
  expect((f.transport as any).successions.size).toBe(0); expect((f.transport as any).successionListeners.size).toBe(0); expect((f.transport as any).successionBytes).toBe(0);
  f.transport.dispose(); expect(f.transport.sessionSuccessionSupport).toBe('disabled');
}, 10000);
test('cannot repopulate retired succession scope from late HTTP or captured channel callbacks', async () => {
  let finish!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { finish = resolve; });
  const sockets: any[] = [];
  const transport = new HttpWebSocketTransport('https://relay.example/', { sessionChannels: true, sessionSuccessions: true, fetch: vi.fn(() => held) as typeof fetch,
    webSocketFactory: () => { const socket = { readyState: 1, onopen: null as any, onmessage: null as any, onclose: null as any, onerror: null as any, send() {}, close() {} }; sockets.push(socket); return socket; } });
  cleanups.push(() => transport.dispose());
  const received = vi.fn(); transport.onSessionSuccession(received);
  transport.connect('session', { onOpen() {}, onMessage() {}, onDisconnect() {} }).send({ protocolVersion: '1.8.0', type: 'negotiate' });
  const deliver = sockets[0].onmessage;
  const pending = transport.fetchSessionSuccessions(); transport.dispose();
  finish(new Response(JSON.stringify({ version: 1, successions: [replay()], nextCursor: null }))); await pending;
  deliver({ data: JSON.stringify({ protocolVersion: '1.8.0', type: 'ready', successions: 1 }) });
  deliver({ data: JSON.stringify({ protocolVersion: '1.8.0', type: 'session_succession_committed', succession: replay() }) });
  const late = vi.fn(); transport.onSessionSuccession(late); expect(received).not.toHaveBeenCalled(); expect(late).not.toHaveBeenCalled();
  expect(transport.sessionSuccessionSupport).toBe('disabled'); expect((transport as any).successionListeners.size).toBe(0);
}, 10000);
