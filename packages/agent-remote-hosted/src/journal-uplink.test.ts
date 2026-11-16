import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import { decodeRemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals, type JournalPublished } from './host-journals.js';
import { createJournalConnection, isJournalHostMessage, JOURNAL_REQUEST_LIMIT, JOURNAL_REQUEST_TIMEOUT_MS, type JournalHostMessage } from './journal-uplink.js';

const SESSION = 'codex:thread-1';
const DIGEST = 'a'.repeat(64);
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text, messageId: itemKey },
});

/** A message as the Relay decodes it from the Host. */
function wire(fields: Record<string, unknown>): JournalHostMessage {
  const decoded = decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, ...fields }));
  if (decoded.status !== 'ok' || !isJournalHostMessage(decoded.value)) throw new Error('Not a journal message from the Host.');
  return decoded.value;
}

type Sent = { type: string; [field: string]: unknown };

function fixture(options: { journals?: HostJournals; diagnostic?(event: 'journal_message_unencodable' | 'journal_store_failed' | 'journal_fanout_failed' | 'journal_quota_exceeded' | 'journal_live_only_dropped'): void; published?(sessionKey: string, result: JournalPublished): void } = {}) {
  const store = new MemoryJournalStore();
  const journals = options.journals ?? createHostJournals({ store });
  const sent: Sent[] = [];
  const timers = new Map<number, { callback(): void; delayMs: number }>();
  let nextTimer = 0, live = true, sendFailure: Error | undefined;
  const connection = createJournalConnection({
    hostId: 'host-1', journals, current: () => live, diagnostic: options.diagnostic, published: options.published,
    send: message => { if (sendFailure) throw sendFailure; sent.push(message as unknown as Sent); },
    scheduler: { setTimeout: (callback, delayMs) => { timers.set(++nextTimer, { callback, delayMs }); return nextTimer; }, clearTimeout: timer => { timers.delete(timer as number); } },
  });
  return {
    connection, store, sent, timers,
    journals,
    endConnection() { live = false; },
    failSends(error: Error) { sendFailure = error; },
    expireOldestTimer() { const [id, timer] = [...timers][0]!; timers.delete(id); timer.callback(); },
    async open() {
      await connection.receive(wire({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' }));
      return sent.at(-1)!;
    },
    publish: (entries: unknown[], generation = 1) => connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries })),
  };
}
const requestIdOf = (sent: Sent[], type: string) => String(sent.find(message => message.type === type)!.requestId);

describe('a journal connection', () => {
  it('hands every stored publication to the broker, also after the connection is no longer current, but not one the connection refuses as not opened', async () => {
    const reported: Array<{ sessionKey: string; events: number; cursorSeq?: number }> = [];
    const f = fixture({ published: (sessionKey, result) => reported.push({ sessionKey, events: result.events.length, cursorSeq: result.cursor?.seq }) });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    f.endConnection();
    await f.publish([{ sequence: 2, op: 'append', row: row('m2', 'World') }]);
    expect(reported).toEqual([{ sessionKey: SESSION, events: 1, cursorSeq: 1 }, { sessionKey: SESSION, events: 1, cursorSeq: 2 }]);
    await f.publish([{ sequence: 3, op: 'append', row: row('m3', 'Fenced') }], 9);
    expect(reported).toHaveLength(2);
  });

  it('does not hand on a publication the journal fenced because a newer connection opened the session', async () => {
    const store = new MemoryJournalStore();
    const journals = createHostJournals({ store });
    const reported: string[] = [];
    const older = fixture({ journals, published: sessionKey => reported.push(sessionKey) });
    const newer = fixture({ journals });
    await older.open();
    await newer.open();
    await older.publish([{ sequence: 1, op: 'append', row: row('m1', 'Stale') }]);
    expect(reported).toEqual([]);
    expect(older.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
    expect(older.sent.some(message => message.type === 'journal_ack')).toBe(false);
  });

  it('does not hand on a publication refused after a failed write until the session is opened again', async () => {
    const memory = new MemoryJournalStore();
    let failNext = false;
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (failNext) { failNext = false; throw new Error('disk full'); } await memory.apply(changes); } };
    const reported: string[] = [];
    const f = fixture({ journals: createHostJournals({ store }), published: sessionKey => reported.push(sessionKey) });
    await f.open();
    failNext = true;
    await expect(f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Lost') }])).rejects.toThrow('disk full');
    await f.publish([{ sequence: 2, op: 'append', row: row('m2', 'Refused') }]);
    expect(reported).toEqual([]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
  });

  it('reports a diagnostic when handing a publication on fails', async () => {
    const events: string[] = [];
    const f = fixture({ published: () => { throw new Error('subscriber failed'); }, diagnostic: event => events.push(event) });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(events).toEqual(['journal_fanout_failed']);
  });

  it('keeps a stored publication acknowledged when the broker fails to hand it on', async () => {
    const f = fixture({ published: () => { throw new Error('subscriber failed'); } });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', watermark: 1 });
  });

  it('answers an open with the generation and watermark', async () => {
    const f = fixture();
    expect(await f.open()).toMatchObject({ type: 'journal_opened', uplinkVersion: 2, requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0 });
    expect(await f.open()).not.toHaveProperty('index');
  });

  it('acknowledges a publication only after the store holds it', async () => {
    const f = fixture();
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
    const epoch = (await f.store.load(`host-1:${SESSION}`))!.meta.epoch;
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 2, cursor: { epoch, seq: 1 } });
    expect((await f.store.load(`host-1:${SESSION}`))?.items).toEqual([expect.objectContaining({ itemKey: 'm1', digest: DIGEST })]);
  });

  it('acknowledges the applied entries and refuses the first one the journal rejects', async () => {
    const f = fixture();
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'ghost', digest: DIGEST }]);
    expect(f.sent.slice(-2)).toMatchObject([
      { type: 'journal_ack', watermark: 1 },
      { type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 2, reason: 'invalid' },
    ]);
  });

  it('refuses a publication for a session this connection did not open', async () => {
    const f = fixture();
    await f.publish([{ sequence: 4, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
    expect(f.sent).toEqual([expect.objectContaining({ type: 'journal_refused', generation: 1, sequence: 4, reason: 'fenced' })]);
    expect(await f.store.load(`host-1:${SESSION}`)).toBeUndefined();
  });

  it('fences the first generation when the session is opened again', async () => {
    const f = fixture();
    await f.open();
    expect(await f.open()).toMatchObject({ type: 'journal_opened', generation: 2 });
    f.sent.length = 0;
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }], 1);
    expect(f.sent).toEqual([expect.objectContaining({ type: 'journal_refused', generation: 1, reason: 'fenced' })]);
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }], 2);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', generation: 2, watermark: 1 });
  });

  it('leaves the session unopened when the service refuses the open', async () => {
    const refusing: HostJournals = { ...createHostJournals({ store: new MemoryJournalStore() }), open: async () => ({ refused: 'unavailable' }) };
    const f = fixture({ journals: refusing });
    expect(await f.open()).toEqual({ uplinkVersion: 2, type: 'journal_open_refused', requestId: 'open-1', sessionKey: SESSION, reason: 'unavailable' });
    expect(f.sent).toHaveLength(1);
    await f.publish([{ sequence: 1, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
  });

  it('does not send a message that fails to encode and reports it', async () => {
    const diagnostics: string[] = [];
    const base = createHostJournals({ store: new MemoryJournalStore() });
    const broken: HostJournals = { ...base, publish: async () => ({ events: [], watermark: -1, cursor: { epoch: 'e', seq: 0 } }) };
    const f = fixture({ journals: broken, diagnostic: message => diagnostics.push(message) });
    await f.open();
    f.sent.length = 0;
    await f.publish([{ sequence: 1, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
    expect(f.sent).toEqual([]);
    expect(diagnostics).toEqual(['journal_message_unencodable']);
  });

  it('lets the journal service ask whether the connection is still current before it claims anything', async () => {
    const store = new MemoryJournalStore();
    const base = createHostJournals({ store });
    const asked: boolean[] = [];
    const journals: HostJournals = { ...base, open: async (hostId, sessionKey, publisherId, options) => { asked.push(options.allowed?.() ?? false); return base.open(hostId, sessionKey, publisherId, options); } };
    const f = fixture({ journals });
    await f.open();
    f.endConnection();
    f.sent.length = 0;
    await f.connection.receive(wire({ type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1' }));
    expect(asked).toEqual([true, false]);
    expect(f.sent).toEqual([]);
    expect((await store.load(`host-1:${SESSION}`))?.meta.publisher?.generation).toBe(1);
  });

  it('reports a publication the journal refused for its limits, and refuses it to the Host', async () => {
    const events: string[] = [];
    const journals = createHostJournals({ store: new MemoryJournalStore(), limits: { sessionBytes: 1 } });
    const f = fixture({ journals, diagnostic: event => events.push(event) });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', sequence: 1, reason: 'quota_exceeded' });
    expect(events).toEqual(['journal_quota_exceeded']);
  });

  it('reports live-only items the journal removed beyond its cap once they are complete', async () => {
    const events: string[] = [];
    const journals = createHostJournals({ store: new MemoryJournalStore(), limits: { liveOnlyItems: 1 } });
    const f = fixture({ journals, diagnostic: event => events.push(event) });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: { ...row('l1', 'a'), liveOnly: true } }, { sequence: 2, op: 'append', row: { ...row('l2', 'b'), liveOnly: true } }]);
    expect(events).toEqual([]);
    await f.publish([{ sequence: 3, op: 'complete', itemKey: 'l1', digest: DIGEST }, { sequence: 4, op: 'complete', itemKey: 'l2', digest: DIGEST }]);
    expect(events).toEqual(['journal_live_only_dropped']);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', watermark: 4 });
  });

  it('clears an opened session when a later open is refused', async () => {
    const store = new MemoryJournalStore();
    const base = createHostJournals({ store });
    let calls = 0;
    const journals: HostJournals = { ...base, open: (hostId, sessionKey, publisherId, options) => base.open(hostId, sessionKey, publisherId, ++calls === 1 ? options : { ...options, allowed: () => false }) };
    const f = fixture({ journals });
    await f.open();
    expect(await f.open()).toMatchObject({ type: 'journal_open_refused' });
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
    expect((await store.load(`host-1:${SESSION}`))?.items).toEqual([]);
  });

  it('refuses the publication of a connection that a newer open fenced, without acknowledging it', async () => {
    const journals = createHostJournals({ store: new MemoryJournalStore() });
    const older = fixture({ journals });
    const newer = fixture({ journals });
    await older.open();
    await newer.open();
    older.sent.length = 0;
    await older.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(older.sent).toEqual([expect.objectContaining({ type: 'journal_refused', generation: 1, reason: 'fenced', sequence: 1 })]);
  });

  it('keeps a fill pending until the journal applied the answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fills = 0;
    const base = createHostJournals({ store: new MemoryJournalStore() });
    const journals: HostJournals = { ...base, fill: async () => { fills += 1; await gate; return { filled: ['m1'], mismatched: [], unknown: [] }; } };
    const f = fixture({ journals });
    const first = f.connection.requestFill(SESSION, ['m1']);
    const requestId = requestIdOf(f.sent, 'journal_fill_request');
    const answer = wire({ type: 'journal_fill', requestId, sessionKey: SESSION, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] });
    const applying = f.connection.receive(answer);
    await expect(f.connection.requestFill(SESSION, ['m2'])).rejects.toMatchObject({ code: 'in_flight' });
    await f.connection.receive(answer);
    expect(fills).toBe(1);
    release();
    await applying;
    await expect(first).resolves.toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
    expect(f.timers.size).toBe(0);
    const second = f.connection.requestFill(SESSION, ['m2']);
    f.connection.close();
    await expect(second).rejects.toMatchObject({ code: 'closed' });
  });

  it('hands the page read of a fill request to the journal, and resolves with the page it read in the same step', async () => {
    const seen: unknown[] = [];
    const base = createHostJournals({ store: new MemoryJournalStore() });
    const journals: HostJournals = { ...base, fill: async (_host, _key, _items, read) => { seen.push(read?.request.requestId, read?.olderBeyondJournal()); return { filled: ['m1'], mismatched: [], unknown: [] }; } };
    const f = fixture({ journals });
    const request = { requestId: 'page-1', agentId: 'agent', direction: 'tail' as const, limit: 10 };
    const pending = f.connection.requestFill(SESSION, ['m1'], { request, olderBeyondJournal: () => true });
    const requestId = requestIdOf(f.sent, 'journal_fill_request');
    await f.connection.receive(wire({ type: 'journal_fill', requestId, sessionKey: SESSION, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] }));
    await expect(pending).resolves.toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
    expect(seen).toEqual(['page-1', true]);
  });

  it('passes on to the broker an open refusal that took the session out of serving, as it does for a publication, even after the connection ended', async () => {
    const reported: Array<{ sessionKey: string; unserved?: true; events: number }> = [];
    const base = createHostJournals({ store: new MemoryJournalStore() });
    const refusing: HostJournals = { ...base, open: async () => ({ refused: 'unavailable', unserved: true }) };
    const f = fixture({ journals: refusing, published: (sessionKey, result) => reported.push({ sessionKey, unserved: result.unserved, events: result.events.length }) });
    expect(await f.open()).toMatchObject({ type: 'journal_open_refused', reason: 'unavailable' });
    expect(reported).toEqual([{ sessionKey: SESSION, unserved: true, events: 0 }]);
    f.endConnection();
    f.sent.length = 0;
    await f.connection.receive(wire({ type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1' }));
    expect(f.sent).toEqual([]);
    expect(reported).toHaveLength(2);
  });

  it('does not report an open refusal that left a session serving as unserved', async () => {
    const reported: unknown[] = [];
    const base = createHostJournals({ store: new MemoryJournalStore() });
    const refusing: HostJournals = { ...base, open: async () => ({ refused: 'unavailable' }) };
    const f = fixture({ journals: refusing, published: (_sessionKey, result) => reported.push(result) });
    await f.open();
    expect(reported).toEqual([]);
  });

  it('reports a quota refusal even when the connection is no longer current, because the journal already left serving', async () => {
    const events: string[] = [];
    const journals = createHostJournals({ store: new MemoryJournalStore(), limits: { sessionBytes: 1 } });
    const f = fixture({ journals, diagnostic: event => events.push(event) });
    await f.open();
    f.endConnection();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(events).toEqual(['journal_quota_exceeded']);
  });

  it('fails a fill that is being applied when the connection closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = createHostJournals({ store: new MemoryJournalStore() });
    const journals: HostJournals = { ...base, fill: async () => { await gate; return { filled: ['m1'], mismatched: [], unknown: [] }; } };
    const f = fixture({ journals });
    const first = f.connection.requestFill(SESSION, ['m1']);
    const applying = f.connection.receive(wire({ type: 'journal_fill', requestId: requestIdOf(f.sent, 'journal_fill_request'), sessionKey: SESSION, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] }));
    f.connection.close();
    await expect(first).rejects.toMatchObject({ code: 'closed' });
    release();
    await applying;
  });

  it('reports a store failure while taking the bodies of a fill and fails the request', async () => {
    const events: string[] = [];
    const base = createHostJournals({ store: new MemoryJournalStore() });
    const journals: HostJournals = { ...base, fill: async () => { throw new Error('disk full'); } };
    const f = fixture({ journals, diagnostic: event => events.push(event) });
    const pending = f.connection.requestFill(SESSION, ['m1']);
    await f.connection.receive(wire({ type: 'journal_fill', requestId: requestIdOf(f.sent, 'journal_fill_request'), sessionKey: SESSION, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] }));
    await expect(pending).rejects.toThrow('disk full');
    expect(events).toEqual(['journal_request', 'journal_store_failed']);
  });

  it('sends nothing once the uplink connection is no longer current', async () => {
    const f = fixture();
    await f.open();
    f.sent.length = 0;
    f.endConnection();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent).toEqual([]);
  });

  describe('requests to the Host', () => {
    it('asks for bodies and resolves with what the journal accepted of the requested items', async () => {
      const f = fixture();
      await f.open();
      await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
      const pending = f.connection.requestFill(SESSION, ['m1']);
      expect(f.sent.at(-1)).toMatchObject({ type: 'journal_fill_request', uplinkVersion: 2, sessionKey: SESSION, itemKeys: ['m1'] });
      expect([...f.timers.values()].map(timer => timer.delayMs)).toEqual([JOURNAL_REQUEST_TIMEOUT_MS]);
      await f.connection.receive(wire({ type: 'journal_fill', requestId: requestIdOf(f.sent, 'journal_fill_request'), sessionKey: SESSION,
        items: [{ row: row('m1', 'Hello'), digest: DIGEST }, { row: row('m9', 'not asked for'), digest: DIGEST }] }));
      await expect(pending).resolves.toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
      expect(f.timers.size).toBe(0);
    });

    it('asks for older history and resolves when the Host says it is done', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 25, 'm1');
      expect(f.sent.at(-1)).toMatchObject({ type: 'journal_older_request', sessionKey: SESSION, beforeItemKey: 'm1', limit: 25 });
      await f.connection.receive(wire({ type: 'journal_older_done', requestId: requestIdOf(f.sent, 'journal_older_request'), sessionKey: SESSION, olderAvailable: false }));
      await expect(pending).resolves.toEqual({ olderAvailable: false });
    });

    it('ignores an answer it did not ask for, or one for another session or kind', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 25, 'm1');
      const requestId = requestIdOf(f.sent, 'journal_older_request');
      await f.connection.receive(wire({ type: 'journal_older_done', requestId: 'unknown', sessionKey: SESSION, olderAvailable: true }));
      await f.connection.receive(wire({ type: 'journal_older_done', requestId, sessionKey: 'codex:other', olderAvailable: true }));
      await f.connection.receive(wire({ type: 'journal_fill', requestId, sessionKey: SESSION, items: [] }));
      expect(f.timers.size).toBe(1);
      f.connection.close();
      await expect(pending).rejects.toMatchObject({ code: 'closed' });
    });

    it('allows one fill and one older read per session, and a bounded number in all', async () => {
      const f = fixture();
      const first = f.connection.requestFill(SESSION, ['m1']);
      await expect(f.connection.requestFill(SESSION, ['m2'])).rejects.toMatchObject({ code: 'in_flight' });
      const older = f.connection.requestOlder(SESSION, 10, 'm1');
      const rest = Array.from({ length: JOURNAL_REQUEST_LIMIT - 2 }, (_, at) => f.connection.requestOlder(`codex:s${at}`, 10, 'm1'));
      await expect(f.connection.requestOlder('codex:one-more', 10, 'm1')).rejects.toMatchObject({ code: 'busy' });
      f.connection.close();
      for (const pending of [first, older, ...rest]) await expect(pending).rejects.toMatchObject({ code: 'closed' });
    });

    it('rejects an unanswered request after the deadline and then accepts a new one', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 10, 'm1');
      f.expireOldestTimer();
      await expect(pending).rejects.toMatchObject({ code: 'timeout' });
      const again = f.connection.requestOlder(SESSION, 10, 'm1');
      f.connection.close();
      await expect(again).rejects.toMatchObject({ code: 'closed' });
    });

    it('rejects invalid requests, requests on a connection that is not current and failed writes', async () => {
      const f = fixture();
      await expect(f.connection.requestFill(SESSION, [])).rejects.toMatchObject({ code: 'invalid' });
      await expect(f.connection.requestFill(SESSION, ['a', 'a'])).rejects.toMatchObject({ code: 'invalid' });
      await expect(f.connection.requestOlder(SESSION, 0, 'm1')).rejects.toMatchObject({ code: 'invalid' });
      f.failSends(new Error('socket closed'));
      await expect(f.connection.requestOlder(SESSION, 10, 'm1')).rejects.toThrow('socket closed');
      expect(f.timers.size).toBe(0);
      f.endConnection();
      await expect(f.connection.requestOlder(SESSION, 10, 'm1')).rejects.toMatchObject({ code: 'unavailable' });
    });
  });
});
