import { MemoryJournalStore, SessionJournal, type JournalIndexEntry, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals, type JournalOpened } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const PAGE = { requestId: 'page-1', agentId: 'agent-1', direction: 'tail' as const, limit: 10 };
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string, text: string): JournalPublishEntry => ({ sequence, op: 'append', row: row(itemKey, text) });
const complete = (sequence: number, itemKey: string, digest = `digest-${itemKey}`): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest });
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
};

const fitsAlways = () => true;
const openSession = (journals: HostJournals, hostId: string, sessionKey: string, publisherId: string, fits: (index: JournalIndexEntry[], epoch: string) => boolean = fitsAlways) =>
  journals.open(hostId, sessionKey, publisherId, fits) as Promise<JournalOpened>;

function fixture(store: JournalStore = new MemoryJournalStore()) {
  return { journals: createHostJournals({ store, now: () => 1_000 }), store };
}

describe('createHostJournals', () => {
  it('opens a journal and fences the previous generation on every open', async () => {
    const { journals, store } = fixture();
    const first = await openSession(journals, HOST, SESSION, 'controller-1');
    expect(first).toMatchObject({ generation: 1, watermark: 0, index: [] });
    expect(typeof first.epoch).toBe('string');
    expect((await store.load(KEY))?.meta.publisher).toEqual({ publisherId: 'controller-1', generation: 1, watermark: 0 });
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, epoch: first.epoch });
  });

  it('claims nothing when the reply for the index cannot be sent', async () => {
    const { journals, store } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    expect(await journals.open(HOST, SESSION, 'controller-1', () => false)).toEqual({ refused: 'index_too_large' });
    expect((await store.load(KEY))?.meta.publisher?.generation).toBe(1);
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 1 });
  });

  it('applies a publication in order, stores it before returning and reports the stamped rows', async () => {
    const { journals, store } = fixture();
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    const result = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hel'), append(2, 'm1', 'lo'), complete(3, 'm1'), append(4, 'm2', 'Next')]);
    expect(result.refusal).toBeUndefined();
    expect(result.rows.map(({ itemKey, seq }) => [itemKey, seq])).toEqual([['m1', 1], ['m1', 2], ['m2', 3]]);
    expect(result).toMatchObject({ watermark: 4, cursor: { epoch: opened.epoch, seq: 3 } });
    const saved = await store.load(KEY);
    expect(saved?.meta.publisher?.watermark).toBe(4);
    expect(saved?.items.map(({ itemKey, state }) => [itemKey, state])).toEqual([['m1', 'complete'], ['m2', 'open']]);
    expect((await openSession(journals, HOST, SESSION, 'controller-1')).index.map(({ itemKey }) => itemKey)).toEqual(['m1', 'm2']);
  });

  it('acknowledges a publication it already applied without changing the journal', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    const again = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    expect(again).toMatchObject({ rows: [], watermark: 1, cursor: { seq: 1 } });
    expect(again.refusal).toBeUndefined();
  });

  it('stops at the first refused entry and keeps and acknowledges the ones before it', async () => {
    const { journals, store } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const result = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'One'), complete(2, 'ghost'), append(3, 'm3', 'Three')]);
    expect(result.rows.map(({ itemKey }) => itemKey)).toEqual(['m1']);
    expect(result).toMatchObject({ watermark: 1, refusal: { sequence: 2, reason: 'unknown_item', itemKey: 'ghost' } });
    expect((await store.load(KEY))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('names the reason of every refusal the journal can raise', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')]);
    const refusal = async (entry: JournalPublishEntry) => (await journals.publish(HOST, SESSION, 1, [entry])).refusal;
    expect(await refusal({ sequence: 3, op: 'correct', row: row('m1', 'Hello!'), digest: 'd', expectedRevision: 99 })).toEqual({ sequence: 3, reason: 'stale_revision', itemKey: 'm1' });
    expect(await refusal(complete(3, 'ghost'))).toEqual({ sequence: 3, reason: 'unknown_item', itemKey: 'ghost' });
    expect(await refusal({ sequence: 3, op: 'append', row: { ...row('m1', 'x'), item: { type: 'reasoning', text: 'x' } } })).toEqual({ sequence: 3, reason: 'type_changed', itemKey: 'm1' });
    expect(await refusal({ sequence: 3, op: 'replace', items: [{ row: row('a', 'x'), digest: 'd1' }, { row: row('a', 'y'), digest: 'd2' }] })).toEqual({ sequence: 3, reason: 'duplicate_item', itemKey: 'a' });
    expect(await refusal({ sequence: 3, op: 'append', row: { ...row('m2', 'x'), occurredAt: Number.NaN } })).toEqual({ sequence: 3, reason: 'invalid', itemKey: 'm2' });
  });

  it('refuses an append to an item whose body was evicted', async () => {
    const store = new MemoryJournalStore();
    const seeded = SessionJournal.create(KEY);
    const { generation } = seeded.claim('controller-1');
    const publication = (sequence: number) => ({ publisherId: 'controller-1', generation, sequence });
    seeded.append(publication(1), row('m1', 'Hello'));
    seeded.complete(publication(2), 'm1', 'digest-m1');
    seeded.evict(0);
    await store.apply(seeded.takeChanges()!);
    const { journals } = fixture(store);
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    expect(opened).toMatchObject({ generation: 2, watermark: 2, index: [expect.objectContaining({ itemKey: 'm1', resident: false })] });
    const result = await journals.publish(HOST, SESSION, 2, [append(3, 'm1', 'more')]);
    expect(result.refusal).toEqual({ sequence: 3, reason: 'body_missing', itemKey: 'm1' });
  });

  it('refuses a fenced generation and a session that was never opened, without changing anything', async () => {
    const { journals, store } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await openSession(journals, HOST, SESSION, 'controller-1');
    const stale = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hi')]);
    expect(stale).toMatchObject({ rows: [], refusal: { sequence: 1, reason: 'fenced' } });
    expect((await store.load(KEY))?.items).toEqual([]);
    const unopened = await journals.publish(HOST, 'codex:unknown', 1, [append(5, 'm1', 'Hi')]);
    expect(unopened).toEqual({ rows: [], watermark: 0, refusal: { sequence: 5, reason: 'fenced' } });
    expect(await store.load(`${HOST}:codex:unknown`)).toBeUndefined();
  });

  it('stores the head and reports the new epoch of a replacement', async () => {
    const { journals, store } = fixture();
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Old'), complete(2, 'm1')]);
    const result = await journals.publish(HOST, SESSION, 1, [
      { sequence: 3, op: 'head', head: { snapshot, observedAt: 7 } },
      { sequence: 4, op: 'replace', items: [{ row: row('x1', 'Fresh'), digest: 'digest-x1' }] },
    ]);
    expect(result.replacedEpoch).toBeDefined();
    expect(result.replacedEpoch).not.toBe(opened.epoch);
    expect(result.cursor).toEqual({ epoch: result.replacedEpoch, seq: 1 });
    const saved = await store.load(KEY);
    expect(saved?.meta.head).toEqual({ snapshot, observedAt: 7 });
    expect(saved?.items.map(({ itemKey }) => itemKey)).toEqual(['x1']);
  });

  it('does not return before the store holds the changes', async () => {
    const memory = new MemoryJournalStore();
    let hold = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (hold) await gate; await memory.apply(changes); } };
    const { journals } = fixture(store);
    await openSession(journals, HOST, SESSION, 'controller-1');
    hold = true;
    let settled = false;
    const published = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect((await memory.load(KEY))?.items).toEqual([]);
    release();
    expect((await published).watermark).toBe(1);
    expect((await memory.load(KEY))?.items).toHaveLength(1);
  });

  it('reloads the stored state after a failed write and propagates the failure', async () => {
    const memory = new MemoryJournalStore();
    let failing = false;
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (failing) throw new Error('disk full'); await memory.apply(changes); } };
    const { journals } = fixture(store);
    await openSession(journals, HOST, SESSION, 'controller-1');
    failing = true;
    await expect(journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')])).rejects.toThrow('disk full');
    failing = false;
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 0, index: [] });
  });

  it('serializes the work of one Host in call order', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const results = await Promise.all([
      journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')]),
      journals.publish(HOST, SESSION, 1, [append(2, 'm2', 'b')]),
      journals.publish(HOST, SESSION, 1, [append(3, 'm3', 'c')]),
    ]);
    expect(results.map(result => result.watermark)).toEqual([1, 2, 3]);
    expect(results.map(result => result.rows[0]?.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the journals of different Hosts apart and survives forgetting a Host', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await openSession(journals, 'host-2', SESSION, 'controller-2');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    expect((await openSession(journals, 'host-2', SESSION, 'controller-2')).index).toEqual([]);
    await journals.forget(HOST);
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 1, index: [expect.objectContaining({ itemKey: 'm1' })] });
  });

  it('puts bodies back only when their digest matches the recorded one', async () => {
    const store = new MemoryJournalStore();
    const seeded = SessionJournal.create(KEY);
    const { generation } = seeded.claim('controller-1');
    const publication = (sequence: number) => ({ publisherId: 'controller-1', generation, sequence });
    seeded.append(publication(1), row('m1', 'Hello'));
    seeded.complete(publication(2), 'm1', 'digest-m1');
    seeded.evict(0);
    await store.apply(seeded.takeChanges()!);
    const { journals } = fixture(store);
    expect(await journals.fill(HOST, SESSION, [{ row: row('m1', 'Hello'), digest: 'other' }])).toEqual({ filled: [], mismatched: ['m1'], unknown: [] });
    expect(await journals.fill(HOST, SESSION, [{ row: row('m1', 'Hello'), digest: 'digest-m1' }])).toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
    expect(await journals.fill(HOST, SESSION, [{ row: row('ghost', 'x'), digest: 'd' }])).toEqual({ filled: [], mismatched: [], unknown: ['ghost'] });
    expect(await journals.fill(HOST, 'codex:none', [{ row: row('m1', 'x'), digest: 'd' }])).toEqual({ filled: [], mismatched: [], unknown: ['m1'] });
    expect((await store.load(KEY))?.items[0]?.body).not.toBeNull();
  });

  it('serves pages and reports a missing journal', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    const tail = await journals.page(HOST, SESSION, PAGE, false);
    expect(tail?.kind).toBe('page');
    if (tail?.kind === 'page') expect(tail.page.payload.entries).toHaveLength(1);
    expect(await journals.page(HOST, 'codex:none', PAGE, false)).toBeUndefined();
  });

  it('drops the cached journal and propagates an unexpected error, leaving the stored state', async () => {
    const store = new MemoryJournalStore();
    const seeded = SessionJournal.create(KEY);
    seeded.claim('controller-1');
    const changes = seeded.takeChanges()!;
    await store.apply({ ...changes, meta: { ...changes.meta, minSeq: Number.MIN_SAFE_INTEGER + 1 } });
    const { journals } = fixture(store);
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    expect(opened).toMatchObject({ generation: 2, watermark: 0 });
    await expect(journals.publish(HOST, SESSION, 2, [
      append(1, 'm1', 'Hello'),
      { sequence: 2, op: 'prepend', items: [{ row: row('o1', 'a'), digest: 'd1' }, { row: row('o2', 'b'), digest: 'd2' }] },
    ])).rejects.toThrow();
    const saved = await store.load(KEY);
    expect(saved?.items).toEqual([]);
    expect(saved?.meta.publisher?.watermark).toBe(0);
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 3, watermark: 0, index: [] });
  });

  it('runs the calls queued behind one that failed', async () => {
    const memory = new MemoryJournalStore();
    let failures = 1;
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (failures-- > 0) throw new Error('disk full'); await memory.apply(changes); } };
    const { journals } = fixture(store);
    const first = journals.open(HOST, SESSION, 'controller-1', fitsAlways);
    const second = journals.open(HOST, SESSION, 'controller-1', fitsAlways);
    await expect(first).rejects.toThrow('disk full');
    expect(await second).toMatchObject({ generation: 1 });
  });

  it('does not let one Host waiting on its store hold up another Host', async () => {
    const memory = new MemoryJournalStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (changes.meta.sessionKey.startsWith(`${HOST}:`)) await gate; await memory.apply(changes); } };
    const { journals } = fixture(store);
    const blocked = journals.open(HOST, SESSION, 'controller-1', fitsAlways);
    expect(await openSession(journals, 'host-2', SESSION, 'controller-2')).toMatchObject({ generation: 1 });
    release();
    expect(await blocked).toMatchObject({ generation: 1 });
  });
});
