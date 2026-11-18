import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';

import { createHostBroker, createHostJournals, type BrokerRequestContext, type HostBrokerOptions, type HostJournalsOptions, type RelaySocket, type RemoteHostBrokerState } from '../index.js';
import { sequentialEpochs } from '@orchardworks/agent-remote-journal/testing';

export type Wire = Record<string, any>;
export const HOST_ID = 'host';
export const PUBLIC_ID = 'agent';
export const SESSION_KEY = 'codex:native-session';
export const STORE_KEY = `${HOST_ID}:${SESSION_KEY}`;
export const DIGEST = 'a'.repeat(64);

export const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});

export const snapshot = (status: 'idle' | 'running', id: string): AgentSnapshotPayload => ({
  id, providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-session', status },
});

/** A paired Host that is offline, with one bound session; the credential `arc_fixture` is the Host's. */
const savedState = (): RemoteHostBrokerState => ({
  keys: [['7a8ce1c8927a74e75f9bc855677bd2cb361d6b19a58f85296a8777022d022a14', { expires: 20_000, installationId: 'restored-installation' }]],
  hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, smartReading: ['codex'] }],
  bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }],
  creations: [],
});

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until the read returns something; a deadline of two seconds, so a failure names what never happened. */
export async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export function socketPair(closers: Array<() => void | Promise<void>>) {
  class Socket implements RelaySocket {
    readyState = 1; bufferedAmount = 0; closeCode?: number; closeReason?: string; peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void | Promise<void>>(); closes = new Set<() => void>();
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); });
    }
    close(code?: number, reason?: string) {
      // A `ws` socket throws for a close reason longer than 123 bytes of UTF-8.
      if (reason !== undefined && Buffer.byteLength(reason) > 123) throw new RangeError('The close reason must be at most 123 bytes.');
      if (this.readyState !== 1) return;
      this.readyState = 3; this.closeCode = code; this.closeReason = reason;
      for (const listener of this.closes) listener();
      this.peer.close(code, reason);
    }
    onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
    onError() { return () => {}; }
  }
  const server = new Socket(), native = new Socket();
  server.peer = native; native.peer = server;
  closers.push(() => server.close());
  return { server, native };
}

/** Records what arrives on a socket: `all` in order, and `take` to wait for the next message of a kind and remove it. */
export function collect(native: RelaySocket) {
  const all: Wire[] = [];
  const pending: Wire[] = [];
  native.onMessage(data => { const value = JSON.parse(data); all.push(value); pending.push(value); });
  return {
    all,
    take: (match: (message: Wire) => boolean, label: string): Promise<Wire> =>
      until(() => { const at = pending.findIndex(match); return at < 0 ? undefined : pending.splice(at, 1)[0]; }, label),
  };
}

/** A journal of one complete row `m1` ("Hello") under the fixture's session, written straight into the store. */
export async function seedJournal(store: MemoryJournalStore, options: { head?: boolean; evict?: boolean } = {}): Promise<void> {
  const journal = SessionJournal.create(STORE_KEY, 'epoch-1', sequentialEpochs());
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  journal.append(at(), row('m1', 'Hello'));
  journal.complete(at(), 'm1', DIGEST);
  if (options.head !== false) journal.setHead(at(), { snapshot: snapshot('idle', 'native-session'), observedAt: 5 });
  if (options.evict) journal.evict(0);
  await store.apply(journal.takeChanges()!);
}

export interface RelayOptions {
  requestTimeoutMs?: number;
  seed?(store: MemoryJournalStore): Promise<void>;
  /** Broker options that tests vary, such as `ownerSubject` and `userStreamCount`. */
  broker?: Partial<Pick<HostBrokerOptions, 'ownerSubject' | 'userStreamCount' | 'onStateChange' | 'journalDeletionWaitMs' | 'journalDeletionTimeoutMs' | 'diagnostics'>>;
  /** Safety limits of the journal service, for tests of a quota. */
  journalLimits?: HostJournalsOptions['limits'];
  /** Wraps the in-memory store the broker keeps its journals in, for tests of a store that is slow or fails. */
  journalStore?(memory: MemoryJournalStore): JournalStore;
  /** Changes the saved state the broker starts from, for example to share the Host with another user. */
  state?(saved: RemoteHostBrokerState): RemoteHostBrokerState;
}

export async function startRelay(options: RelayOptions = {}) {
  const closers: Array<() => void | Promise<void>> = [];
  const store = new MemoryJournalStore();
  await options.seed?.(store);
  const broker = createHostBroker({ origin: 'https://relay.example', initialState: options.state ? options.state(savedState()) : savedState(), now: () => 10_000, rpcTimeoutMs: 1000,
    ...(options.journalLimits ? { journalService: createHostJournals({ store, limits: options.journalLimits }) } : {}),
    journals: options.journalStore ? options.journalStore(store) : store, journalRequestTimeoutMs: options.requestTimeoutMs ?? 1000, ...options.broker });
  closers.push(() => broker.close());

  /** The Host's Controller, connected with `journal=1` unless `journal` is false. It answers the attach of the session and the streams the Relay opens. */
  async function connectController(behavior: { /** False: a Controller from before session control moved to the Relay, which does not offer it. */ control?: false; journal?: boolean; answerStreams?: boolean; attach?: { status: number; body: unknown }; holdAttach?: boolean; strictNegotiate?: boolean } = {}) {
    const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host${`${behavior.journal === false ? '?' : '?journal=1&'}${behavior.control === false ? 'legacy=1' : 'control=1'}`}`, { headers: { authorization: 'Bearer arc_fixture' } }));
    if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
    const pair = socketPair(closers);
    const inbox = collect(pair.native);
    prepared.accept(pair.server);
    pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    await inbox.take(message => message.type === 'registered', 'registered');
    const send = (fields: Wire) => pair.native.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
    const streams: Array<{ streamId: string; received: Wire[] }> = [];
    const attaches: Wire[] = [];
    const toStream = (streamId: string, fields: Wire) => send({ type: 'stream_message', streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }) });
    const acceptStream = (streamId: string) => send({ type: 'stream_opened', streamId });
    pair.native.onMessage(data => {
      const message = JSON.parse(data);
      if (message.type === 'rpc_request' && message.path === '/remote/attach') {
        attaches.push(message);
        if (behavior.holdAttach) return;
        send({ type: 'rpc_response', requestId: message.requestId, status: behavior.attach?.status ?? 200, body: JSON.stringify(behavior.attach?.body ?? { agentId: PUBLIC_ID, nativeSessionId: 'native-session' }) });
      } else if (message.type === 'stream_open') {
        streams.push({ streamId: message.streamId, received: [] });
        if (behavior.answerStreams !== false) acceptStream(message.streamId);
      } else if (message.type === 'stream_message') {
        const stream = streams.find(item => item.streamId === message.streamId);
        if (!stream) return;
        const inner = JSON.parse(message.message);
        stream.received.push(inner);
        if (inner.type === 'negotiate' && behavior.strictNegotiate && Object.keys(inner).some(field => !['protocolVersion', 'type', 'observation'].includes(field))) {
          // A Controller built before item keys decodes `negotiate` strictly and answers an unknown field with a protocol error.
          toStream(stream.streamId, { type: 'protocol_error', payload: { code: 'invalid_shape', message: 'Unknown field in negotiate.', recoverable: false } });
        } else if (inner.type === 'negotiate') {
          toStream(stream.streamId, { type: 'negotiated' });
          toStream(stream.streamId, { type: 'agent_snapshot', payload: snapshot('running', PUBLIC_ID) });
        } else if (inner.type === 'send_message') {
          toStream(stream.streamId, { type: 'command_acknowledged', payload: { requestId: inner.payload.requestId, agentId: PUBLIC_ID, command: 'send_message', inputAcceptance: { disposition: 'started' } } });
        }
      }
    });
    let generation = 0;
    let sequence = 0;
    /** Opens the session's journal; later publications continue from the watermark it reports. */
    async function open() {
      send({ type: 'journal_open', requestId: `open-${Math.random()}`, sessionKey: SESSION_KEY, publisherId: 'controller-1' });
      const opened = await inbox.take(message => message.type === 'journal_opened', 'journal_opened');
      generation = opened.generation; sequence = opened.watermark;
      return opened;
    }
    /** Publishes entries without their sequence numbers and waits for the acknowledgement. */
    async function publish(entries: Wire[]) {
      const stamped = entries.map(entry => ({ sequence: ++sequence, ...entry }));
      send({ type: 'journal_publish', sessionKey: SESSION_KEY, generation, entries: stamped });
      const watermark = sequence;
      await inbox.take(message => message.type === 'journal_ack' && message.watermark === watermark, 'journal_ack');
    }
    return { pair, inbox, streams, attaches, send, toStream, acceptStream, open, publish, disconnect: () => pair.native.close(1000) };
  }

  /** A browser's per-session stream (`/v1/sessions/:id/events`), as the Relay sees it. */
  async function openBrowser(context: BrokerRequestContext = {}) {
    const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }), context);
    if (!prepared || prepared instanceof Response) throw new Error(`Session stream rejected: ${prepared instanceof Response ? prepared.status : 'not handled'}`);
    const pair = socketPair(closers);
    const inbox = collect(pair.native);
    prepared.accept(pair.server);
    const send = (fields: Wire) => pair.native.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }));
    /** Negotiates and acquires control, as a page does; resolves with the token that grants it. */
    async function controlled(negotiate: Wire | false = {}): Promise<string> {
      if (negotiate) send({ type: 'negotiate', ...negotiate });
      const announced = await inbox.take(message => message.type === 'session_control', 'the control state');
      send({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId: 'acquire', revision: announced.payload.revision, action: 'acquire' } });
      const granted = await inbox.take(message => message.type === 'session_control' && message.payload.requestId === 'acquire', 'control');
      return granted.payload.token;
    }
    return { pair, frames: inbox.all, take: inbox.take, send, controlled };
  }

  return {
    broker, store, closers, connectController, openBrowser,
    async dispose() { for (const close of closers.splice(0).reverse()) await close(); },
  };
}
