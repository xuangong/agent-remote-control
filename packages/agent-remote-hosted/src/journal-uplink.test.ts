import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { decodeRemoteHostUplinkMessage, JOURNAL_INDEX_MAX_ITEMS } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals } from './host-journals.js';
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

function fixture(options: { journals?: HostJournals; diagnostic?(message: string): void } = {}) {
  const store = new MemoryJournalStore();
  const journals = options.journals ?? createHostJournals({ store, now: () => 1_000 });
  const sent: Sent[] = [];
  const timers = new Map<number, { callback(): void; delayMs: number }>();
  let nextTimer = 0, live = true, sendFailure: Error | undefined;
  const connection = createJournalConnection({
    hostId: 'host-1', journals, current: () => live, diagnostic: options.diagnostic,
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
    expect(await f.open()).toMatchObject({ type: 'journal_refused', sessionKey: SESSION, reason: 'invalid' });
    expect(f.sent).toHaveLength(1);
    await f.publish([{ sequence: 1, op: 'seal', itemKey: 'm1' }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
  });

  it('does not send a message that fails to encode and reports it', async () => {
    const diagnostics: string[] = [];
    const base = createHostJournals({ store: new MemoryJournalStore(), now: () => 1 });
    const broken: HostJournals = { ...base, publish: async () => ({ rows: [], watermark: -1, cursor: { epoch: 'e', seq: 0 } }) };
    const f = fixture({ journals: broken, diagnostic: message => diagnostics.push(message) });
    await f.open();
    f.sent.length = 0;
    await f.publish([{ sequence: 1, op: 'seal', itemKey: 'm1' }]);
    expect(f.sent).toEqual([]);
    expect(diagnostics).toEqual([expect.stringContaining('journal_ack')]);
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
