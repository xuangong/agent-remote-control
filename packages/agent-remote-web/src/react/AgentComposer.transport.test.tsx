import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { act, useEffect, useState, useSyncExternalStore } from 'react';
import { expect, it, vi } from 'vitest';
import { decodeHistoryPage, type ClientMessage, type HistoryPage, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { AgentReplica } from '../replica/store.js';
import { HttpWebSocketTransport } from '../client/http-websocket-transport.js';
import { RemoteSessionClient, type RemoteSessionStatus } from '../client/remote-session-client.js';
import { AgentComposer } from './AgentComposer.js';
import { render, unmount } from '../test/setup.js';

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)('ws') as typeof import('ws');
const version = '1.5.0';

it('holds a message through a real channel reconnect and never replays an unconfirmed send', async () => {
  const history: HistoryPage = { protocolVersion: version, type: 'timeline_page', payload: {
    requestId: 'history', agentId: 'one', direction: 'tail', epoch: 'epoch-one', reset: false, staleCursor: false, gap: false, error: null,
    window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [],
  } };
  expect(decodeHistoryPage(JSON.stringify(history)).status).toBe('ok');
  const server = createServer((request, response) => {
    const direction = new URL(request.url!, 'http://localhost').searchParams.get('direction');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...history, payload: { ...history.payload, direction: direction ?? 'tail' } }));
  });
  const sockets = new WebSocketServer({ server });
  let blockRecovery = false;
  let releaseRecovery: (() => void) | undefined;
  let currentSocket: import('ws').WebSocket | undefined;
  const sent: Extract<ClientMessage, { type: 'send_message' }>[] = [];
  sockets.on('connection', socket => {
    currentSocket = socket;
    let subscriptionId = 0;
    const emit = (message: ServerMessage) => socket.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId, message }));
    socket.on('message', data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'subscribe') {
        subscriptionId = frame.subscriptionId;
        emit({ protocolVersion: version, type: 'negotiated' });
        emit({ protocolVersion: version, type: 'agent_snapshot', payload: {
          id: 'one', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
          capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
          pendingInteractions: [], runtimeInfo: { providerId: 'test', sessionId: 'one', status: 'idle' },
        } });
      }
      if (frame.message?.type === 'timeline_subscription') {
        const ready = () => emit({ protocolVersion: version, type: 'timeline_subscribed', payload: { requestId: frame.message.payload.requestId, agentIds: ['one'] } });
        if (blockRecovery) releaseRecovery = ready; else ready();
      }
      if (frame.message?.type === 'send_message') {
        sent.push(frame.message);
        socket.terminate();
      }
    });
    socket.send(JSON.stringify({ protocolVersion: version, type: 'ready' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const transport = new HttpWebSocketTransport(`http://127.0.0.1:${address.port}`, { WebSocket, sessionChannels: true });
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('one', transport, replica, { reconnectInitialDelayMs: 10, reconnectMaxDelayMs: 10 });
  let status: RemoteSessionStatus = 'idle';
  const unsubscribe = client.subscribeStatus(value => { status = value; });
  function Harness() {
    const [connection, setConnection] = useState<RemoteSessionStatus>('idle');
    useEffect(() => client.subscribeStatus(setConnection), []);
    const state = useSyncExternalStore(callback => replica.subscribe(callback), () => replica.getState());
    return <AgentComposer state={state} disabled={connection !== 'ready'} recovering={connection !== 'idle' && connection !== 'ready'}
      onSendMessage={async text => { await client.sendMessage(text); }} />;
  }
  const container = await render(<Harness />);
  const until = async (assertion: () => void) => {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      assertion();
    }, { timeout: 3000, interval: 10 });
  };
  try {
    await act(async () => client.start());
    await until(() => expect(status, JSON.stringify(replica.getState().diagnostics)).toBe('ready'));
    blockRecovery = true;
    await act(async () => currentSocket!.terminate());
    await until(() => expect(releaseRecovery).toBeDefined());
    expect(status).toBe('catching_up');
    await act(async () => {
      const input = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Across the reconnect');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      button.click();
    });
    expect(container.querySelector('[data-testid="pending-send"]')).not.toBeNull();
    expect(sent).toHaveLength(0);
    expect(replica.getState().outgoingMessages ?? []).toHaveLength(0);
    blockRecovery = false;
    await act(async () => releaseRecovery!());
    await until(() => expect(replica.getState().outgoingMessages?.[0]?.status).toBe('unconfirmed'));
    await until(() => expect(status, JSON.stringify(replica.getState().diagnostics)).toBe('ready'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.text).toBe('Across the reconnect');
    expect(container.querySelector('[data-testid="pending-send"]')?.getAttribute('data-state')).toBe('error');
    expect(container.querySelector('textarea')!.value).toBe('');
  } finally {
    await unmount(container);
    unsubscribe(); client.stop(); transport.dispose();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);
