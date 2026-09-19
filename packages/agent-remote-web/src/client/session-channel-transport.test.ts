// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, HistoryPage } from '@agent-remote-controller/agent-remote-protocol';
import { HttpWebSocketTransport, type WebSocketLike } from './http-websocket-transport.js';
import type { RemoteConnection, RemoteServerMessage } from './transport.js';
import { AgentReplica } from '../replica/store.js';
import { RemoteSessionClient } from './remote-session-client.js';

const version = '1.5.0';
const negotiate: ClientMessage = { protocolVersion: version, type: 'negotiate' };
const response: RemoteServerMessage = {
  protocolVersion: version, type: 'protocol_error',
  payload: { code: 'session_not_found', message: 'Session unavailable.', recoverable: false },
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function server(ready = true, fetchImplementation?: typeof fetch) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const sockets: WebSocket[] = [];
  const urls: string[] = [];
  const frames: { socket: WebSocket; frame: any }[] = [];
  wss.on('connection', (socket, request) => {
    sockets.push(socket);
    urls.push(request.url!);
    socket.on('message', (data) => frames.push({ socket, frame: JSON.parse(String(data)) }));
    if (ready && request.url!.includes('session-channel')) socket.send(JSON.stringify({ protocolVersion: version, type: 'ready' }));
  });
  cleanups.push(() => new Promise<void>((resolve) => { for (const socket of wss.clients) socket.terminate(); wss.close(() => resolve()); }));
  const address = wss.address();
  if (typeof address !== 'object' || !address) throw new Error('Missing address');
  const transport = new HttpWebSocketTransport(`http://127.0.0.1:${address.port}/base/`, { WebSocket, sessionChannels: true, fetch: fetchImplementation });
  cleanups.push(() => transport.dispose?.());
  return { transport, sockets, urls, frames };
}

function connect(transport: HttpWebSocketTransport, agentId: string, activity = false) {
  const messages: RemoteServerMessage[] = [];
  const disconnect = vi.fn();
  const opened = vi.fn(() => connection.send(activity ? { ...negotiate, observation: 'activity' } : negotiate));
  const connection: RemoteConnection = transport.connect(agentId, {
    onOpen: opened, onMessage: (message) => messages.push(message), onDisconnect: disconnect,
  });
  return { connection, messages, disconnect, opened };
}

describe('session channel transport', () => {
  it('assigns increasing wire identities when clients negotiate out of connect order', async () => {
    const harness = await server();
    const a = harness.transport.connect('a', { onOpen() {}, onMessage() {}, onDisconnect() {} });
    connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    a.send(negotiate);
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    expect(harness.frames.map(({ frame }) => frame.agentId)).toEqual(['b', 'a']);
    expect(harness.frames[1]!.frame.subscriptionId).toBeGreaterThan(harness.frames[0]!.frame.subscriptionId);
  }, 10_000);

  it('shares one session channel across switches and siblings, separating activity', async () => {
    const harness = await server();
    const a = connect(harness.transport, 'a');
    const b = connect(harness.transport, 'b');
    const activity = connect(harness.transport, 'a', true);
    await vi.waitFor(() => expect(harness.frames).toHaveLength(3));
    expect(harness.urls.sort()).toEqual(['/base/v1/session-channel?observation=activity', '/base/v1/session-channel?observation=session']);
    const subscriptions = harness.frames.map(({ frame }) => frame);
    expect(subscriptions.map((frame) => frame.type)).toEqual(['subscribe', 'subscribe', 'subscribe']);
    const firstId = subscriptions.find((frame) => frame.agentId === 'a' && !frame.message.observation).subscriptionId;
    a.connection.close();
    const c = connect(harness.transport, 'c');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(5));
    expect(harness.sockets).toHaveLength(2);
    const session = harness.frames.find(({ frame }) => frame.subscriptionId === firstId)!.socket;
    session.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: firstId, message: response }));
    const cId = harness.frames.find(({ frame }) => frame.agentId === 'c')!.frame.subscriptionId;
    expect(cId).toBeGreaterThan(firstId);
    session.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: cId, message: response }));
    await vi.waitFor(() => expect(c.messages).toEqual([response]));
    expect(a.messages).toEqual([]);
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(activity.disconnect).not.toHaveBeenCalled();
    b.connection.close(); c.connection.close(); activity.connection.close();
    harness.transport.dispose();
    await vi.waitFor(() => expect(harness.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true));
  }, 10_000);

  it('waits for ready, drops closed pending subscriptions, and routes per-subscription closure', async () => {
    const harness = await server(false);
    const a = connect(harness.transport, 'a');
    const b = connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    expect(harness.frames).toEqual([]);
    a.connection.close();
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'ready' }));
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    expect(harness.frames[0]!.frame.agentId).toBe('b');
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'closed', subscriptionId: harness.frames[0]!.frame.subscriptionId, code: 4404, reason: 'Missing' }));
    await vi.waitFor(() => expect(b.disconnect).toHaveBeenCalledTimes(1));
    expect(a.disconnect).not.toHaveBeenCalled();
  }, 10_000);

  it('notifies each logical client once and creates a fresh channel without replay after ready', async () => {
    const harness = await server();
    const a = connect(harness.transport, 'a');
    const b = connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    a.connection.send({ protocolVersion: version, type: 'cancel', payload: { requestId: 'cancel', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'a' } });
    await vi.waitFor(() => expect(harness.frames).toHaveLength(3));
    harness.sockets[0]!.terminate();
    await vi.waitFor(() => { expect(a.disconnect).toHaveBeenCalledTimes(1); expect(b.disconnect).toHaveBeenCalledTimes(1); });
    expect(() => a.connection.send(negotiate)).toThrow();
    connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(4));
    expect(harness.urls).toEqual(['/base/v1/session-channel?observation=session', '/base/v1/session-channel?observation=session']);
    expect(harness.frames.filter(({ frame }) => frame.type === 'message')).toHaveLength(1);
  }, 10_000);

  it('falls back before ready only once without duplicate opens or negotiation', async () => {
    const harness = await server(false);
    const a = connect(harness.transport, 'agent one');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    harness.sockets[0]!.close();
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    expect(harness.urls).toEqual(['/base/v1/session-channel?observation=session', '/base/v1/sessions/agent%20one/events']);
    expect(harness.frames[0]!.frame).toEqual(negotiate);
    expect(a.opened).toHaveBeenCalledTimes(1);
    expect(a.disconnect).not.toHaveBeenCalled();
    a.connection.close();
    connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    expect(harness.urls[2]).toBe('/base/v1/sessions/b/events');
  }, 10_000);

  it('reuses an idle channel and keeps protocol observations scoped to validated nested messages', async () => {
    const harness = await server();
    const observed: unknown[] = [];
    harness.transport.onProtocolMessage((message) => observed.push(message));
    const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    a.connection.close();
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    const b = connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(3));
    expect(harness.sockets).toHaveLength(1);
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: harness.frames[2]!.frame.subscriptionId, message: response }));
    await vi.waitFor(() => expect(b.messages).toEqual([response]));
    expect(observed).toEqual([
      { direction: 'outbound', channel: 'websocket', message: negotiate },
      { direction: 'outbound', channel: 'websocket', message: negotiate },
      { direction: 'inbound', channel: 'websocket', message: response },
    ]);
  }, 10_000);

  it('retires both channels on browser resume and removes resume listeners on dispose', async () => {
    const browserWindow = new EventTarget();
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    cleanups.push(() => vi.unstubAllGlobals());
    const harness = await server();
    const a = connect(harness.transport, 'a');
    const activity = connect(harness.transport, 'a', true);
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    browserWindow.dispatchEvent(new Event('online'));
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(activity.disconnect).toHaveBeenCalledTimes(1);
    connect(harness.transport, 'a');
    connect(harness.transport, 'a', true);
    await vi.waitFor(() => expect(harness.frames).toHaveLength(4));
    expect(harness.sockets).toHaveLength(4);
    harness.transport.dispose();
    browserWindow.dispatchEvent(new Event('online'));
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(() => connect(harness.transport, 'disposed')).toThrow('disposed');
  }, 10_000);

  it('bounds pending commands and never sends a canceled pending stream after ready', async () => {
    const harness = await server(false);
    const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    const command: ClientMessage = { protocolVersion: version, type: 'cancel', payload: {
      requestId: 'cancel', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'a',
    } };
    expect(() => { for (let index = 0; index < 1024; index++) a.connection.send(command); }).toThrow('limit');
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'ready' }));
    const b = connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    expect(harness.frames[0]!.frame.agentId).toBe('b');
    expect(b.disconnect).not.toHaveBeenCalled();
  }, 10_000);

  it('rejects malformed inbound frames after ready without falling back or delivering them', async () => {
    const harness = await server();
    const diagnostics: unknown[] = [];
    harness.transport.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: 1, message: { type: 'garbage' } }));
    await vi.waitFor(() => expect(a.disconnect).toHaveBeenCalledTimes(1));
    expect(a.messages).toEqual([]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'invalid_wire_body' })]);
    connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    expect(harness.urls.every((url) => url.includes('session-channel'))).toBe(true);
  }, 10_000);

  it('accepts valid nested responses larger than one MiB within the public frame limit', async () => {
    const harness = await server();
    const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    const largeResponse = { ...response, payload: { ...response.payload, message: 'x'.repeat(1100 * 1024) } };
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: harness.frames[0]!.frame.subscriptionId, message: largeResponse }));
    await vi.waitFor(() => expect(a.messages).toHaveLength(1));
    expect(a.messages[0]).toEqual(largeResponse);
    expect(a.disconnect).not.toHaveBeenCalled();
  }, 10_000);

  it('detects silent dead channels through ping timeout and cancels all health work on dispose', async () => {
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    const sockets: ControlledSocket[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => {
      const socket = new ControlledSocket(); sockets.push(socket); return socket;
    } });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a');
    await Promise.resolve();
    sockets[0]!.receive({ protocolVersion: version, type: 'ready' });
    vi.advanceTimersByTime(30_000);
    expect(sockets[0]!.sent.at(-1)).toEqual({ protocolVersion: version, type: 'ping' });
    sockets[0]!.receive({ protocolVersion: version, type: 'pong' });
    vi.advanceTimersByTime(30_000);
    expect(a.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    connect(transport, 'b');
    await Promise.resolve();
    sockets[1]!.receive({ protocolVersion: version, type: 'ready' });
    transport.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  }, 10_000);

  it('bounds socket backpressure and rejects further commands without replay', async () => {
    const socket = new ControlledSocket();
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => socket });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a');
    await Promise.resolve();
    socket.receive({ protocolVersion: version, type: 'ready' });
    socket.bufferedAmount = 16 * 1024 * 1024;
    const command: ClientMessage = { protocolVersion: version, type: 'cancel', payload: {
      requestId: 'cancel', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'a',
    } };
    expect(() => a.connection.send(command)).toThrow('buffer limit');
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(() => a.connection.send(command)).toThrow('closed');
    expect(socket.sent).toHaveLength(1);
  }, 10_000);

  it('disposes a congested channel without requesting logical reconnects', async () => {
    const socket = new ControlledSocket();
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => socket });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a');
    const b = connect(transport, 'b');
    await Promise.resolve();
    socket.receive({ protocolVersion: version, type: 'ready' });
    socket.bufferedAmount = 16 * 1024 * 1024;
    transport.dispose();
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
  }, 10_000);
});

class ControlledSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: unknown[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

it.each(['acknowledge', 'reject', 'disconnect'] as const)('keeps a slow send pending over a real session channel until %s', async outcome => {
  const history: HistoryPage = { protocolVersion: version, type: 'timeline_page', payload: {
    requestId: 'history', agentId: 'a', direction: 'tail', epoch: 'epoch', reset: false, staleCursor: false, gap: false, error: null,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: 'epoch', seq: 1 }, endCursor: { epoch: 'epoch', seq: 1 },
    hasOlder: false, hasNewer: false, entries: [{ providerId: 'test', seqStart: 1, seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [], timestamp: '2026-09-20T00:00:00Z',
      item: { type: 'compaction', status: 'completed' } }],
  } };
  const harness = await server(true, async () => Response.json(history));
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('a', harness.transport, replica, { operationTimeoutMs: 20, scheduleReconnect: () => () => {} });
  cleanups.push(() => client.stop());
  let status = 'idle'; client.subscribeStatus(value => { status = value; });
  client.start();
  await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
  const { socket, frame: subscription } = harness.frames[0]!;
  const emit = (message: RemoteServerMessage) => socket.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: subscription.subscriptionId, message }));
  emit({ protocolVersion: version, type: 'negotiated' });
  emit({ protocolVersion: version, type: 'agent_snapshot', payload: {
    id: 'a', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
    status: 'idle', activeTurn: null, pendingInteractions: [], runtimeInfo: { providerId: 'test', sessionId: 'a', status: 'idle' },
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: { question: false, planApproval: false, toolApproval: false } },
  } });
  await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
  emit({ protocolVersion: version, type: 'timeline_subscribed', payload: { requestId: harness.frames[1]!.frame.message.payload.requestId, agentIds: ['a'] } });
  await vi.waitFor(() => expect(status).toBe('ready'));
  let result = 'pending';
  const send = client.sendMessage('Continue after compact');
  void send.then(() => { result = 'accepted'; }, () => { result = 'rejected'; });
  await vi.waitFor(() => expect(harness.frames).toHaveLength(3));
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(result).toBe('pending');
  expect(status).toBe('ready');
  expect(replica.getState().outgoingMessages?.[0]?.status).toBe('sending');
  const requestId = harness.frames[2]!.frame.message.payload.requestId;
  if (outcome === 'acknowledge') {
    emit({ protocolVersion: version, type: 'command_acknowledged', payload: { requestId, agentId: 'a', command: 'send_message' } });
    await expect(send).resolves.toMatchObject({ type: 'command_acknowledged' });
    emit({ protocolVersion: version, type: 'agent_stream', payload: { agentId: 'a', epoch: 'epoch', seq: 2,
      timestamp: '2026-09-20T00:00:01Z', event: { type: 'timeline', providerId: 'test', resources: [], item: { type: 'user_message', text: 'Continue after compact' } } } });
    await vi.waitFor(() => expect(replica.getState().outgoingMessages).toEqual([]));
  } else if (outcome === 'reject') {
    emit({ protocolVersion: version, type: 'protocol_error', payload: { requestId, code: 'agent_busy', message: 'Native command still active.', recoverable: true } });
    await expect(send).rejects.toMatchObject({ code: 'agent_busy' });
    expect(replica.getState().outgoingMessages?.[0]?.status).toBe('failed');
  } else {
    socket.terminate();
    await expect(send).rejects.toMatchObject({ code: 'connection_disconnected' });
    expect(replica.getState().outgoingMessages?.[0]?.status).toBe('unconfirmed');
  }
  expect(harness.sockets).toHaveLength(1);
  expect(harness.frames.filter(({ frame }) => frame.message?.type === 'send_message')).toHaveLength(1);
}, 10_000);
