import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, expect, it } from 'vitest';
import { createHostBroker, type RelaySocket } from './index.js';
import { createDiagnosticJournal } from './diagnostic-journal.js';
import type { RelayDiagnostic } from './relay-diagnostics.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

function transportPair() {
  class Socket implements RelaySocket {
    readyState = 1; bufferedAmount = 0; closeCode?: number; peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void | Promise<void>>(); closes = new Set<() => void>();
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); });
    }
    close(code?: number) {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.closeCode = code;
      for (const listener of this.closes) listener();
      this.peer.close(code);
    }
    onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
    onError() { return () => {}; }
  }
  const server = new Socket(), native = new Socket(); server.peer = native; native.peer = server;
  close.push(() => server.close());
  return { server, native };
}

type Wire = Record<string, any>;
const SESSION = 'codex:thread-1';
const DIGEST = 'a'.repeat(64);
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text, messageId: itemKey },
});

/** A Controller connected over the in-memory transport. `query` is what it asks for when it connects. */
async function connectedHost(options: { query?: string; journals?: JournalStore | false; requestTimeoutMs?: number; diagnostics?: ReturnType<typeof createDiagnosticJournal> } = {}) {
  const store = new MemoryJournalStore();
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000, journalRequestTimeoutMs: options.requestTimeoutMs ?? 50, ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.journals === false ? {} : { journals: options.journals ?? store }) });
  close.push(() => broker.close());
  const pairing = await (await broker.handleRequest(new Request('https://relay.example/v1/remote/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), {}))!.json();
  const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host${options.query ?? '?journal=1'}`, { headers: { authorization: `Bearer ${pairing.key}` } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const pair = transportPair();
  const inbox: Wire[] = [];
  pair.native.onMessage(data => { inbox.push(JSON.parse(data)); });
  prepared.accept(pair.server);
  pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'native', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  /** The next message of this type the Relay sent, removed from the inbox. */
  async function take(type: string): Promise<Wire> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const at = inbox.findIndex(message => message.type === type);
      if (at >= 0) return inbox.splice(at, 1)[0]!;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`The Relay sent no ${type}.`);
  }
  const send = (fields: Wire) => pair.native.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
  const host = await take('registered');
  const open = async (publisherId = 'controller-1') => { send({ type: 'journal_open', requestId: `open-${Math.random()}`, sessionKey: SESSION, publisherId }); return take('journal_opened'); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { broker, pair, store, host, inbox, take, send, open, settle, storeKey: `${host.hostId}:${SESSION}` };
}

it('grants journals to a Controller that asked for them when the Relay has a journal store', async () => {
  expect((await connectedHost()).host.journal).toBe(1);
});

it('does not grant journals to a Controller that did not ask, or when the Relay has no store', async () => {
  expect((await connectedHost({ query: '' })).host.journal).toBeUndefined();
  expect((await connectedHost({ journals: false })).host.journal).toBeUndefined();
});

it('closes a Host that sends journal messages the Relay did not acknowledge', async () => {
  for (const options of [{ query: '' }, { journals: false as const }]) {
    const { pair, send, settle } = await connectedHost(options);
    send({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' });
    await settle();
    expect(pair.server.closeCode).toBe(1008);
  }
});

it('closes a Host that sends a message only the Relay may send', async () => {
  const { pair, send, settle } = await connectedHost();
  send({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 1, cursor: { epoch: 'e', seq: 1 } });
  await settle();
  expect(pair.server.closeCode).toBe(1008);
});

it('opens the journal of a session and stores the claim', async () => {
  const { host, open, store, storeKey } = await connectedHost();
  const opened = await open();
  expect(opened).toMatchObject({ uplinkVersion: 2, sessionKey: SESSION, generation: 1, watermark: 0, index: [] });
  expect(typeof opened.epoch).toBe('string');
  expect((await store.load(storeKey))?.meta.publisher).toEqual({ publisherId: 'controller-1', generation: 1, watermark: 0 });
  expect(storeKey.startsWith(`${host.hostId}:`)).toBe(true);
});

it('acknowledges a publication only after the store holds it, and returns the index when the journal is opened again', async () => {
  const { open, send, take, store, storeKey } = await connectedHost();
  const opened = await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: opened.generation, entries: [
    { sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }] });
  const ack = await take('journal_ack');
  expect(ack).toMatchObject({ sessionKey: SESSION, generation: 1, watermark: 2, cursor: { epoch: opened.epoch, seq: 1 } });
  expect((await store.load(storeKey))?.items).toEqual([expect.objectContaining({ itemKey: 'm1', state: 'complete', digest: DIGEST })]);
  const reopened = await open();
  expect(reopened).toMatchObject({ generation: 2, watermark: 2, epoch: opened.epoch,
    index: [expect.objectContaining({ itemKey: 'm1', seqStart: 1, seqEnd: 1, state: 'complete', digest: DIGEST, resident: true })] });
});

it('fences the first generation when the session is opened again', async () => {
  const { open, send, take } = await connectedHost();
  await open();
  await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }] });
  expect(await take('journal_refused')).toMatchObject({ sessionKey: SESSION, generation: 1, sequence: 1, reason: 'fenced' });
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 2, entries: [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }] });
  expect(await take('journal_ack')).toMatchObject({ generation: 2, watermark: 1 });
});

it('acknowledges the entries before a refused one and names the refusal', async () => {
  const { open, send, take, store, storeKey } = await connectedHost();
  await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [
    { sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'ghost', digest: DIGEST },
    { sequence: 3, op: 'append', row: row('m3', 'Never applied') }] });
  expect(await take('journal_ack')).toMatchObject({ watermark: 1 });
  expect(await take('journal_refused')).toMatchObject({ generation: 1, sequence: 2, reason: 'unknown_item', itemKey: 'ghost' });
  expect((await store.load(storeKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
});

it('stores the head a Controller publishes', async () => {
  const { open, send, take, store, storeKey } = await connectedHost();
  await open();
  const snapshot = {
    id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
    pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
  };
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 12 } }] });
  await take('journal_ack');
  expect((await store.load(storeKey))?.meta.head).toEqual({ snapshot, observedAt: 12 });
});

it('keeps the journals of two Hosts apart even for the same session', async () => {
  const shared = new MemoryJournalStore();
  const first = await connectedHost({ journals: shared });
  const second = await connectedHost({ journals: shared });
  expect(first.host.hostId).not.toBe(second.host.hostId);
  const opened = await first.open();
  first.send({ type: 'journal_publish', sessionKey: SESSION, generation: opened.generation, entries: [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }] });
  await first.take('journal_ack');
  expect((await second.open()).index).toEqual([]);
});
it('records a diagnostic when a journal message cannot be encoded and sends nothing', async () => {
  const seeded = new MemoryJournalStore();
  let saved: RelayDiagnostic[] = [];
  const diagnostics = createDiagnosticJournal({ storage: { save: async events => { saved = structuredClone(events); } } });
  close.push(() => diagnostics.close());
  const probe = await connectedHost({ journals: seeded, diagnostics });
  await seeded.apply({ meta: { sessionKey: probe.storeKey, epoch: "epoch-1", nextSeq: 0, minSeq: 1, publisher: null, lastRevision: 0, retiredEpochs: [] }, upsert: [], replaced: true });
  await probe.open();
  probe.send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [{ sequence: 1, op: 'seal', itemKey: 'ghost' }] });
  await probe.take('journal_refused');
  await diagnostics.flush();
  expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'journal_message_unencodable', hostId: probe.host.hostId })]));
  expect(probe.inbox.some(message => message.type === 'journal_ack')).toBe(false);
});

it('records a diagnostic and closes the connection when the journal store fails', async () => {
  const memory = new MemoryJournalStore();
  const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key), apply: async () => { throw new Error('disk full'); } };
  let saved: RelayDiagnostic[] = [];
  const diagnostics = createDiagnosticJournal({ storage: { save: async events => { saved = structuredClone(events); } } });
  close.push(() => diagnostics.close());
  const { pair, send, settle, host } = await connectedHost({ journals: store, diagnostics });
  send({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' });
  await settle();
  await diagnostics.flush();
  expect(pair.server.closeCode).toBe(1011);
  expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'journal_store_failed', hostId: host.hostId })]));
});
