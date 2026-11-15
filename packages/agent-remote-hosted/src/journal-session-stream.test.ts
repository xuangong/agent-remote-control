import { bodyFromRow, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { JournalPublished } from './host-journals.js';
import type { HostStream, HostStreamOpener, HostStreamSink } from './journal-host-stream.js';
import { createJournalSessionStream, PENDING_CONTROL_REVISION, type JournalReads } from './journal-session-stream.js';

type Wire = Record<string, any>;
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
const pageRequest = (direction: 'tail' | 'before' | 'after', cursor?: { epoch: string; seq: number }) =>
  message({ type: 'timeline_request', payload: { requestId: `page-${++counter}`, agentId: 'agent', direction, limit: 100, ...(cursor ? { cursor } : {}) } });
const sendMessage = message({ type: 'send_message', payload: { requestId: 'send-1', operationId: OPERATION, agentId: 'agent', text: 'Hi' } });

function fixture(options: { head?: boolean; evictBodies?: boolean; hostOpen?: Error; olderFails?: boolean } = {}) {
  const journal = SessionJournal.create('host-1:codex:thread-1');
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  for (const [key, text] of [['m1', 'Hello'], ['m2', 'World']] as const) { journal.append(at(), row(key, text)); journal.complete(at(), key, DIGEST); }
  if (options.head !== false) journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
  if (options.evictBodies) journal.evict(0);
  let olderBeyondJournal = true;
  const calls = { fill: [] as string[][], older: [] as number[], hostOpens: 0 };
  const reads: JournalReads = {
    status: async () => ({ cursor: journal.cursor, ...(journal.head ? { head: journal.head } : {}) }),
    page: async request => journal.page(request, { olderBeyondJournal }),
    fill: async keys => { calls.fill.push(keys); for (const key of keys) journal.fill(key, bodyFromRow(row(key, key === 'm1' ? 'Hello' : 'World')), DIGEST); },
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
  const client = { readyState: 1, bufferedAmount: 0, send: (data: string) => { sent.push(JSON.parse(data)); }, close: (code?: number, reason?: string) => { closed.push([code, reason]); } };
  const hostWrites: Wire[] = [];
  let sink: HostStreamSink | undefined;
  let hostClosed = false;
  const hostStreams: HostStreamOpener = {
    async open(next) {
      calls.hostOpens += 1;
      if (options.hostOpen) throw options.hostOpen;
      sink = next;
      const stream: HostStream = { send: raw => { hostWrites.push(JSON.parse(raw)); }, close: () => { hostClosed = true; } };
      return stream;
    },
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const scheduler = { setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (timer: unknown) => { timers.delete(timer as number); } };
  const stream = createJournalSessionStream({ publicAgentId: 'agent', client, reads, hostStreams, scheduler });
  const published = (events: JournalPublished['events']): JournalPublished => ({ rows: [], events, watermark: sequence, cursor: journal.cursor });
  return {
    journal, stream, sent, closed, calls, hostWrites, sink: () => sink!, hostClosed: () => hostClosed,
    types: () => sent.map(frame => frame.type),
    runTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    appendLive(itemKey: string, text: string): JournalPublished {
      const stamped = journal.append(at(), row(itemKey, text))!;
      return { ...published([{ kind: 'row', row: stamped }]), rows: [stamped] };
    },
    setHead(status: 'idle' | 'running'): JournalPublished {
      journal.setHead(at(), { snapshot: snapshot(status), observedAt: 6 });
      return published([{ kind: 'head', head: journal.head! }]);
    },
    async negotiated(raw = negotiate) { this.stream.receive(raw); await vi.waitFor(() => expect(this.sent.length).toBeGreaterThanOrEqual(2)); },
  };
}

describe('a journal-served session stream', () => {
  it('answers negotiation from the journal head and opens the Controller stream in the background', async () => {
    const f = fixture();
    f.stream.receive(negotiate);
    await vi.waitFor(() => expect(f.types()).toEqual(['negotiated', 'agent_snapshot', 'session_control']));
    expect(f.sent[0]).toMatchObject({ sessionControl: true });
    expect(f.sent[1]!.payload).toMatchObject({ id: 'agent', status: 'idle', runtimeInfo: { connection: { state: 'restoring' } } });
    expect(f.sent[2]!.payload).toEqual({ agentId: 'agent', revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false });
    await vi.waitFor(() => expect(f.hostWrites).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }]));
  });

  it('requires negotiation first, and closes when the journal has no head any more', async () => {
    const f = fixture();
    f.stream.receive(pageRequest('tail'));
    expect(f.sent).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { code: 'negotiation_required', message: 'Protocol negotiation must be the first message.', recoverable: false } }]);
    expect(f.calls.hostOpens).toBe(0);
    const headless = fixture({ head: false });
    headless.stream.receive(negotiate);
    await vi.waitFor(() => expect(headless.closed).toEqual([[1012, 'Session journal unavailable']]));
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

  it('sends head changes as updates, showing the runtime as restoring until the Controller stream is ready', async () => {
    const f = fixture();
    await f.negotiated();
    await vi.waitFor(() => expect(f.hostWrites).toHaveLength(1));
    f.stream.deliver(f.setHead('running'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { id: 'agent', status: 'running', runtimeInfo: { connection: { state: 'restoring' } } } });
    f.sink().ready();
    await vi.waitFor(() => expect(f.sent.at(-1)!.payload.runtimeInfo.connection).toBeUndefined());
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { id: 'agent', status: 'running' } });
    f.stream.deliver(f.setHead('idle'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { status: 'idle' } });
    expect(f.sent.at(-1)!.payload.runtimeInfo.connection).toBeUndefined();
  });

  it('serves a tail page from the journal, and does not ask the Controller for older history for it', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    const { payload } = f.sent.at(-1)!;
    expect(payload).toMatchObject({ agentId: 'agent', epoch: f.journal.epoch, direction: 'tail', hasOlder: true, hasNewer: false, window: { minSeq: 1, maxSeq: 2, nextSeq: 3 } });
    expect(payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Hello', 'World']);
    expect(f.calls.older).toEqual([]);
  });

  it('asks for missing bodies and answers the page once they are back', async () => {
    const f = fixture({ evictBodies: true });
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.fill).toEqual([['m1', 'm2']]);
    expect(f.sent.at(-1)!.payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Hello', 'World']);
  });

  it('asks for older history when a before page reaches the start of the journal, then answers with what came back', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('before', { epoch: f.journal.epoch, seq: 1 }));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.older).toEqual([100]);
    expect(f.sent.at(-1)!.payload).toMatchObject({ direction: 'before', hasOlder: false });
    expect(f.sent.at(-1)!.payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Before']);
  });

  it('serves the page as the journal holds it when older history cannot be read', async () => {
    const f = fixture({ olderFails: true });
    await f.negotiated();
    f.stream.receive(pageRequest('before', { epoch: f.journal.epoch, seq: 1 }));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.sent.at(-1)!.payload).toMatchObject({ entries: [], hasOlder: true });
  });

  it('drops the read-path frames of the Controller session, forwards the rest and rewrites the pending control revision', async () => {
    const f = fixture();
    await f.negotiated();
    await vi.waitFor(() => expect(f.hostWrites).toHaveLength(1));
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
    f.stream.receive(message({ type: 'session_control_request', payload: { agentId: 'agent', requestId: 'control-1', revision: PENDING_CONTROL_REVISION, action: 'acquire' } }));
    expect(f.hostWrites).toHaveLength(1);
    fromController({ type: 'session_control', payload: { agentId: 'agent', revision: 'rev-1', access: 'read_only', available: true } });
    expect(f.sent.at(-1)).toMatchObject({ type: 'session_control', payload: { revision: 'rev-1' } });
    expect(f.hostWrites.at(-1)).toMatchObject({ type: 'session_control_request', payload: { requestId: 'control-1', revision: 'rev-1', action: 'acquire' } });
    f.stream.receive(message({ type: 'session_control_request', payload: { agentId: 'agent', requestId: 'control-2', revision: 'rev-1', action: 'take_over' } }));
    expect(f.hostWrites.at(-1)).toMatchObject({ payload: { requestId: 'control-2', revision: 'rev-1' } });
  });

  it('holds operations for the Controller stream, behind the Relay\'s own negotiation', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.hostWrites.map(frame => frame.type)).toEqual(['negotiate', 'send_message']));
    expect(f.hostWrites[1]).toMatchObject({ payload: { requestId: 'send-1', agentId: 'agent', text: 'Hi' } });
    expect(f.types().filter(type => type === 'agent_snapshot')).toHaveLength(1);
  });

  it('answers operations with the reason when the Controller stream cannot open, and keeps serving reads', async () => {
    const f = fixture({ hostOpen: Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }) });
    await f.negotiated();
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error',
      payload: { requestId: 'send-1', code: 'host_offline', message: 'The Remote Host is offline.', recoverable: true } }));
    f.stream.receive(pageRequest('tail'));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.closed).toEqual([]);
  });

  const offline = () => Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' });
  const controlRequest = (action: 'acquire' | 'take_over', requestId: string) =>
    message({ type: 'session_control_request', payload: { agentId: 'agent', requestId, revision: PENDING_CONTROL_REVISION, action } });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('answers an acquire with the pending control state while the Host is offline, and keeps the stream open', async () => {
    const f = fixture({ hostOpen: offline() });
    await f.negotiated();
    await vi.waitFor(() => expect(f.calls.hostOpens).toBe(1));
    await settle();
    f.stream.receive(controlRequest('acquire', 'control-1'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'session_control',
      payload: { agentId: 'agent', revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false, requestId: 'control-1' } }));
    expect(f.calls.hostOpens).toBe(2);
    expect(f.types()).not.toContain('protocol_error');
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'host_offline', recoverable: true } }));
    expect(f.closed).toEqual([]);
  });

  it('refuses a take over while the Host is offline', async () => {
    const f = fixture({ hostOpen: offline() });
    await f.negotiated();
    f.stream.receive(controlRequest('take_over', 'control-2'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error',
      payload: { requestId: 'control-2', code: 'host_offline', message: 'The Remote Host is offline.', recoverable: true } }));
  });

  it('refuses an acquire when the Controller stream fails to open for another reason', async () => {
    const f = fixture({ hostOpen: Object.assign(new Error('The session could not be attached.'), { code: 'session_attach_failed' }) });
    await f.negotiated();
    await vi.waitFor(() => expect(f.calls.hostOpens).toBe(1));
    await settle();
    f.stream.receive(controlRequest('acquire', 'control-3'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'control-3', code: 'session_attach_failed', recoverable: true } }));
    expect(f.sent.filter(frame => frame.type === 'session_control' && frame.payload.requestId)).toEqual([]);
    f.stream.hostReturned();
    expect(f.closed).toEqual([]);
  });

  it('closes a stream that waits for the Host when the Host returns, and leaves every other stream alone', async () => {
    const waiting = fixture({ hostOpen: offline() });
    await waiting.negotiated();
    await vi.waitFor(() => expect(waiting.calls.hostOpens).toBe(1));
    await settle();
    waiting.stream.hostReturned();
    expect(waiting.closed).toEqual([[1012, 'Remote Host reconnected']]);
    waiting.stream.hostReturned();
    expect(waiting.closed).toHaveLength(1);

    const connected = fixture();
    await connected.negotiated();
    await vi.waitFor(() => expect(connected.hostWrites).toHaveLength(1));
    connected.stream.hostReturned();
    expect(connected.closed).toEqual([]);

    const observer = fixture();
    observer.stream.receive(message({ type: 'negotiate', observation: 'activity' }));
    await vi.waitFor(() => expect(observer.types()).toEqual(['negotiated', 'agent_activity']));
    observer.stream.hostReturned();
    expect(observer.closed).toEqual([]);

    const left = fixture({ hostOpen: offline() });
    await left.negotiated();
    await vi.waitFor(() => expect(left.calls.hostOpens).toBe(1));
    await settle();
    left.stream.close();
    left.stream.hostReturned();
    expect(left.closed).toEqual([]);
  });

  it('closes the browser stream when the Controller stream ends, and the Controller stream when the browser leaves', async () => {
    const ended = fixture();
    await ended.negotiated();
    await vi.waitFor(() => expect(ended.hostWrites).toHaveLength(1));
    ended.sink().ended(1012, 'Remote Host disconnected');
    expect(ended.closed).toEqual([[1012, 'Remote Host disconnected']]);
    const left = fixture();
    await left.negotiated();
    await vi.waitFor(() => expect(left.hostWrites).toHaveLength(1));
    left.stream.close();
    expect(left.hostClosed()).toBe(true);
    expect(left.closed).toEqual([]);
    left.stream.deliver(left.appendLive('m3', 'ignored'));
    expect(left.sent).toHaveLength(3);
  });

  it('serves an activity observer from the head and the journal cursor, without a Controller stream', async () => {
    const f = fixture();
    f.stream.receive(message({ type: 'negotiate', observation: 'activity' }));
    await vi.waitFor(() => expect(f.types()).toEqual(['negotiated', 'agent_activity']));
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
