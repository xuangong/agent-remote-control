// @vitest-environment node
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { memoryHttp } from '@orchardworks/agent-session-runtime/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionJournal, type JournalRowInput } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-client';
import { sequentialEpochs } from '@orchardworks/agent-remote-journal/testing';

/**
 * The real client over a real WebSocket, reading pages that a real `SessionJournal` and `pageJournal` produce. The journal updates its
 * todo board in place and keeps that item's first sequence, the case in which a reconnect's `after` page carries an item that is older
 * than the rows the client holds.
 */
const row = (itemKey: string, text: string, item: JournalRowInput['item'] = { type: 'assistant_message', text, messageId: itemKey }): JournalRowInput => ({
  itemKey, providerId: 'copilot', sourceKey: `source:${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item,
});
const board = (done: boolean): JournalRowInput['item'] => ({ type: 'todo', items: [{ text: 'alpha', completed: done }] });

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

it('keeps older history reachable when a reconnect brings an item updated above the rows the client holds', async () => {
  const journal = SessionJournal.create('host:copilot:one', 'epoch-one', sequentialEpochs());
  const { generation } = journal.claim('controller');
  let sequence = 0;
  const publication = () => ({ publisherId: 'controller', generation, sequence: ++sequence });
  journal.append(publication(), { ...row('todo', 'board', board(false)), item: board(false) }, );
  journal.complete(publication(), 'todo', 'digest-todo');
  for (let index = 2; index <= 41; index += 1) { journal.append(publication(), row(`n${index}`, `Row ${index}`)); journal.complete(publication(), `n${index}`, `digest-${index}`); }

  const requests: string[] = [];
  const open = new Set<WebSocket>();
  const live = new Map<WebSocket, (message: ServerMessage) => void>();
  /** The Relay's live frame for a row the journal just applied: the item's key and its first sequence, as the journal session stream sends them. */
  const pushRow = (appended: ReturnType<SessionJournal['append']>) => {
    if (!appended) throw new Error('The journal refused the row.');
    for (const send of live.values()) send({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: { agentId: 'one', epoch: appended.epoch, seq: appended.seq, timestamp: appended.timestamp,
      event: { type: 'timeline', providerId: 'copilot', itemKey: appended.itemKey, itemSeqStart: journal.seqStartOf(appended.itemKey), item: appended.item, resources: [] } } } as ServerMessage);
  };
  const pageOf = (requestId: string, direction: 'tail' | 'before' | 'after', cursor: { epoch: string; seq: number } | undefined, limit: number) => {
    requests.push(`${direction}:${cursor?.seq ?? ''}`);
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
      if (message?.type === 'timeline_subscription') live.set(socket, emit);
      if (message?.type === 'timeline_subscription') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: ['one'] } });
      if (message?.type === 'timeline_request') {
        const { requestId, direction, cursor, limit } = message.payload;
        emit(pageOf(requestId, direction, cursor, limit));
      }
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready' }));
  });
  const net = memoryHttp(http);
  closers.push(() => net.close());

  const transport = new HttpWebSocketTransport(net.url, { fetch: net.fetch, WebSocket: net.WebSocket as never, sessionChannels: true });
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('one', transport, replica, { historyPageSize: 20, reconnectInitialDelayMs: 1 });
  const statuses: string[] = [];
  const stop = client.subscribeStatus(status => statuses.push(status));
  closers.push(() => { stop(); client.stop(); transport.dispose(); });
  client.start();
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 3000, interval: 2 });
  const keys = () => replica.getState().timeline.entries.map(entry => entry.itemKey);
  expect(keys()).toEqual(Array.from({ length: 20 }, (_, index) => `n${index + 22}`));
  expect(replica.getState().timeline.hasOlder).toBe(true);

  // The board changes while the client is connected: a live frame for an item above the window. It must not land at the bottom.
  pushRow(journal.append(publication(), row('todo', 'board', board(true))));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(keys()).toEqual(Array.from({ length: 20 }, (_, index) => `n${index + 22}`));

  // The board changes again (the journal keeps its first sequence) and a new row follows; the client reconnects.
  journal.append(publication(), row('todo', 'board', board(false)));
  journal.append(publication(), row('n42', 'Row 42'));
  journal.complete(publication(), 'n42', 'digest-42');
  statuses.length = 0;
  for (const socket of open) socket.terminate();
  await vi.waitFor(() => expect(keys().at(-1)).toBe('n42'), { timeout: 8000, interval: 2 });
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 3000, interval: 2 });
  expect(requests.at(-1)).toMatch(/^after:/);
  // The board is older history: it did not land above the held rows, and the rows between are still to be read.
  expect(keys()[0]).toBe('n22');
  expect(replica.getState().timeline.hasOlder).toBe(true);

  for (let pages = 0; pages < 5 && replica.getState().timeline.hasOlder; pages += 1) await client.loadOlder();
  const all = replica.getState().timeline.entries;
  expect(all.map(entry => entry.itemKey)).toEqual(['todo', ...Array.from({ length: 41 }, (_, index) => `n${index + 2}`)]);
  expect(all[0]).toMatchObject({ seqStart: 1, item: { items: [{ completed: false }] } });
  expect(replica.getState().timeline.hasOlder).toBe(false);
  expect(all.map(entry => entry.seqStart)).toEqual([...all.map(entry => entry.seqStart)].sort((a, b) => a - b));
}, 20_000);