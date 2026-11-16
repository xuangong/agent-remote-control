import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, type AgentTimelineItem, type HistoryPage, type ServerMessage } from '@orchardworks/agent-remote-protocol';

/**
 * A Relay that serves one session from a journal: rows with item keys in an epoch, a tail, `after` and `before` pages, a
 * replacement frame, and the item-key flag it echoes. The real client reads it over a real WebSocket and HTTP.
 */
export interface Row { key: string; seq: number; item: AgentTimelineItem }
export function journalRelay(options: { echoFlag?: boolean } = {}) {
  let epoch = 'epoch-one';
  let rows: Row[] = [];
  let holdTail: Promise<void> | undefined;
  const requests: Array<{ direction: string; seq?: number; epoch?: string; limit?: number; via: 'http' | 'socket' }> = [];
  const negotiates: Array<Record<string, unknown>> = [];
  const open = new Set<import('ws').WebSocket>();
  const entry = (row: Row) => ({
    providerId: 'copilot', ...(options.echoFlag === false ? {} : { itemKey: row.key }), item: row.item, timestamp: `2026-11-16T00:00:${String(row.seq % 60).padStart(2, '0')}.000Z`,
    seqStart: row.seq, seqEnd: row.seq, sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }], collapsed: [], resources: [],
  });
  const page = (requestId: string, direction: string, via: 'http' | 'socket', cursorEpoch?: string, seq = 0, limit = 100): HistoryPage => {
    requests.push({ direction, seq, epoch: cursorEpoch, limit, via });
    const base = { requestId, agentId: 'one', direction: direction as HistoryPage['payload']['direction'], error: null, hasNewer: false };
    if (cursorEpoch !== undefined && cursorEpoch !== epoch) {
      return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: { ...base, epoch, reset: true, staleCursor: true, gap: false, window: { minSeq: 1, maxSeq: rows.length, nextSeq: rows.length + 1 }, startCursor: null, endCursor: null, hasOlder: false, entries: [] } };
    }
    const selected = direction === 'tail' ? rows.slice(-limit) : direction === 'before' ? rows.filter(row => row.seq < seq).slice(-limit) : rows.filter(row => row.seq > seq).slice(0, limit);
    const first = selected[0]?.seq, last = selected.at(-1)?.seq;
    return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: { ...base, epoch, reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: rows.length, nextSeq: rows.length + 1 }, startCursor: first === undefined ? null : { epoch, seq: first }, endCursor: last === undefined ? null : { epoch, seq: last },
      hasOlder: direction === 'before' ? (first ?? 1) > 1 : direction === 'tail' ? rows.length > selected.length : false, entries: selected.map(entry) } };
  };
  const http: Server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const cursor = url.searchParams.get('epoch') ?? undefined;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(page(url.searchParams.get('requestId') ?? 'http', url.searchParams.get('direction') ?? 'tail', 'http', cursor, Number(url.searchParams.get('seq') ?? 0), Number(url.searchParams.get('limit') ?? 100))));
  });
  const sockets = new WebSocketServer({ server: http });
  const emitAll = (message: ServerMessage) => { for (const socket of open) (socket as unknown as { pushFrame(message: ServerMessage): void }).pushFrame(message); };
  sockets.on('connection', socket => {
    open.add(socket);
    let subscriptionId = 0;
    const emit = (message: ServerMessage) => { socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId, message })); };
    (socket as unknown as { pushFrame: typeof emit }).pushFrame = emit;
    socket.on('close', () => open.delete(socket));
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'subscribe') {
        subscriptionId = frame.subscriptionId;
        negotiates.push(frame.message);
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', ...(options.echoFlag !== false && frame.message?.itemKeys === true ? { itemKeys: true as const } : {}) });
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { id: 'one', providerId: 'copilot', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z',
          status: 'idle', activeTurn: null, pendingInteractions: [], capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
          runtimeInfo: { providerId: 'copilot', sessionId: 'one', status: 'idle' } } });
      }
      const message = frame.message;
      if (message?.type === 'timeline_subscription') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: ['one'] } });
      if (message?.type === 'timeline_request') {
        const { requestId, direction, cursor, limit } = message.payload;
        const answer = () => emit(page(requestId, direction, 'socket', cursor?.epoch, cursor?.seq, limit));
        if (direction === 'tail' && holdTail) void holdTail.then(answer); else answer();
      }
      if (message?.type === 'send_message') emit({ protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged', payload: { requestId: message.payload.requestId, agentId: 'one', command: 'send_message' } });
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready' }));
  });
  return {
    requests, negotiates,
    async listen() { await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); const address = http.address(); if (!address || typeof address === 'string') throw new Error('no port'); return `http://127.0.0.1:${address.port}`; },
    setRows(next: Row[], nextEpoch = epoch) { rows = next; epoch = nextEpoch; },
    /** The journal is replaced: a new epoch and its rows, announced to every open page. */
    replace(next: Row[], nextEpoch: string) { rows = next; epoch = nextEpoch; emitAll({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: 'one', epoch: nextEpoch } }); },
    holdTails() { let release!: () => void; holdTail = new Promise<void>(resolve => { release = resolve; }); return () => { holdTail = undefined; release(); }; },
    dropConnections() { for (const socket of open) socket.terminate(); },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
}

export const text = (key: string, seq: number, body: string, role: 'assistant' | 'user' | 'reasoning' = 'assistant'): Row => ({ key, seq, item: role === 'user' ? { type: 'user_message', text: body, messageId: key } : role === 'reasoning' ? { type: 'reasoning', text: body } : { type: 'assistant_message', text: body, messageId: key } });
