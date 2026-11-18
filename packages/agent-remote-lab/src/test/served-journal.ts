import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { SessionJournal, type JournalRowInput } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { sequentialEpochs } from '@orchardworks/agent-remote-journal/testing';

export const row = (itemKey: string, text: string): JournalRowInput => ({
  itemKey, providerId: 'copilot', sourceKey: `source:${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text, messageId: itemKey },
});

/** A journal of complete rows in `epoch`, as a Controller would have published them. */
export function journalOf(epoch: string, rows: ReadonlyArray<readonly [string, string]>): SessionJournal {
  const journal = SessionJournal.create('host:copilot:one', epoch, sequentialEpochs());
  const { generation } = journal.claim('controller');
  let sequence = 0;
  for (const [key, text] of rows) {
    journal.append({ publisherId: 'controller', generation, sequence: ++sequence }, row(key, text));
    journal.complete({ publisherId: 'controller', generation, sequence: ++sequence }, key, `digest-${key}-${text}`);
  }
  return journal;
}

/**
 * A Relay that serves one session from a real `SessionJournal` over a real HTTP server and WebSocket: the session channel the client speaks, pages from
 * `pageJournal`, the item-key flag echoed. `serve` swaps the journal, as a Relay that replaced it would.
 */
export async function servedJournal(initial: SessionJournal) {
  let journal = initial;
  const requests: Array<{ direction: string; seq?: number; epoch?: string }> = [];
  const open = new Set<WebSocket>();
  const pageOf = (requestId: string, direction: 'tail' | 'before' | 'after', cursor: { epoch: string; seq: number } | undefined, limit: number) => {
    requests.push({ direction, seq: cursor?.seq, epoch: cursor?.epoch });
    const result = journal.page({ requestId, agentId: 'one', direction, ...(cursor ? { cursor } : {}), limit, itemKeys: true }, { olderBeyondJournal: false });
    if (result.kind !== 'page') throw new Error('The journal holds every body.');
    return result.page;
  };
  const http = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const epoch = url.searchParams.get('epoch');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageOf(url.searchParams.get('requestId') ?? 'http', (url.searchParams.get('direction') ?? 'tail') as 'tail', epoch ? { epoch, seq: Number(url.searchParams.get('seq')) } : undefined, Number(url.searchParams.get('limit') ?? 20))));
  });
  const sockets = new WebSocketServer({ server: http });
  sockets.on('connection', socket => {
    open.add(socket); socket.on('close', () => open.delete(socket));
    let subscriptionId = 0;
    const emit = (message: ServerMessage) => socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId, message }));
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'subscribe') {
        subscriptionId = frame.subscriptionId;
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', itemKeys: true });
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { id: 'one', providerId: 'copilot', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z',
          status: 'idle', activeTurn: null, pendingInteractions: [], capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
          runtimeInfo: { providerId: 'copilot', sessionId: 'one', status: 'idle' } } });
      }
      const message = frame.message;
      if (message?.type === 'timeline_subscription') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: ['one'] } });
      if (message?.type === 'timeline_request') {
        const { requestId, direction, cursor, limit } = message.payload;
        emit(pageOf(requestId, direction, cursor, limit));
      }
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready' }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`, requests,
    serve(next: SessionJournal) { journal = next; },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
}
