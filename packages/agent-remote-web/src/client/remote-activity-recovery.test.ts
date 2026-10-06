// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, type SessionChannelClientMessage, type SessionChannelServerMessage } from '@orchardworks/agent-remote-protocol';
import { HttpWebSocketTransport } from './http-websocket-transport.js';
import { RemoteActivityClient, type RemoteActivityState } from './remote-activity-client.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function activityChannel(initiallyHidden: boolean) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const document = Object.assign(new EventTarget(), { visibilityState: initiallyHidden ? 'hidden' : 'visible' });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', document);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => wss.once('listening', resolve));
  const sockets: WebSocket[] = [];
  const sent: SessionChannelClientMessage[] = [];
  const received: SessionChannelServerMessage[] = [];
  wss.on('connection', (socket, request) => {
    expect(request.url).toBe('/v1/session-channel?observation=activity&migrations=1&titles=1');
    sockets.push(socket);
    socket.on('message', data => {
      const frame = JSON.parse(String(data)) as SessionChannelClientMessage;
      sent.push(frame);
      if (frame.type === 'ping') socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'pong' }));
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready' }));
  });
  cleanups.push(() => new Promise<void>(resolve => {
    for (const socket of wss.clients) socket.terminate();
    wss.close(() => resolve());
  }));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Missing WebSocket server address.');
  const transport = new HttpWebSocketTransport(`http://127.0.0.1:${address.port}`, {
    sessionChannels: true,
    webSocketFactory: url => {
      const socket = new WebSocket(url);
      socket.on('message', data => received.push(JSON.parse(String(data)) as SessionChannelServerMessage));
      return socket;
    },
  });
  cleanups.push(() => transport.dispose());
  const states: RemoteActivityState[] = [];
  const client = new RemoteActivityClient('agent', transport, state => states.push(state));
  cleanups.push(() => client.stop());
  client.start();
  await vi.waitFor(() => expect(sent.filter(frame => frame.type === 'subscribe')).toHaveLength(1));
  const subscription = sent.find(frame => frame.type === 'subscribe')!;
  expect(subscription).toMatchObject({ agentId: 'agent', message: { type: 'negotiate', observation: 'activity' } });
  return { document, sockets, sent, received, states, subscription, client, transport };
}

it.each([false, true])('preserves an unconfirmed activity subscription across background suspension (starts hidden: %s)', async initiallyHidden => {
  const harness = await activityChannel(initiallyHidden);
  if (!initiallyHidden) {
    harness.document.visibilityState = 'hidden';
    harness.document.dispatchEvent(new Event('visibilitychange'));
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(harness.states).toEqual([{ connection: 'connecting' }]);
  expect(harness.sent.filter(frame => frame.type === 'unsubscribe')).toEqual([]);
  expect(harness.sent.filter(frame => frame.type === 'subscribe')).toHaveLength(1);
  expect(harness.sockets).toHaveLength(1);
  expect(harness.sockets[0]!.readyState).toBe(WebSocket.OPEN);

  harness.document.visibilityState = 'visible';
  harness.document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(harness.received.some(frame => frame.type === 'pong')).toBe(true));
  await vi.advanceTimersByTimeAsync(19_000);
  expect(harness.states).toEqual([{ connection: 'connecting' }]);
  harness.sockets[0]!.send(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId: harness.subscription.subscriptionId,
    message: { protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId: 'agent', status: 'running' } },
  }));
  await vi.waitFor(() => expect(harness.states.at(-1)).toEqual({ connection: 'ready', activity: 'running' }));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(harness.states).toEqual([{ connection: 'connecting' }, { connection: 'ready', activity: 'running' }]);
  expect(harness.sent.filter(frame => frame.type === 'unsubscribe')).toEqual([]);
  expect(harness.sent.filter(frame => frame.type === 'subscribe')).toHaveLength(1);
  expect(harness.sockets).toHaveLength(1);
  harness.client.stop(); harness.transport.dispose();
  await vi.waitFor(() => expect(harness.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
  expect(vi.getTimerCount()).toBe(0);
}, 10_000);
