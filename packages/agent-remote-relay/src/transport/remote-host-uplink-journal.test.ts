import { setTimeout as delay } from 'node:timers/promises';
import type { JournalRelayMessage } from '@orchardworks/agent-remote-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { createAgentRemoteRelay } from '../relay.js';
import { createRemoteHostUplinkClient } from './remote-host-uplink-client.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await delay(5); }
  throw new Error('Timed out.');
}

async function connect(options: { acknowledge: boolean | 1; journal: boolean }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  let asked: string | null = null;
  let relaySocket: WebSocket | undefined;
  const received: Array<Record<string, unknown>> = [];
  server.on('connection', (socket, request) => {
    asked = new URL(request.url!, 'http://relay').searchParams.get('journal');
    relaySocket = socket;
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, ...(options.acknowledge ? { journal: options.acknowledge === 1 ? 1 : 2 } : {}) }));
      else if (message.type.startsWith('journal_')) received.push(message);
    });
  });
  const relay = createAgentRemoteRelay({ providers: [] });
  closeables.push(() => relay.close());
  const available: Array<{ send(json: string): void } | undefined> = [];
  const messages: JournalRelayMessage[] = [];
  const client = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'key', providers: [], reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10,
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, resolveSession: () => undefined, control: async () => ({ status: 404, body: '{}' }),
    ...(options.journal ? { journal: { available: writer => { available.push(writer); }, receive: message => { messages.push(message); } } } : {}) });
  closeables.push(() => client.close());
  await client.ready;
  return { client, available, messages, received, asked: () => asked, relaySocket: () => relaySocket! };
}

describe('the journal grant on the Host uplink', () => {
  it('is not asked for without a journal owner, and nothing is handed over', async () => {
    const { asked, available } = await connect({ acknowledge: true, journal: false });
    expect(asked()).toBeNull();
    expect(available).toEqual([]);
  });

  it('is asked for, and the connection may write journal messages once the Relay acknowledges it', async () => {
    const { asked, available, received } = await connect({ acknowledge: true, journal: true });
    expect(asked()).toBe('2');
    expect(available).toHaveLength(1);
    available[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'journal_open', requestId: 'open-1', sessionKey: 'codex:thread-1', publisherId: 'controller-1' }));
    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: 'journal_open', requestId: 'open-1' });
  });

  it('hands every journal message of the Relay to its owner, decoded', async () => {
    const { messages, relaySocket } = await connect({ acknowledge: true, journal: true });
    const send = (message: Record<string, unknown>) => relaySocket().send(JSON.stringify({ uplinkVersion: 2, ...message }));
    send({ type: 'journal_ack', sessionKey: 'codex:thread-1', generation: 1, watermark: 3, cursor: { epoch: 'epoch-1', seq: 2 } });
    send({ type: 'journal_older_request', requestId: 'older-1', sessionKey: 'codex:thread-1', limit: 50 });
    send({ type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'codex:thread-1', itemKeys: ['a'] });
    send({ type: 'journal_refused', sessionKey: 'codex:thread-1', generation: 1, sequence: 4, reason: 'body_missing', itemKey: 'a' });
    send({ type: 'journal_open_refused', requestId: 'open-1', sessionKey: 'codex:thread-1', reason: 'index_too_large' });
    await until(() => messages.length === 5);
    expect(messages.map(message => message.type)).toEqual(['journal_ack', 'journal_older_request', 'journal_fill_request', 'journal_refused', 'journal_open_refused']);
    expect(messages[0]).toMatchObject({ watermark: 3, cursor: { seq: 2 } });
    expect(messages[3]).toMatchObject({ reason: 'body_missing', itemKey: 'a' });
  });

  it('is told that no connection may write when the Relay does not acknowledge journals', async () => {
    const { available } = await connect({ acknowledge: false, journal: true });
    expect(available).toEqual([undefined]);
  });

  it('is told that no connection may write when the Relay acknowledges only level 1, which lacks what this Controller publishes', async () => {
    const { available, messages, relaySocket } = await connect({ acknowledge: 1, journal: true });
    expect(available).toEqual([undefined]);
    relaySocket().send(JSON.stringify({ uplinkVersion: 2, type: 'journal_ack', sessionKey: 'codex:thread-1', generation: 1, watermark: 1, cursor: { epoch: 'epoch-1', seq: 1 } }));
    await delay(50);
    expect(messages).toEqual([]);
  });

  it('is told that the connection ended, and offered the next one', async () => {
    const { available, relaySocket } = await connect({ acknowledge: true, journal: true });
    expect(available).toHaveLength(1);
    relaySocket().terminate();
    await until(() => available.length === 3);
    expect(available[1]).toBeUndefined();
    expect(available[2]).toBeDefined();
  });
});
