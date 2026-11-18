// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, HistoryPage } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, HttpWebSocketTransport, RemoteActivityClient, RemoteSessionClient, watchFeedReopen, type RemoteConnection, type RemoteServerMessage, type WebSocketLike } from '@orchardworks/agent-client';
import { installPageLifecycle, installStubbedGlobalPage } from '@orchardworks/agent-client/testing';

const version = '1.8.0';
const negotiate: ClientMessage = { protocolVersion: version, type: 'negotiate' };
const response: RemoteServerMessage = {
  protocolVersion: version, type: 'protocol_error',
  payload: { code: 'session_not_found', message: 'Session unavailable.', recoverable: false },
};
const cleanups: (() => unknown)[] = [];
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
  const opened = vi.fn(() => connection.send(activity ? ({ ...negotiate, observation: 'activity' } as ClientMessage) : negotiate));
  const connection: RemoteConnection = transport.connect(agentId, {
    onOpen: opened, onMessage: (message) => messages.push(message), onDisconnect: disconnect,
  });
  return { connection, messages, disconnect, opened };
}

describe('shared session states', () => {
  it('keeps one activity channel open while states are watched, applies snapshots and reopens it after a loss', async () => {
    const harness = await server();
    const views: Array<(ref: { hostId: string; providerId: string; nativeSessionId: string }) => string> = [];
    const stop = harness.transport.watchSessionStates(view => views.push(ref => view.state(ref).state));
    const reopened = vi.fn();
    const stopFeed = watchFeedReopen(reopened);
    await vi.waitFor(() => expect(harness.urls).toHaveLength(1));
    expect(harness.urls[0]).toContain('observation=activity');
    expect(harness.urls[0]).toContain('states=2');
    const thread = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'session_states', snapshot: true, hosts: [{ hostId: 'host', online: true, confirmedAgeMs: 0 }],
      states: [{ ...thread, state: 'waiting', ageMs: 0 }] }));
    await vi.waitFor(() => expect(views.at(-1)!(thread)).toBe('waiting'));
    // Session channels for content do not ask for states.
    connect(harness.transport, 'session');
    await vi.waitFor(() => expect(harness.urls).toHaveLength(2));
    expect(harness.urls[1]).not.toContain('states=');
    expect(reopened).not.toHaveBeenCalled();
    harness.sockets[0]!.terminate();
    await vi.waitFor(() => expect(harness.urls.filter(url => url.includes('states=2'))).toHaveLength(2), { timeout: 4000 });
    harness.sockets.at(-1)!.send(JSON.stringify({ protocolVersion: version, type: 'session_states', snapshot: true, hosts: [{ hostId: 'host', online: false }] }));
    await vi.waitFor(() => expect(views.at(-1)!(thread)).toBe('offline'));
    // Lists refetch when the feed reopens after a loss, and not when it opened the first time.
    expect(reopened).toHaveBeenCalledTimes(1);
    stopFeed();
    stop();
  });
});

describe('session channel transport', () => {

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
});

class ControlledSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: { type?: string; subscriptionId?: string }[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
