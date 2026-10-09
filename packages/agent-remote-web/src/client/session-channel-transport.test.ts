// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, HistoryPage } from '@orchardworks/agent-remote-protocol';
import { HttpWebSocketTransport, type WebSocketLike } from './http-websocket-transport.js';
import type { RemoteConnection, RemoteServerMessage } from './transport.js';
import { AgentReplica } from '../replica/store.js';
import { RemoteSessionClient } from './remote-session-client.js';

const version = '1.7.0';
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
  it('delivers ordered title updates once across channels and replays the latest name', async () => {
    const harness = await server(); connect(harness.transport, 'session'); connect(harness.transport, 'session', true);
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(2));
    const received = vi.fn(); harness.transport.onSessionTitle(received);
    const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Renamed', revision: 3 };
    for (const socket of harness.sockets) socket.send(JSON.stringify({ protocolVersion: version, type: 'session_title_updated', session }));
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'session_title_updated', session: { ...session, title: 'Old', revision: 2 } }));
    const late = vi.fn(); harness.transport.onSessionTitle(late); expect(late).toHaveBeenCalledWith(session);
  });

  it('delivers account migrations once across content and activity channels and replays to a late listener', async () => {
    const harness = await server();
    connect(harness.transport, 'original'); connect(harness.transport, 'original', true);
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(2));
    const from = { hostId: 'host', providerId: 'codex', nativeSessionId: 'old', agentId: 'original' };
    const migration = { id: 'edit', from, to: { ...from, nativeSessionId: 'new', agentId: 'branch' }, createdAt: 1 };
    const received = vi.fn(); const remove = harness.transport.onSessionMigration(received);
    for (const socket of harness.sockets) socket.send(JSON.stringify({ protocolVersion: version, type: 'session_migrated', migration }));
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    const late = vi.fn(); harness.transport.onSessionMigration(late);
    expect(late).toHaveBeenCalledWith(migration); remove();
  });
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
    expect(harness.urls.sort()).toEqual(['/base/v1/session-channel?observation=activity&migrations=1&titles=1', '/base/v1/session-channel?observation=session&migrations=1&titles=1']);
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
    expect(harness.urls).toEqual(['/base/v1/session-channel?observation=session&migrations=1&titles=1', '/base/v1/session-channel?observation=session&migrations=1&titles=1']);
    expect(harness.frames.filter(({ frame }) => frame.type === 'message')).toHaveLength(1);
  }, 10_000);

  it('falls back before ready only once without duplicate opens or negotiation', async () => {
    const harness = await server(false);
    const a = connect(harness.transport, 'agent one');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    harness.sockets[0]!.close();
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    expect(harness.urls).toEqual(['/base/v1/session-channel?observation=session&migrations=1&titles=1', '/base/v1/sessions/agent%20one/events']);
    expect(harness.frames[0]!.frame).toEqual(negotiate);
    expect(a.opened).toHaveBeenCalledTimes(1);
    expect(a.disconnect).not.toHaveBeenCalled();
    a.connection.close();
    connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    expect(harness.urls[2]).toBe('/base/v1/sessions/b/events');
  }, 10_000);

  it('falls back for an unanswered ready handshake without disabling multiplexing for later sessions', async () => {
    const harness = await server(false);
    const a = connect(harness.transport, 'agent one');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1), { timeout: 12000 });
    expect(harness.urls).toEqual(['/base/v1/session-channel?observation=session&migrations=1&titles=1', '/base/v1/sessions/agent%20one/events']);
    expect(harness.frames[0]!.frame).toEqual(negotiate);
    expect(a.opened).toHaveBeenCalledOnce();
    expect(a.disconnect).not.toHaveBeenCalled();
    connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(3));
    expect(harness.urls[2]).toBe('/base/v1/session-channel?observation=session&migrations=1&titles=1');
    harness.sockets[2]!.send(JSON.stringify({ protocolVersion: version, type: 'ready' }));
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    expect(harness.frames[1]!.frame).toMatchObject({ type: 'subscribe', agentId: 'b' });
  }, 15_000);

  it.each([false, true])('waits for the actual socket open before starting channel negotiation timeout (suspend=%s)', async suspend => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    const browserWindow = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browserWindow); vi.stubGlobal('document', document);
    cleanups.push(() => vi.unstubAllGlobals());
    const sockets: ControlledSocket[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => {
      const socket = new ControlledSocket(); socket.readyState = 0; sockets.push(socket); return socket;
    } });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a'); await Promise.resolve();
    if (suspend) {
      document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(60_000);
      document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    }
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(0);
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen?.({});
    vi.advanceTimersByTime(9999);
    expect(sockets).toHaveLength(1);
    sockets[0]!.receive({protocolVersion: version, type: 'ready'});
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(1);
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(sockets[0]!.sent).toEqual([expect.objectContaining({ type: 'subscribe', agentId: 'a' })]);
    transport.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces a socket that never opens when the session connection deadline expires', async () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    const sockets: ControlledSocket[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => {
      const socket = new ControlledSocket(); socket.readyState = 0; sockets.push(socket); return socket;
    } });
    cleanups.push(() => transport.dispose());
    const client = new RemoteSessionClient('a', transport, new AgentReplica(), { connectionTimeoutMs: 20_000, reconnectInitialDelayMs: 250 });
    cleanups.push(() => client.stop());
    client.start(); await Promise.resolve();
    vi.advanceTimersByTime(20_000);
    expect(sockets[0]!.readyState).toBe(3);
    vi.advanceTimersByTime(250); await Promise.resolve();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.readyState).toBe(0);
    client.stop(); transport.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a connecting physical channel despite staggered logical session retries', async () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    const sockets: ControlledSocket[] = [];
    const urls: string[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: url => {
      const socket = new ControlledSocket(); socket.readyState = 0; sockets.push(socket); urls.push(url); return socket;
    } });
    cleanups.push(() => transport.dispose());
    const first = new RemoteSessionClient('a', transport, new AgentReplica(), { connectionTimeoutMs: 20_000, reconnectInitialDelayMs: 250 });
    const second = new RemoteSessionClient('b', transport, new AgentReplica(), { connectionTimeoutMs: 20_000, reconnectInitialDelayMs: 250 });
    cleanups.push(() => { first.stop(); second.stop(); });
    first.start(); await Promise.resolve();
    vi.advanceTimersByTime(10_000);
    second.start(); await Promise.resolve();
    vi.advanceTimersByTime(10_000);
    expect(sockets[0]!.readyState).toBe(3);
    vi.advanceTimersByTime(250); await Promise.resolve();
    expect(sockets).toHaveLength(2);
    expect(urls.every(url => url.includes('session-channel'))).toBe(true);
    first.stop(); second.stop(); transport.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('never downgrades a known multiplexed relay because a later ready handshake times out', async () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    const sockets: ControlledSocket[] = [];
    const urls: string[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: url => {
      const socket = new ControlledSocket(); sockets.push(socket); urls.push(url); return socket;
    } });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a'); await Promise.resolve();
    sockets[0]!.receive({ protocolVersion: version, type: 'ready' });
    sockets[0]!.close();
    expect(a.disconnect).toHaveBeenCalledOnce();
    const b = connect(transport, 'b'); await Promise.resolve();
    vi.advanceTimersByTime(10_000);
    expect(b.disconnect).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(2);
    connect(transport, 'c'); await Promise.resolve();
    sockets[2]!.receive({ protocolVersion: version, type: 'ready' });
    expect(sockets[2]!.sent).toEqual([expect.objectContaining({ type: 'subscribe', agentId: 'c' })]);
    expect(urls.every(url => url.includes('session-channel'))).toBe(true);
    transport.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

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

  it.each([0, 60_000])('preserves healthy content and activity channels through a %i ms page suspension', async suspendedMs => {
    const browserWindow = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browserWindow); vi.stubGlobal('document', document);
    cleanups.push(() => vi.unstubAllGlobals());
    const harness = await server();
    const a = connect(harness.transport, 'a');
    const activity = connect(harness.transport, 'a', true);
    await vi.waitFor(() => expect(harness.frames).toHaveLength(2));
    for (const socket of harness.sockets) socket.on('message', data => {
      if (JSON.parse(String(data)).type === 'ping') socket.send(JSON.stringify({ protocolVersion: version, type: 'pong' }));
    });
    const hiddenAt = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(hiddenAt);
    cleanups.push(() => now.mockRestore());
    document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    now.mockReturnValue(hiddenAt + suspendedMs);
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    browserWindow.dispatchEvent(new Event('online'));
    now.mockRestore();
    await vi.waitFor(() => expect(harness.frames.filter(({frame}) => frame.type === 'ping')).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(a.disconnect).not.toHaveBeenCalled(); expect(activity.disconnect).not.toHaveBeenCalled();
    expect(harness.sockets).toHaveLength(2);
    harness.transport.dispose();
    browserWindow.dispatchEvent(new Event('online'));
    expect(a.disconnect).not.toHaveBeenCalled();
  });

  it('preserves a healthy foreground channel when mobile latency delays pong by 1500 ms', async () => {
    const browserWindow = new EventTarget();
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    cleanups.push(() => vi.unstubAllGlobals());
    const harness = await server(); const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    cleanups.push(() => clearTimeout(pongTimer));
    harness.sockets[0]!.on('message', data => {
      if (JSON.parse(String(data)).type === 'ping') pongTimer = setTimeout(() => {
        harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'pong' }));
      }, 1500);
    });
    const resumedAt = performance.now();
    browserWindow.dispatchEvent(new Event('online'));
    await new Promise(resolve => setTimeout(resolve, 1700));
    console.info('Delayed foreground pong', { delayMs: 1500, elapsedMs: Math.round(performance.now() - resumedAt), disconnects: a.disconnect.mock.calls.length });
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.frames.filter(({ frame }) => frame.type === 'subscribe')).toHaveLength(1);
  });

  it('keeps multiplexing when the first channel ready frame takes 3500 ms to arrive', async () => {
    const harness = await server(false); const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    const openedAt = performance.now();
    await new Promise(resolve => setTimeout(resolve, 3500));
    harness.sockets[0]!.send(JSON.stringify({ protocolVersion: version, type: 'ready' }));
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    console.info('Delayed channel readiness', { delayMs: 3500, elapsedMs: Math.round(performance.now() - openedAt), sockets: harness.sockets.length });
    expect(harness.urls).toHaveLength(1);
    expect(harness.frames[0]!.frame).toMatchObject({ type: 'subscribe', agentId: 'a' });
    expect(a.disconnect).not.toHaveBeenCalled();
  });

  it('retires an unresponsive resumed channel promptly and only once', async () => {
    const browserWindow = new EventTarget();
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    cleanups.push(() => vi.unstubAllGlobals());
    const harness = await server(); const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    browserWindow.dispatchEvent(new Event('online'));
    expect(a.disconnect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(a.disconnect).toHaveBeenCalledTimes(1), {timeout: 5500});
    browserWindow.dispatchEvent(new Event('online'));
    expect(a.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['content', 'activity'] as const)('wakes a waiting %s reconnect immediately and coalesces browser signals', async mode => {
    const browserWindow = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browserWindow); vi.stubGlobal('document', document);
    cleanups.push(() => vi.unstubAllGlobals());
    const harness = await server();
    const { RemoteActivityClient } = await import('./remote-activity-client.js');
    const client = mode === 'content'
      ? new RemoteSessionClient('a', harness.transport, new AgentReplica(), {reconnectInitialDelayMs: 5000})
      : new RemoteActivityClient('a', harness.transport, () => {});
    cleanups.push(() => client.stop()); client.start();
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1));
    harness.sockets[0]!.terminate();
    await vi.waitFor(() => expect(harness.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
    await new Promise(resolve => setTimeout(resolve, 30));
    document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    browserWindow.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(harness.frames.filter(({frame}) => frame.type === 'subscribe')).toHaveLength(2), {timeout: 500});
    expect(harness.sockets).toHaveLength(2);
    client.stop(); browserWindow.dispatchEvent(new Event('online'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(harness.sockets).toHaveLength(2);
  });

  it('pauses heartbeat deadlines while hidden and gives a resumed channel a fresh probe', async () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    const browserWindow = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browserWindow); vi.stubGlobal('document', document);
    cleanups.push(() => vi.unstubAllGlobals());
    const socket = new ControlledSocket();
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => socket });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a'); await Promise.resolve();
    socket.receive({protocolVersion: version, type: 'ready'});
    vi.advanceTimersByTime(30_000);
    expect(socket.sent.filter((frame: any) => frame.type === 'ping')).toHaveLength(1);
    document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(60_000);
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(socket.sent.filter((frame: any) => frame.type === 'ping')).toHaveLength(1);
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    expect(socket.sent.filter((frame: any) => frame.type === 'ping')).toHaveLength(2);
    vi.advanceTimersByTime(3999);
    expect(a.disconnect).not.toHaveBeenCalled();
    socket.receive({protocolVersion: version, type: 'pong'});
    vi.advanceTimersByTime(1);
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(socket.sent.filter((frame: any) => frame.type === 'subscribe')).toHaveLength(1);
    transport.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses an opening channel deadline while hidden and bounds its foreground retry', async () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    const browserWindow = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browserWindow); vi.stubGlobal('document', document);
    cleanups.push(() => vi.unstubAllGlobals());
    const sockets: ControlledSocket[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => {
      const socket = new ControlledSocket(); sockets.push(socket); return socket;
    } });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a'); await Promise.resolve();
    document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(1);
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(9999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.readyState).toBe(3);
    expect(a.disconnect).not.toHaveBeenCalled();
    transport.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('retires a closed channel immediately on foreground without waiting for a probe', async () => {
    const browserWindow = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browserWindow); vi.stubGlobal('document', document);
    cleanups.push(() => vi.unstubAllGlobals());
    const socket = new ControlledSocket();
    const transport = new HttpWebSocketTransport('http://relay.test', { sessionChannels: true, webSocketFactory: () => socket });
    cleanups.push(() => transport.dispose());
    const a = connect(transport, 'a'); await Promise.resolve();
    socket.receive({protocolVersion: version, type: 'ready'});
    document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    socket.readyState = 3;
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    expect(a.disconnect).toHaveBeenCalledOnce();
    expect(socket.sent).toHaveLength(1);
  });

  it('bounds pending commands and never sends a canceled pending stream after ready', async () => {
    const harness = await server(false);
    const a = connect(harness.transport, 'a');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    const command: ClientMessage = { protocolVersion: version, type: 'cancel', payload: {
      requestId: 'cancel', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'a',
    } };
    expect(() => { for (let index = 0; index < 1024; index++) a.connection.send(command); }).toThrow('limit');
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    const b = connect(harness.transport, 'b');
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(2));
    expect(harness.sockets[0]!.readyState).toBe(WebSocket.CLOSED);
    harness.sockets[1]!.send(JSON.stringify({ protocolVersion: version, type: 'ready' }));
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

it.each(['acknowledge', 'resume_then_acknowledge', 'slow_resume_then_acknowledge', 'reject', 'disconnect'] as const)('settles a slow send over a real session channel: %s', async outcome => {
  const browserWindow = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', browserWindow); vi.stubGlobal('document', document);
  cleanups.push(() => vi.unstubAllGlobals());
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
  await vi.waitFor(() => expect(harness.frames).toHaveLength(3));
  emit({ protocolVersion: version, type: 'timeline_subscribed', payload: { requestId: harness.frames[1]!.frame.message.payload.requestId, agentIds: ['a'] } });
  emit({...history, payload: {...history.payload, requestId: harness.frames[2]!.frame.message.payload.requestId}});
  await vi.waitFor(() => expect(status).toBe('ready'));
  let result = 'pending';
  const send = client.sendMessage('Continue after compact');
  void send.then(() => { result = 'accepted'; }, () => { result = 'rejected'; });
  await vi.waitFor(() => expect(harness.frames).toHaveLength(4));
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(result).toBe('pending');
  expect(status).toBe('ready');
  expect(replica.getState().outgoingMessages?.[0]?.status).toBe('sending');
  const requestId = harness.frames[3]!.frame.message.payload.requestId;
  if (outcome === 'resume_then_acknowledge' || outcome === 'slow_resume_then_acknowledge') {
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    cleanups.push(() => clearTimeout(pongTimer));
    socket.on('message', data => {
      if (JSON.parse(String(data)).type === 'ping') pongTimer = setTimeout(() => {
        socket.send(JSON.stringify({ protocolVersion: version, type: 'pong' }));
      }, outcome === 'slow_resume_then_acknowledge' ? 1500 : 0);
    });
    const hiddenAt = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(hiddenAt);
    cleanups.push(() => now.mockRestore());
    document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    now.mockReturnValue(hiddenAt + 60_000);
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    now.mockRestore();
    await vi.waitFor(() => expect(harness.frames.filter(({frame}) => frame.type === 'ping')).toHaveLength(1));
    if (outcome === 'slow_resume_then_acknowledge') await new Promise(resolve => setTimeout(resolve, 1700));
    expect(result).toBe('pending');
    expect(status).toBe('ready');
  }
  if (outcome === 'acknowledge' || outcome === 'resume_then_acknowledge' || outcome === 'slow_resume_then_acknowledge') {
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
