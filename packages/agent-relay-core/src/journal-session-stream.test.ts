import { bodyFromRow, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { JournalPublished } from './host-journals.js';
import type { HostStream, HostStreamOpener, HostStreamSink } from './journal-host-stream.js';
import { createJournalSessionStream, type JournalReads } from './journal-session-stream.js';
import { BROKER_MAX_FRAME_BYTES } from './transport.js';
import { sequentialEpochs } from '@orchardworks/agent-remote-journal/testing';

type Wire = Record<string, any>;
/** The stream answers within a few microtask turns, so the check repeats every millisecond instead of vitest's 50 ms. */
const settle = (check: () => void) => vi.waitFor(check, { interval: 1 });
const DIGEST = 'a'.repeat(64);
const OPERATION = '00000000-0000-4000-8000-000000000001';
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const snapshot = (status: 'idle' | 'running' = 'idle'): AgentSnapshotPayload => ({
  id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status },
});
const message = (fields: Wire) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields });
const negotiate = message({ type: 'negotiate' });
let counter = 0;
const pageRequest = (direction: 'tail' | 'before' | 'after', cursor?: { epoch: string; seq: number }, limit = 100) =>
  message({ type: 'timeline_request', payload: { requestId: `page-${++counter}`, agentId: 'agent', direction, limit, ...(cursor ? { cursor } : {}) } });
const sendMessage = (controlToken?: string) => message({ type: 'send_message', ...(controlToken === undefined ? {} : { controlToken }), payload: { requestId: 'send-1', operationId: OPERATION, agentId: 'agent', text: 'Hi' } });
const acquireRequest = (revision: string, requestId = 'control-1') => message({ type: 'session_control_request', payload: { agentId: 'agent', requestId, revision, action: 'acquire' } });

interface FixtureOptions {
  head?: boolean; evictBodies?: boolean; hostOpen?: Error; hostHang?: boolean; olderFails?: boolean;
  /** Extra items after the two default ones. */
  extraRows?: number;
  /** The fill does not bring the bodies back. */
  fillBringsNothing?: boolean;
  pageFails?: Error;
  /** Negotiation reads the journal status, which resolves only when this promise does. */
  statusGate?: Promise<void>;
  /** The fill waits for this promise before it brings bodies back. */
  fillGate?: Promise<void>;
  /** The browser socket's close throws like a WebSocket's for a reason over 123 bytes, or for every close. */
  closeThrows?: 'long reason' | 'always';
  /** What the Controller says when asked who holds the session natively. */
  nativeOwner?: { kind: 'native_cli' | 'controller'; generation: string };
  /** Asking the Controller who holds the session answers only when this promise does. */
  ownerGate?: Promise<void>;
  /** Asking the Controller who holds the session fails with this. */
  ownerFails?: Error;
}

function fixture(options: FixtureOptions = {}) {
  const journal = SessionJournal.create('host-1:codex:thread-1', 'epoch-1', sequentialEpochs());
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  const texts = new Map<string, string>([['m1', 'Hello'], ['m2', 'World']]);
  for (let index = 0; index < (options.extraRows ?? 0); index++) texts.set(`x${index}`, `Extra ${index}`);
  for (const [key, text] of texts) { journal.append(at(), row(key, text)); journal.complete(at(), key, DIGEST); }
  if (options.head !== false) journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
  if (options.evictBodies) journal.evict(0);
  let olderBeyondJournal = true;
  const calls = { fill: [] as string[][], older: [] as number[], pages: [] as Array<{ limit: number }>, hostOpens: 0, ownerReads: 0 };
  const reads: JournalReads = {
    status: async () => {
      const read = { cursor: journal.cursor, ...(journal.head ? { head: journal.head } : {}) };
      await options.statusGate;
      return read;
    },
    page: async request => {
      calls.pages.push({ limit: request.limit });
      if (options.pageFails) throw options.pageFails;
      return journal.page(request, { olderBeyondJournal });
    },
    fill: async (keys, request) => {
      calls.fill.push(keys);
      await options.fillGate;
      if (!options.fillBringsNothing) for (const key of keys) journal.fill(key, bodyFromRow(row(key, texts.get(key)!)), DIGEST);
      return journal.page(request, { olderBeyondJournal });
    },
    older: async limit => {
      calls.older.push(limit);
      if (options.olderFails) throw new Error('The Host is offline.');
      olderBeyondJournal = false;
      journal.prepend(at(), [{ row: row('m0', 'Before'), digest: DIGEST }]);
    },
    olderBeyondJournal: () => olderBeyondJournal,
  };
  const sent: Wire[] = [];
  const closed: Array<[number | undefined, string | undefined]> = [];
  const client = { readyState: 1, bufferedAmount: 0 as number | undefined, send: (data: string) => { sent.push(JSON.parse(data)); }, close: (code?: number, reason?: string) => {
    if (options.closeThrows === 'always' || (options.closeThrows === 'long reason' && Buffer.byteLength(reason ?? '') > 123)) throw new RangeError('The reason must not exceed 123 bytes.');
    closed.push([code, reason]);
  } };
  const hostWrites: Wire[] = [];
  let sink: HostStreamSink | undefined;
  let hostClosed = false;
  const hostStreams: HostStreamOpener = {
    async open(next) {
      calls.hostOpens += 1;
      if (options.hostHang) return new Promise<HostStream>(() => undefined);
      if (options.hostOpen) throw options.hostOpen;
      sink = next;
      const stream: HostStream = { send: raw => { hostWrites.push(JSON.parse(raw)); }, close: () => { hostClosed = true; } };
      return stream;
    },
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const scheduler = { setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (timer: unknown) => { timers.delete(timer as number); } };
  const stream = createJournalSessionStream({ publicAgentId: 'agent', client, reads, hostStreams, scheduler, readNativeOwner: async () => { calls.ownerReads += 1; await options.ownerGate; if (options.ownerFails) throw options.ownerFails; return options.nativeOwner; } });
  const published = (events: JournalPublished['events']): JournalPublished => ({ events, watermark: sequence, cursor: journal.cursor });
  return {
    journal, stream, client, sent, closed, calls, hostWrites, sink: () => sink!, hostClosed: () => hostClosed,
    types: () => sent.map(frame => frame.type),
    runTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    appendLive(itemKey: string, text: string): JournalPublished {
      const stamped = journal.append(at(), row(itemKey, text))!;
      return published([{ kind: 'row', row: stamped }]);
    },
    setHead(status: 'idle' | 'running'): JournalPublished {
      journal.setHead(at(), { snapshot: snapshot(status), observedAt: 6 });
      return published([{ kind: 'head', head: journal.head! }]);
    },
    async negotiated(raw = negotiate) { this.stream.receive(raw); await settle(() => expect(this.sent.length).toBeGreaterThanOrEqual(2)); },
    /** The control state the Relay last sent. */
    control: () => sent.filter(frame => frame.type === 'session_control').at(-1)!.payload as Wire,
    /** The Controller accepts the stream the Relay opened. */
    async accepted() { await settle(() => expect(hostWrites.length).toBeGreaterThanOrEqual(1)); sink!.ready(); },
    /** Negotiates and acquires control; the token that grants it. */
    async controlled(): Promise<string> {
      await this.negotiated();
      this.stream.receive(acquireRequest(this.control().revision));
      await settle(() => expect(this.control().token).toBeDefined());
      return this.control().token;
    },
  };
}

describe('a journal-served session stream', () => {
  it('answers negotiation and control from the Relay, and opens no Controller stream until something is sent', async () => {
    const f = fixture();
    f.stream.receive(negotiate);
    await settle(() => expect(f.types()).toEqual(['negotiated', 'agent_snapshot', 'session_control']));
    expect(f.sent[0]).toMatchObject({ sessionControl: true });
    expect(f.sent[1]!.payload).toMatchObject({ id: 'agent', status: 'idle' });
    expect(f.sent[1]!.payload.runtimeInfo.connection).toBeUndefined();
    expect(f.sent[2]!.payload).toMatchObject({ agentId: 'agent', access: 'read_only', available: true });
    const token = await f.controlled();
    expect(token).toEqual(expect.any(String));
    expect(f.control()).toMatchObject({ access: 'control', available: true, requestId: 'control-1' });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.calls.hostOpens).toBe(0);
    expect(f.hostWrites).toEqual([]);
  });

  it('requires negotiation first, and closes when the journal has no head any more', async () => {
    const f = fixture();
    f.stream.receive(pageRequest('tail'));
    expect(f.sent).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { code: 'negotiation_required', message: 'Protocol negotiation must be the first message.', recoverable: false } }]);
    expect(f.calls.hostOpens).toBe(0);
    const headless = fixture({ head: false });
    headless.stream.receive(negotiate);
    await settle(() => expect(headless.closed).toEqual([[1012, 'Session journal unavailable']]));
    expect(headless.sent).toEqual([]);
  });

  it('acknowledges the subscription before any live row and delivers appended rows with the journal\'s sequences', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.deliver(f.appendLive('m3', 'before the subscription'));
    expect(f.types()).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.stream.deliver(f.appendLive('m3', ' and live'));
    f.stream.deliver(f.appendLive('m4', 'next'));
    expect(f.sent.slice(3).map(frame => frame.type)).toEqual(['timeline_subscribed', 'agent_stream', 'agent_stream']);
    expect(f.sent[3]!.payload).toEqual({ requestId: 'sub-1', agentIds: ['agent'] });
    expect(f.sent.slice(4).map(frame => [frame.payload.epoch, frame.payload.seq, frame.payload.agentId])).toEqual([[f.journal.epoch, 4, 'agent'], [f.journal.epoch, 5, 'agent']]);
    expect(f.sent[4]!.payload.event).toMatchObject({ type: 'timeline', providerId: 'codex', item: { type: 'assistant_message', text: ' and live' } });
  });

  it('announces a replacement to subscribers and ignores rows that nobody subscribed to', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.deliver({ ...f.appendLive('m3', 'x'), events: [{ kind: 'replaced', epoch: 'epoch-2' }] });
    expect(f.sent).toHaveLength(3);
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.stream.deliver({ ...f.appendLive('m4', 'y'), events: [{ kind: 'replaced', epoch: 'epoch-2' }] });
    expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: 'agent', epoch: 'epoch-2' } });
  });

  it('sends head changes as updates, as the Controller published them', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.deliver(f.setHead('running'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { id: 'agent', status: 'running' } });
    f.stream.deliver(f.setHead('idle'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { status: 'idle' } });
    expect(f.sent.at(-1)!.payload.runtimeInfo.connection).toBeUndefined();
  });

  it('serves a tail page from the journal, and does not ask the Controller for older history for it', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await settle(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    const { payload } = f.sent.at(-1)!;
    expect(payload).toMatchObject({ agentId: 'agent', epoch: f.journal.epoch, direction: 'tail', hasOlder: true, hasNewer: false, window: { minSeq: 1, maxSeq: 2, nextSeq: 3 } });
    expect(payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Hello', 'World']);
    expect(f.calls.older).toEqual([]);
  });

  it('asks for missing bodies and answers the page once they are back', async () => {
    const f = fixture({ evictBodies: true });
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await settle(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.fill).toEqual([['m1', 'm2']]);
    expect(f.sent.at(-1)!.payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Hello', 'World']);
  });

  it('asks for older history when a before page reaches the start of the journal, then answers with what came back', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('before', { epoch: f.journal.epoch, seq: 1 }));
    await settle(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.older).toEqual([100]);
    expect(f.sent.at(-1)!.payload).toMatchObject({ direction: 'before', hasOlder: false });
    expect(f.sent.at(-1)!.payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Before']);
  });

  it('serves the page as the journal holds it when older history cannot be read', async () => {
    const f = fixture({ olderFails: true });
    await f.negotiated();
    f.stream.receive(pageRequest('before', { epoch: f.journal.epoch, seq: 1 }));
    await settle(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.sent.at(-1)!.payload).toMatchObject({ entries: [], hasOlder: true });
  });

  it('drops the read-path frames of the Controller session and forwards the rest', async () => {
    const f = fixture();
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await f.accepted();
    await settle(() => expect(f.hostWrites).toHaveLength(2));
    const fromController = (fields: Wire) => f.sink().frame(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }));
    const before = f.sent.length;
    fromController({ type: 'negotiated', sessionControl: true });
    fromController({ type: 'agent_snapshot', payload: snapshot('running') });
    fromController({ type: 'agent_update', payload: snapshot('running') });
    fromController({ type: 'agent_stream', payload: { agentId: 'agent', timestamp: 't', event: { type: 'turn_started', providerId: 'codex' } } });
    fromController({ type: 'timeline_subscribed', payload: { requestId: 'x', agentIds: ['agent'] } });
    expect(f.sent).toHaveLength(before);
    fromController({ type: 'command_acknowledged', payload: { requestId: 'send-1', agentId: 'agent', command: 'send_message' } });
    expect(f.sent.at(-1)).toMatchObject({ type: 'command_acknowledged' });
  });

  it('answers control and refuses a mutation without a live grant itself, never opening the Controller stream', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(sendMessage());
    expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'session_read_only', recoverable: true } });
    const token = await f.controlled();
    f.stream.receive(sendMessage(`${token}x`));
    expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'session_read_only' } });
    expect(f.calls.hostOpens).toBe(0);
  });

  it('holds operations for the Controller stream, behind the Relay\'s own negotiation', async () => {
    const f = fixture();
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await f.accepted();
    await settle(() => expect(f.hostWrites.map(frame => frame.type)).toEqual(['negotiate', 'send_message']));
    expect(f.hostWrites[1]).toMatchObject({ payload: { requestId: 'send-1', agentId: 'agent', text: 'Hi' } });
    expect(f.types().filter(type => type === 'agent_snapshot')).toHaveLength(1);
  });

  const offline = () => Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' });

  it('answers an operation with the reason while the Host is offline, keeps control and reads, and delivers the next one once the Host is back', async () => {
    const f = fixture({ hostOpen: offline() });
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await settle(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error',
      payload: { requestId: 'send-1', code: 'host_offline', message: 'The Remote Host is offline.', recoverable: true } }));
    expect(f.control()).toMatchObject({ access: 'control', token });
    f.stream.receive(pageRequest('tail'));
    await settle(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.closed).toEqual([]);
    f.stream.receive(sendMessage(token));
    await settle(() => expect(f.calls.hostOpens).toBe(2));
    expect(f.closed).toEqual([]);
  });

  it('shows the native owner and revokes control when opening the session is refused for it', async () => {
    const nativeOwner = { kind: 'native_cli', generation: 'g1' };
    const f = fixture({ hostOpen: Object.assign(new Error('A terminal holds it.'), { code: 'native_session_owned', status: 409, nativeOwner }) });
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await settle(() => expect(f.sent.at(-1)).toMatchObject({ type: 'session_control', payload: { access: 'read_only', available: false, nativeOwner } }));
    expect(f.sent.at(-2)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'native_session_owned', recoverable: false } });
    expect(f.control().token).toBeUndefined();
  });

  it('learns the owner after a refusal at delivery, which names none, by asking the Controller once', async () => {
    const nativeOwner = { kind: 'native_cli' as const, generation: 'g2' };
    const f = fixture({ nativeOwner });
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await f.accepted();
    await settle(() => expect(f.hostWrites).toHaveLength(2));
    f.sink().frame(message({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'native_session_owned', message: 'A terminal holds it.', recoverable: true } }));
    expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'native_session_owned' } });
    await settle(() => expect(f.control()).toMatchObject({ access: 'read_only', available: false, nativeOwner }));
    expect(f.calls.ownerReads).toBe(1);
  });

  it('asks who holds the session when the Controller does not accept the stream, and keeps the browser stream', async () => {
    const nativeOwner = { kind: 'native_cli' as const, generation: 'g3' };
    const owned = fixture({ nativeOwner });
    const token = await owned.controlled();
    owned.stream.receive(sendMessage(token));
    await settle(() => expect(owned.hostWrites).toHaveLength(1));
    owned.sink().ended(1011, 'Remote Session restoration failed.');
    await settle(() => expect(owned.control()).toMatchObject({ access: 'read_only', available: false, nativeOwner }));
    expect(owned.sent.find(frame => frame.type === 'protocol_error')).toMatchObject({ payload: { requestId: 'send-1', code: 'native_session_owned', recoverable: false } });
    expect(owned.closed).toEqual([]);
    const unknown = fixture();
    const unknownToken = await unknown.controlled();
    unknown.stream.receive(sendMessage(unknownToken));
    await settle(() => expect(unknown.hostWrites).toHaveLength(1));
    unknown.sink().ended(1011, 'Remote Session restoration failed.');
    await settle(() => expect(unknown.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'host_unavailable', recoverable: true } }));
    expect(unknown.control().access).toBe('control');
    expect(unknown.closed).toEqual([]);
  });

  it('answers only the messages of a stream that was never accepted, and keeps the stream a newer message opened', async () => {
    let answer!: () => void;
    const f = fixture({ ownerGate: new Promise<void>(resolve => { answer = resolve; }) });
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await settle(() => expect(f.calls.hostOpens).toBe(1));
    await settle(() => expect(f.hostWrites).toHaveLength(1));
    const first = f.sink();
    first.ended(1011, 'Remote Session restoration failed.');
    // A newer send arrives while the Controller is still being asked who holds the session.
    f.stream.receive(message({ type: 'send_message', controlToken: token, payload: { requestId: 'send-2', operationId: OPERATION, agentId: 'agent', text: 'Newer' } }));
    await settle(() => expect(f.calls.hostOpens).toBe(2));
    answer();
    await settle(() => expect(f.sent.some(frame => frame.type === 'protocol_error' && frame.payload.requestId === 'send-1')).toBe(true));
    expect(f.sent.some(frame => frame.type === 'protocol_error' && frame.payload.requestId === 'send-2')).toBe(false);
    expect(f.hostClosed()).toBe(false);
    f.sink().ready();
    await settle(() => expect(f.hostWrites.some(frame => frame.type === 'send_message' && frame.payload.requestId === 'send-2')).toBe(true));
  });

  it('answers with the Host being offline when the Host goes away before the Controller accepted the stream', async () => {
    const f = fixture({ ownerFails: Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }) });
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await settle(() => expect(f.hostWrites).toHaveLength(1));
    f.sink().ended(1012, 'Remote Host disconnected');
    await settle(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'host_offline', recoverable: true } }));
  });

  it('keeps the stream open when the Host goes away and comes back with nothing in flight', async () => {
    const f = fixture();
    await f.negotiated();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.closed).toEqual([]);
    expect(f.calls.hostOpens).toBe(0);
  });

  it('closes the browser stream when the Controller stream ends, and the Controller stream when the browser leaves', async () => {
    const ended = fixture();
    const endedToken = await ended.controlled();
    ended.stream.receive(sendMessage(endedToken));
    await ended.accepted();
    await settle(() => expect(ended.hostWrites).toHaveLength(2));
    ended.sink().ended(1012, 'Remote Host disconnected');
    expect(ended.closed).toEqual([[1012, 'Remote Host disconnected']]);
    const left = fixture();
    const leftToken = await left.controlled();
    left.stream.receive(sendMessage(leftToken));
    await left.accepted();
    await settle(() => expect(left.hostWrites).toHaveLength(2));
    left.stream.close();
    expect(left.hostClosed()).toBe(true);
    expect(left.closed).toEqual([]);
    const sentBefore = left.sent.length;
    left.stream.deliver(left.appendLive('m3', 'ignored'));
    expect(left.sent).toHaveLength(sentBefore);
  });

  it('serves an activity observer from the head and the journal cursor, without a Controller stream', async () => {
    const f = fixture();
    f.stream.receive(message({ type: 'negotiate', observation: 'activity' }));
    await settle(() => expect(f.types()).toEqual(['negotiated', 'agent_activity']));
    expect(f.sent[1]!.payload).toEqual({ agentId: 'agent', status: 'idle', cursor: { epoch: f.journal.epoch, seq: 2 } });
    f.stream.deliver(f.appendLive('m3', 'next'));
    expect(f.types()).toHaveLength(2);
    f.runTimers();
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_activity', payload: { status: 'idle', cursor: { seq: 3 } } });
    f.stream.deliver(f.setHead('running'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_activity', payload: { status: 'running' } });
    f.stream.receive(pageRequest('tail'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'activity_only', recoverable: false } });
    expect(f.calls.hostOpens).toBe(0);
  });
});

describe('the reasons a Controller stream cannot open', () => {
  const refusal = (code: string, status?: number, extra: Wire = {}) => Object.assign(new Error(`Refused: ${code}.`), { code, ...(status === undefined ? {} : { status }), ...extra });

  it('refuses the message for a full Controller and keeps the browser stream', async () => {
    const f = fixture({ hostOpen: refusal('session_stream_capacity', 429) });
    const token = await f.controlled();
    f.stream.receive(sendMessage(token));
    await settle(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'session_stream_capacity', recoverable: true } }));
    expect(f.closed).toEqual([]);
  });

  it('cuts a close reason to 123 bytes of whole characters, and survives a socket whose close throws', async () => {
    const long = fixture({ closeThrows: 'long reason' });
    const longToken = await long.controlled();
    long.stream.receive(sendMessage(longToken));
    await long.accepted();
    await settle(() => expect(long.hostWrites).toHaveLength(2));
    long.sink().ended(1012, '\u754c'.repeat(100));
    expect(long.closed).toHaveLength(1);
    expect(Buffer.byteLength(long.closed[0]![1]!)).toBe(123);
    expect(long.closed[0]![1]).toBe('\u754c'.repeat(41));
    const broken = fixture({ closeThrows: 'always' });
    const brokenToken = await broken.controlled();
    broken.stream.receive(sendMessage(brokenToken));
    await broken.accepted();
    await settle(() => expect(broken.hostWrites).toHaveLength(2));
    expect(() => broken.sink().ended(1012, 'Remote Host disconnected')).not.toThrow();
  });

  it('refuses a request that cannot succeed for good, and one that can for a retry', async () => {
    for (const [status, recoverable] of [[503, true], [408, true], [undefined, true], [404, false], [409, false]] as const) {
      const f = fixture({ hostOpen: refusal('session_attach_failed', status) });
      const token = await f.controlled();
      f.stream.receive(sendMessage(token));
      await settle(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', recoverable } }));
      expect(f.closed).toEqual([]);
    }
  });
});

describe('the activity of an observer', () => {
  const observer = async () => {
    const f = fixture();
    f.stream.receive(message({ type: 'negotiate', observation: 'activity' }));
    await settle(() => expect(f.types()).toEqual(['negotiated', 'agent_activity']));
    return f;
  };

  it('sends one update with the latest cursor for several publications within the window', async () => {
    const f = await observer();
    f.stream.deliver(f.appendLive('m3', 'a'));
    f.stream.deliver(f.appendLive('m4', 'b'));
    f.stream.deliver(f.appendLive('m5', 'c'));
    expect(f.sent).toHaveLength(2);
    f.runTimers();
    expect(f.sent).toHaveLength(3);
    expect(f.sent.at(-1)!.payload).toEqual({ agentId: 'agent', status: 'idle', cursor: { epoch: f.journal.epoch, seq: 5 } });
    f.runTimers();
    expect(f.sent).toHaveLength(3);
  });

  it('sends a status change at once, with the cursor of its own publication', async () => {
    const f = await observer();
    const appended = f.appendLive('m3', 'a');
    const changed = f.setHead('running');
    f.stream.deliver({ ...changed, events: [...appended.events, ...changed.events] });
    expect(f.sent.at(-1)!.payload).toEqual({ agentId: 'agent', status: 'running', cursor: { epoch: f.journal.epoch, seq: 3 } });
    const count = f.sent.length;
    f.runTimers();
    expect(f.sent).toHaveLength(count);
  });

  it('sends nothing at once for a burst of rows with heads of the same status, and one update with the latest cursor after the window', async () => {
    const f = await observer();
    for (const key of ['m3', 'm4', 'm5']) {
      const appended = f.appendLive(key, key);
      const same = f.setHead('idle');
      f.stream.deliver({ ...same, events: [...appended.events, ...same.events] });
    }
    expect(f.sent).toHaveLength(2);
    f.runTimers();
    expect(f.sent).toHaveLength(3);
    expect(f.sent.at(-1)!.payload).toEqual({ agentId: 'agent', status: 'idle', cursor: { epoch: f.journal.epoch, seq: 5 } });
  });

  it('waits for the window when a head changes nothing the observer shows', async () => {
    const f = await observer();
    f.stream.deliver(f.setHead('idle'));
    expect(f.sent).toHaveLength(2);
  });
});

describe('a journal-served stream under load', () => {
  it('answers every page failure with the fixed timeline_unavailable error and no raw code', async () => {
    for (const code of ['unavailable', 'in_flight', 'busy', 'timeout', 'store_failed']) {
      const f = fixture({ pageFails: Object.assign(new Error(`internal ${code}`), { code }) });
      await f.negotiated();
      f.stream.receive(pageRequest('tail'));
      await settle(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'timeline_unavailable', recoverable: true } }));
      expect(JSON.stringify(f.sent.at(-1))).not.toContain('internal');
      expect(f.sent.at(-1)!.payload.code).not.toBe(code);
    }
  });

  it('serves a 300-item tail whose bodies are all evicted, in several fill rounds', async () => {
    const f = fixture({ evictBodies: true, extraRows: 298 });
    await f.negotiated();
    f.stream.receive(pageRequest('tail', undefined, 300));
    await settle(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.sent.at(-1)!.payload.entries).toHaveLength(300);
    expect(f.calls.fill.map(keys => keys.length)).toEqual([64, 64, 64, 64, 44]);
  });

  it('stops filling when a round brings nothing back', async () => {
    const f = fixture({ evictBodies: true, fillBringsNothing: true });
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await settle(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'timeline_unavailable' } }));
    expect(f.calls.fill).toHaveLength(1);
  });

  it('asks the Controller for no more bodies once the browser has left', async () => {
    let release!: () => void;
    const f = fixture({ evictBodies: true, extraRows: 298, fillGate: new Promise<void>(resolve => { release = resolve; }) });
    await f.negotiated();
    f.stream.receive(pageRequest('tail', undefined, 300));
    await settle(() => expect(f.calls.fill).toHaveLength(1));
    f.stream.close();
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.calls.fill).toHaveLength(1);
    expect(f.calls.pages).toHaveLength(1);
    expect(f.types()).not.toContain('timeline_page');
  });

  it('caps a requested page at 500 items', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('tail', undefined, 1000));
    await settle(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.pages[0]).toEqual({ limit: 500 });
  });

  it('handles messages that arrive behind negotiate in order, after the Snapshot', async () => {
    const f = fixture();
    f.stream.receive(negotiate);
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.stream.receive(pageRequest('tail'));
    await settle(() => expect(f.types()).toContain('timeline_page'));
    expect(f.types().slice(0, 4)).toEqual(['negotiated', 'agent_snapshot', 'session_control', 'timeline_subscribed']);
    expect(f.types()).not.toContain('protocol_error');
  });

  it('counts held messages against the limit of held messages', async () => {
    const f = fixture({ hostHang: true });
    const token = await f.controlled();
    for (let index = 0; index < 32; index++) f.stream.receive(sendMessage(token));
    expect(f.closed).toEqual([]);
    f.stream.receive(sendMessage(token));
    expect(f.closed).toEqual([[1013, 'Remote stream is not ready']]);
  });

  it('refreshes the head it sent when something was published while negotiation was being answered', async () => {
    let release!: () => void;
    const f = fixture({ statusGate: new Promise<void>(resolve => { release = resolve; }) });
    f.stream.receive(negotiate);
    f.stream.deliver(f.setHead('running'));
    release();
    await settle(() => expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { status: 'running' } }));
    expect(f.types().slice(0, 3)).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
  });

  it('closes a stream whose browser connection cannot keep up', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.client.bufferedAmount = BROKER_MAX_FRAME_BYTES + 1;
    f.stream.deliver(f.appendLive('m3', 'x'));
    expect(f.closed).toEqual([[1013, 'Slow browser connection']]);
  });
});
