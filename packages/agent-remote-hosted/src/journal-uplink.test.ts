import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage, JOURNAL_INDEX_MAX_ITEMS, JOURNAL_MESSAGE_MAX_BYTES } from '@orchardworks/agent-remote-protocol';
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

function fixture(options: { journals?: HostJournals; diagnostic?(event: 'journal_message_unencodable' | 'journal_store_failed'): void; published?(sessionKey: string, result: JournalPublished): void } = {}) {
  const store = new MemoryJournalStore();
  const journals = options.journals ?? createHostJournals({ store, now: () => 1_000 });
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
  it('hands every stored publication to the broker, also after the connection is no longer current, but not a fenced one', async () => {
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

  it('keeps a stored publication acknowledged when the broker fails to hand it on', async () => {
    const f = fixture({ published: () => { throw new Error('subscriber failed'); } });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', watermark: 1 });
  });

  it('answers an open with the generation, watermark, epoch and index', async () => {
    const f = fixture();
    expect(await f.open()).toMatchObject({ type: 'journal_opened', uplinkVersion: 2, requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0, index: [] });
  });

  it('acknowledges a publication only after the store holds it', async () => {
    const f = fixture();
    const opened = await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 2, cursor: { epoch: opened.epoch, seq: 1 } });
    expect((await f.store.load(`host-1:${SESSION}`))?.items).toEqual([expect.objectContaining({ itemKey: 'm1', digest: DIGEST })]);
  });

  it('acknowledges the applied entries and refuses the first one the journal rejects', async () => {
    const f = fixture();
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'ghost', digest: DIGEST }]);
    expect(f.sent.slice(-2)).toMatchObject([
      { type: 'journal_ack', watermark: 1 },
      { type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 2, reason: 'unknown_item', itemKey: 'ghost' },
    ]);
  });

  it('refuses a publication for a session this connection did not open', async () => {
    const f = fixture();
    await f.publish([{ sequence: 4, op: 'seal', itemKey: 'm1' }]);
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

  it('refuses an open whose reply no single message can carry and leaves the session unopened', async () => {
    const index = Array.from({ length: JOURNAL_INDEX_MAX_ITEMS + 1 }, (_, at) => ({
      itemKey: `i${at}`, seqStart: at, seqEnd: at, state: 'complete' as const, liveOnly: false, revision: 1, resident: true }));
    const huge: HostJournals = { ...createHostJournals({ store: new MemoryJournalStore(), now: () => 1 }),
      open: async (_hostId, _sessionKey, _publisherId, fits) => fits(index, 'e') ? { generation: 1, watermark: 0, epoch: 'e', index } : { refused: 'index_too_large' } };
    const f = fixture({ journals: huge });
    expect(await f.open()).toEqual({ uplinkVersion: 2, type: 'journal_open_refused', requestId: 'open-1', sessionKey: SESSION, reason: 'index_too_large' });
    expect(f.sent).toHaveLength(1);
    await f.publish([{ sequence: 1, op: 'seal', itemKey: 'm1' }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
  });

  it('does not send a message that fails to encode and reports it', async () => {
    const diagnostics: string[] = [];
    const base = createHostJournals({ store: new MemoryJournalStore(), now: () => 1 });
    const broken: HostJournals = { ...base, publish: async () => ({ rows: [], events: [], watermark: -1, cursor: { epoch: 'e', seq: 0 } }) };
    const f = fixture({ journals: broken, diagnostic: message => diagnostics.push(message) });
    await f.open();
    f.sent.length = 0;
    await f.publish([{ sequence: 1, op: 'seal', itemKey: 'm1' }]);
    expect(f.sent).toEqual([]);
    expect(diagnostics).toEqual(['journal_message_unencodable']);
  });

  it('refuses an open whose reply fits only with small numbers, without claiming', async () => {
    const reply = (generation: number, watermark: number, index: unknown[]) =>
      ({ uplinkVersion: 2, type: 'journal_opened', requestId: 'open-1', sessionKey: SESSION, generation, watermark, epoch: 'e', index }) as never;
    const entry = (at: number, keyLength: number) => ({ itemKey: `${at}-`.padEnd(keyLength, 'k'), seqStart: at, seqEnd: at, state: 'complete' as const, liveOnly: false, revision: 1, resident: true });
    const target = JOURNAL_MESSAGE_MAX_BYTES - 5;
    const size = (index: unknown[]) => Buffer.byteLength(JSON.stringify(reply(1, 0, index)));
    const perEntry = size([entry(0, 4000), entry(1, 4000)]) - size([entry(0, 4000)]);
    const index = Array.from({ length: Math.floor((target - size([])) / perEntry) - 4 }, (_, at) => entry(at, 4000));
    while (target - size(index) > 8000) index.push(entry(index.length, 4000));
    // Two padding entries bring the reply with small numbers to exactly five bytes under the limit.
    index.push(entry(index.length, 1));
    index[index.length - 1] = entry(index.length - 1, Math.floor((target - size(index)) / 2));
    const last = index.length;
    index.push(entry(last, `${last}-`.length));
    index[last] = entry(last, `${last}-`.length + target - size(index));
    expect(encodeRemoteHostUplinkMessage(reply(1, 0, index)).status).toBe('ok');
    expect(encodeRemoteHostUplinkMessage(reply(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, index)).status).toBe('rejected');
    const store = new MemoryJournalStore();
    const base = createHostJournals({ store, now: () => 1 });
    const probing: HostJournals = { ...base, open: async (hostId, sessionKey, publisherId, fits) => base.open(hostId, sessionKey, publisherId, (_index, epoch) => fits(index as never, epoch)) };
    const f = fixture({ journals: probing });
    expect(await f.open()).toMatchObject({ type: 'journal_open_refused', requestId: 'open-1', reason: 'index_too_large' });
    expect(await store.load(`host-1:${SESSION}`)).toBeUndefined();
  });

  it('clears an opened session when a later open is refused', async () => {
    const store = new MemoryJournalStore();
    const base = createHostJournals({ store, now: () => 1 });
    let calls = 0;
    const journals: HostJournals = { ...base, open: (hostId, sessionKey, publisherId, fits) => base.open(hostId, sessionKey, publisherId, ++calls === 1 ? fits : () => false) };
    const f = fixture({ journals });
    await f.open();
    expect(await f.open()).toMatchObject({ type: 'journal_open_refused' });
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
    expect((await store.load(`host-1:${SESSION}`))?.items).toEqual([]);
  });

  it('refuses the publication of a connection that a newer open fenced, without acknowledging it', async () => {
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1 });
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
    const base = createHostJournals({ store: new MemoryJournalStore(), now: () => 1 });
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

  it('fails a fill that is being applied when the connection closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = createHostJournals({ store: new MemoryJournalStore(), now: () => 1 });
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
    const base = createHostJournals({ store: new MemoryJournalStore(), now: () => 1 });
    const journals: HostJournals = { ...base, fill: async () => { throw new Error('disk full'); } };
    const f = fixture({ journals, diagnostic: event => events.push(event) });
    const pending = f.connection.requestFill(SESSION, ['m1']);
    await f.connection.receive(wire({ type: 'journal_fill', requestId: requestIdOf(f.sent, 'journal_fill_request'), sessionKey: SESSION, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] }));
    await expect(pending).rejects.toThrow('disk full');
    expect(events).toEqual(['journal_store_failed']);
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
      const pending = f.connection.requestOlder(SESSION, 25);
      expect(f.sent.at(-1)).toMatchObject({ type: 'journal_older_request', sessionKey: SESSION, limit: 25 });
      await f.connection.receive(wire({ type: 'journal_older_done', requestId: requestIdOf(f.sent, 'journal_older_request'), sessionKey: SESSION, olderAvailable: false }));
      await expect(pending).resolves.toEqual({ olderAvailable: false });
    });

    it('ignores an answer it did not ask for, or one for another session or kind', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 25);
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
      const older = f.connection.requestOlder(SESSION, 10);
      const rest = Array.from({ length: JOURNAL_REQUEST_LIMIT - 2 }, (_, at) => f.connection.requestOlder(`codex:s${at}`, 10));
      await expect(f.connection.requestOlder('codex:one-more', 10)).rejects.toMatchObject({ code: 'busy' });
      f.connection.close();
      for (const pending of [first, older, ...rest]) await expect(pending).rejects.toMatchObject({ code: 'closed' });
    });

    it('rejects an unanswered request after the deadline and then accepts a new one', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 10);
      f.expireOldestTimer();
      await expect(pending).rejects.toMatchObject({ code: 'timeout' });
      const again = f.connection.requestOlder(SESSION, 10);
      f.connection.close();
      await expect(again).rejects.toMatchObject({ code: 'closed' });
    });

    it('rejects invalid requests, requests on a connection that is not current and failed writes', async () => {
      const f = fixture();
      await expect(f.connection.requestFill(SESSION, [])).rejects.toMatchObject({ code: 'invalid' });
      await expect(f.connection.requestFill(SESSION, ['a', 'a'])).rejects.toMatchObject({ code: 'invalid' });
      await expect(f.connection.requestOlder(SESSION, 0)).rejects.toMatchObject({ code: 'invalid' });
      f.failSends(new Error('socket closed'));
      await expect(f.connection.requestOlder(SESSION, 10)).rejects.toThrow('socket closed');
      expect(f.timers.size).toBe(0);
      f.endConnection();
      await expect(f.connection.requestOlder(SESSION, 10)).rejects.toMatchObject({ code: 'unavailable' });
    });
  });
});
