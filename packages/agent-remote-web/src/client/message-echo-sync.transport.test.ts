// @vitest-environment node
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HistoryPage, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { AgentReplica } from '../replica/store.js';
import { HttpWebSocketTransport } from './http-websocket-transport.js';
import { RemoteSessionClient } from './remote-session-client.js';

it('recovers an omitted live echo through HTTP without reconnecting or resending on the real session channel', async () => {
  let sends = 0;
  let connections = 0;
  const reads: URL[] = [];
  const history = (requestId: string): HistoryPage => ( { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId, agentId: 'one', direction: sends ? 'after' : 'tail', epoch: 'epoch-one',
      reset: false, staleCursor: false, gap: false, error: null,
      window: { minSeq: sends ? 1 : 0, maxSeq: sends ? 1 : 0, nextSeq: sends ? 2 : 1 },
      startCursor: sends ? { epoch: 'epoch-one', seq: 1 } : null,
      endCursor: sends ? { epoch: 'epoch-one', seq: 1 } : null, hasOlder: false, hasNewer: false,
      entries: sends ? [{ providerId: 'test', item: { type: 'user_message', text: 'Recover my message' },
        timestamp: '2026-09-25T00:00:00.000Z', seqStart: 1, seqEnd: 1,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [] }] : [],
    } });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    reads.push(url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(history(url.searchParams.get('requestId')!)));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => {
    connections++;
    let subscriptionId = 0;
    const emit = (message: ServerMessage) => socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId, message }));
    socket.on('message', data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'subscribe') {
        subscriptionId = frame.subscriptionId;
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated' });
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
          id: 'one', providerId: 'test', createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
          status: 'idle', activeTurn: null, pendingInteractions: [],
          capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
            interactions: { question: false, planApproval: false, toolApproval: false } },
          runtimeInfo: { providerId: 'test', sessionId: 'one', status: 'idle' },
        } });
      }
      if (frame.message?.type === 'timeline_request') emit(history(frame.message.payload.requestId));
      if (frame.message?.type === 'timeline_subscription') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed',
        payload: { requestId: frame.message.payload.requestId, agentIds: ['one'] } });
      if (frame.message?.type === 'send_message') {
        sends++;
        // The authoritative history contains the input, but its live event is omitted.
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged',
          payload: { requestId: frame.message.payload.requestId, agentId: 'one', command: 'send_message' } });
      }
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const transport = new HttpWebSocketTransport(`http://127.0.0.1:${address.port}`, { WebSocket, sessionChannels: true });
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('one', transport, replica);
  const statuses: string[] = [];
  const unsubscribe = client.subscribeStatus(status => statuses.push(status));
  try {
    client.start();
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 2000, interval: 10 });
    statuses.length = 0;
    await client.sendMessage('Recover my message');
    expect(replica.getState().outgoingMessages).toMatchObject([{ status: 'awaiting_echo' }]);
    await vi.waitFor(() => expect(replica.getState().outgoingMessages).toEqual([]), { timeout: 12_000, interval: 25 });
    expect(replica.getState().timeline.entries[0]?.item).toMatchObject({ type: 'user_message', text: 'Recover my message' });
    expect(reads).toHaveLength(1);
    expect(reads[0]?.searchParams.get('direction')).toBe('after');
    expect(reads[0]?.searchParams.get('seq')).toBe('0');
    expect(sends).toBe(1);
    expect(connections).toBe(1);
    expect(statuses).toEqual([]);
  } finally {
    unsubscribe(); client.stop(); transport.dispose();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 20_000);
