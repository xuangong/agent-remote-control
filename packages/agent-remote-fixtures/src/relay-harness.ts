import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { createHostBroker, type RelaySocket, type RemoteHostBrokerState } from '@orchardworks/agent-relay-core';

import type { Direction, PlayerPeer } from './transcript.js';
import { sequentialEpochs } from '@orchardworks/agent-remote-journal/testing';

export type Wire = Record<string, any>;
export const HOST_ID = 'host';
export const PUBLIC_ID = 'agent';
export const SESSION_KEY = 'codex:native-session';
export const STORE_KEY = `${HOST_ID}:${SESSION_KEY}`;
/** The epoch of a journal written straight into the store; UUID-shaped, as the Relay's own epochs are, so transcripts normalize it the same way. */
const SEEDED_EPOCH = '5eed0000-0000-4000-8000-000000000001';
export const DIGEST = 'a'.repeat(64);
export const OPERATION = '00000000-0000-4000-8000-000000000001';
export const TERMINAL_OWNER = { kind: 'native_cli', generation: '11111111-1111-4111-8111-111111111111' };

/** A complete assistant message as the journal holds it. */
export const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});

export const snapshot = (status: 'idle' | 'running', id: string): AgentSnapshotPayload => ({
  id, providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-session', status },
});

/** A paired Host with one bound session; the credential `arc_fixture` is the Host's. */
const savedState = (): RemoteHostBrokerState => ({
  keys: [['7a8ce1c8927a74e75f9bc855677bd2cb361d6b19a58f85296a8777022d022a14', { expires: 20_000, installationId: 'restored-installation' }]],
  hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, smartReading: ['codex'] }],
  bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }],
  creations: [],
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until the read returns something; a deadline of two seconds, so a failure names what never happened. */
export async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** A tap sees each frame as it is sent; returning false drops the frame, as a lost connection does. */
type Tap = (direction: 'toPeer' | 'toRelay', json: string) => void | boolean;

/** Two connected in-memory sockets: `server` is the Relay's end, `native` the peer's. A tap sees every frame at the moment it is sent. */
export function socketPair(closers: Array<() => void | Promise<void>>, tap?: Tap) {
  class Socket implements RelaySocket {
    readyState = 1; bufferedAmount = 0; peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void | Promise<void>>(); closes = new Set<(details?: { code?: number; wasClean?: boolean }) => void>();
    readonly direction: 'toPeer' | 'toRelay';
    constructor(direction: 'toPeer' | 'toRelay') { this.direction = direction; }
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      if (tap?.(this.direction, data) === false) return;
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); });
    }
    close(code?: number, reason?: string) {
      if (this.readyState !== 1) return;
      this.readyState = 3;
      for (const listener of this.closes) listener({ code, wasClean: true });
      this.peer.close(code, reason);
    }
    onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    onClose(listener: (details?: { code?: number; wasClean?: boolean }) => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
    onError() { return () => {}; }
  }
  const server = new Socket('toPeer'), native = new Socket('toRelay');
  server.peer = native; native.peer = server;
  closers.push(() => server.close());
  return { server, native };
}

/** Everything that arrives on a socket, in order, and `take` to wait for the next message of a kind and remove it. */
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

export interface FrameRecorder { frame(direction: Direction, json: string): void }

/**
 * The real Relay (the hosted broker over an in-memory journal store), a Host's Controller driven frame by frame, and browser streams.
 * Every frame of a browser stream goes to `recorder`; the Controller's own frames are scenery for the browser scenarios.
 */
export async function startRelay(options: { seed?: boolean; recorder?: FrameRecorder } = {}) {
  const closers: Array<() => void | Promise<void>> = [];
  const store = new MemoryJournalStore();
  if (options.seed) await seedJournal(store);
  const broker = createHostBroker({ origin: 'https://relay.example', initialState: savedState(), now: () => 10_000, rpcTimeoutMs: 1000, journals: store, journalRequestTimeoutMs: 1000 });
  closers.push(() => broker.close());

  /** The Host's Controller, connected with the journal and session control capabilities. It answers the attach of the session and the streams the Relay opens. */
  async function connectController(behavior: { attach?: { status: number; body: unknown } } = {}) {
    const prepared = await broker.prepareUpgrade(new Request('https://relay.example/ws/remote-host?journal=1&control=1', { headers: { authorization: 'Bearer arc_fixture' } }));
    if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
    const pair = socketPair(closers);
    const inbox = collect(pair.native);
    prepared.accept(pair.server);
    pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    await inbox.take(message => message.type === 'registered', 'registered');
    const send = (fields: Wire) => pair.native.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
    const toStream = (streamId: string, fields: Wire) => send({ type: 'stream_message', streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }) });
    const streams: Array<{ streamId: string; received: Wire[] }> = [];
    pair.native.onMessage(data => {
      const message = JSON.parse(data);
      if (message.type === 'rpc_request' && message.path === '/remote/attach') {
        send({ type: 'rpc_response', requestId: message.requestId, status: behavior.attach?.status ?? 200, body: JSON.stringify(behavior.attach?.body ?? { agentId: PUBLIC_ID, nativeSessionId: 'native-session' }) });
      } else if (message.type === 'stream_open') {
        streams.push({ streamId: message.streamId, received: [] });
        send({ type: 'stream_opened', streamId: message.streamId });
      } else if (message.type === 'stream_message') {
        const stream = streams.find(item => item.streamId === message.streamId);
        if (!stream) return;
        const inner = JSON.parse(message.message);
        stream.received.push(inner);
        if (inner.type === 'negotiate') {
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
      send({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION_KEY, publisherId: 'controller-1' });
      const opened = await inbox.take(message => message.type === 'journal_opened', 'journal_opened');
      generation = opened.generation; sequence = opened.watermark;
    }
    /** Publishes entries without their sequence numbers and waits for the acknowledgement. */
    async function publish(entries: Wire[]) {
      const stamped = entries.map(entry => ({ sequence: ++sequence, ...entry }));
      send({ type: 'journal_publish', sessionKey: SESSION_KEY, generation, entries: stamped });
      const watermark = sequence;
      await inbox.take(message => message.type === 'journal_ack' && message.watermark === watermark, 'journal_ack');
    }
    return { open, publish, disconnect: () => pair.native.close(1000) };
  }

  /** A browser's per-session stream (`/v1/sessions/:id/events`), as the Relay sees it. */
  async function openBrowser() {
    const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }));
    if (!prepared || prepared instanceof Response) throw new Error(`Session stream rejected: ${prepared instanceof Response ? prepared.status : 'not handled'}`);
    const pair = socketPair(closers, (direction, json) => options.recorder?.frame(direction === 'toRelay' ? 'browser->relay' : 'relay->browser', json));
    const inbox = collect(pair.native);
    prepared.accept(pair.server);
    const send = (fields: Wire) => pair.native.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }));
    const peer: PlayerPeer = { send: json => pair.native.send(json), next: () => inbox.take(() => true, 'the next frame from the Relay') };
    return { pair, frames: inbox.all, take: inbox.take, send, peer };
  }

  return {
    store, connectController, openBrowser,
    async epoch(): Promise<string> { return (await store.load(STORE_KEY))!.meta.epoch; },
    async dispose() { for (const close of closers.splice(0).reverse()) await close(); },
  };
}
export type Relay = Awaited<ReturnType<typeof startRelay>>;

/** A journal of one complete row `m1` ("Hello") under the fixture's session, written straight into the store. */
export async function seedJournal(store: MemoryJournalStore): Promise<void> {
  const journal = SessionJournal.create(STORE_KEY, SEEDED_EPOCH, sequentialEpochs());
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  journal.append(at(), row('m1', 'Hello'));
  journal.complete(at(), 'm1', DIGEST);
  journal.setHead(at(), { snapshot: snapshot('idle', 'native-session'), observedAt: 5 });
  await store.apply(journal.takeChanges()!);
}
