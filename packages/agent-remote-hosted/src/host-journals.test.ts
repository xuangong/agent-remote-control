import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals, type JournalOpenOptions, type JournalOpened } from './host-journals.js';

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

const LIMITS: JournalOpenOptions = { maxIndexItems: 1_000_000, pageItems: 1_000_000 };
const openSession = (journals: HostJournals, hostId: string, sessionKey: string, publisherId: string, options: JournalOpenOptions = LIMITS) =>
  journals.open(hostId, sessionKey, publisherId, options) as Promise<JournalOpened>;

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

  it('claims nothing when the index is larger than the Relay may send', async () => {
    const { journals, store } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 0, pageItems: 10 })).toEqual({ refused: 'index_too_large' });
    expect((await store.load(KEY))?.meta.publisher?.generation).toBe(1);
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 1 });
  });

  it('applies a publication in order, stores it before returning and reports the stamped rows', async () => {
    const { journals, store } = fixture();
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    const result = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hel'), append(2, 'm1', 'lo'), complete(3, 'm1'), append(4, 'm2', 'Next')]);
    expect(result.refusal).toBeUndefined();
    expect(result.events.map(event => event.kind === 'row' ? [event.row.itemKey, event.row.seq] : event.kind)).toEqual([['m1', 1], ['m1', 2], ['m2', 3]]);
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
    expect(again).toMatchObject({ events: [], watermark: 1, cursor: { seq: 1 } });
    expect(again.refusal).toBeUndefined();
  });

  it('stops at the first refused entry and keeps and acknowledges the ones before it', async () => {
    const { journals, store } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const result = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'One'), complete(2, 'ghost'), append(3, 'm3', 'Three')]);
    expect(result.events.map(event => event.kind === 'row' ? event.row.itemKey : event.kind)).toEqual(['m1']);
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
    expect(await refusal(complete(9, 'm1'))).toEqual({ sequence: 9, reason: 'sequence_gap' });
  });

  it('refuses entries that need a later journal grant and keeps the journal as it was', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')]);
    const binding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' as const };
    const needsGrantTwo: JournalPublishEntry[] = [
      { sequence: 3, op: 'rebind', itemKey: 'm1', previous: binding, replacement: { ...binding, status: 'available' } },
      { sequence: 3, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 },
      { sequence: 3, op: 'correct', row: row('m1', 'Hello!'), expectedRevision: 2 },
      { sequence: 3, op: 'replace', items: [{ row: row('m1', 'Hello!') }] },
      { sequence: 3, op: 'head', head: { snapshot, observedAt: 1, attentionItemKey: 'm1' } },
    ];
    for (const entry of needsGrantTwo) {
      const published = await journals.publish(HOST, SESSION, 1, [entry]);
      expect(published.refusal).toEqual({ sequence: 3, reason: 'invalid' });
      expect(published.watermark).toBe(2);
    }
  });

  it('refuses an operation it does not know instead of skipping it, and the watermark stays before it', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const result = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), { sequence: 2, op: 'from-a-newer-version' } as unknown as JournalPublishEntry, append(3, 'm2', 'World')]);
    expect(result).toMatchObject({ watermark: 1, refusal: { sequence: 2, reason: 'invalid' } });
    expect((await journals.page(HOST, SESSION, { requestId: 'p', agentId: 'a', direction: 'tail', limit: 10 }, false))).toMatchObject({ page: { payload: { entries: [{ item: { text: 'Hello' } }] } } });
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
    expect(stale).toMatchObject({ events: [], refusal: { sequence: 1, reason: 'fenced' } });
    expect((await store.load(KEY))?.items).toEqual([]);
    const unopened = await journals.publish(HOST, 'codex:unknown', 1, [append(5, 'm1', 'Hi')]);
    expect(unopened).toEqual({ events: [], watermark: 0, refusal: { sequence: 5, reason: 'fenced' } });
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
    const replaced = result.events.find(event => event.kind === 'replaced');
    expect(replaced).toBeDefined();
    expect(replaced?.kind === 'replaced' && replaced.epoch).not.toBe(opened.epoch);
    expect(result.cursor).toEqual({ epoch: replaced?.kind === 'replaced' ? replaced.epoch : undefined, seq: 1 });
    const saved = await store.load(KEY);
    expect(saved?.meta.head).toEqual({ snapshot, observedAt: 7 });
    expect(saved?.items.map(({ itemKey }) => itemKey)).toEqual(['x1']);
  });

  it('lists what subscribers see, in order: appended rows, replacements and new heads, but no corrections or prepends', async () => {
    const { journals, store } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const first = await journals.publish(HOST, SESSION, 1, [
      append(1, 'm1', 'Hello'), complete(2, 'm1'),
      { sequence: 3, op: 'head', head: { snapshot, observedAt: 5 } }, append(4, 'm2', 'World'),
    ]);
    expect(first.events).toEqual([
      { kind: 'row', row: expect.objectContaining({ itemKey: 'm1', seq: 1 }) },
      { kind: 'head', head: { snapshot, observedAt: 5 } },
      { kind: 'row', row: expect.objectContaining({ itemKey: 'm2', seq: 2 }) },
    ]);
    const revision = (await store.load(KEY))!.items.find(item => item.itemKey === 'm1')!.revision;
    const second = await journals.publish(HOST, SESSION, 1, [
      { sequence: 5, op: 'correct', row: row('m1', 'Hello!'), digest: 'digest-new', expectedRevision: revision },
      { sequence: 6, op: 'prepend', items: [{ row: row('m0', 'Earlier'), digest: 'digest-m0' }] },
    ]);
    expect(second.events).toEqual([]);
    const third = await journals.publish(HOST, SESSION, 1, [{ sequence: 7, op: 'replace', items: [{ row: row('x1', 'Fresh'), digest: 'digest-x1' }] }]);
    expect(third.events).toEqual([{ kind: 'replaced', epoch: third.cursor!.epoch }]);
  });

  it('delivers rows of both epochs around a replacement in order, and nothing for a replacement it already applied', async () => {
    const { journals } = fixture();
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    const entries: JournalPublishEntry[] = [
      append(1, 'm1', 'Old'), { sequence: 2, op: 'replace', items: [{ row: row('x1', 'Fresh'), digest: 'digest-x1' }] }, append(3, 'x2', 'New'),
    ];
    const result = await journals.publish(HOST, SESSION, 1, entries);
    const epoch = result.cursor!.epoch;
    expect(epoch).not.toBe(opened.epoch);
    expect(result.events).toEqual([
      { kind: 'row', row: expect.objectContaining({ itemKey: 'm1', epoch: opened.epoch }) },
      { kind: 'replaced', epoch },
      { kind: 'row', row: expect.objectContaining({ itemKey: 'x2', epoch }) },
    ]);
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toEqual([]);
  });

  it('reports a status that includes a publication still being stored', async () => {
    const memory = new MemoryJournalStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let gated = false;
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (gated) await gate; await memory.apply(changes); } };
    const { journals } = fixture(store);
    await openSession(journals, HOST, SESSION, 'controller-1');
    gated = true;
    const publishing = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    let reported = false;
    const status = journals.status(HOST, SESSION).then(value => { reported = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reported).toBe(false);
    release();
    await publishing;
    expect((await status)?.cursor.seq).toBe(1);
  });

  it('does not report a head of a publication it already applied', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const entries: JournalPublishEntry[] = [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }];
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toHaveLength(1);
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toEqual([]);
  });

  it('reports the cursor and head of a session, and nothing for a session without a journal', async () => {
    const { journals } = fixture();
    expect(await journals.status(HOST, SESSION)).toBeUndefined();
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    expect(await journals.status(HOST, SESSION)).toEqual({ cursor: { epoch: opened.epoch, seq: 0 } });
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), { sequence: 2, op: 'head', head: { snapshot, observedAt: 5 } }]);
    expect(await journals.status(HOST, SESSION)).toEqual({ cursor: { epoch: opened.epoch, seq: 1 }, head: { snapshot, observedAt: 5 } });
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
    expect(results.map(result => result.events[0]?.kind === 'row' ? result.events[0].row.seq : undefined)).toEqual([1, 2, 3]);
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
    const first = journals.open(HOST, SESSION, 'controller-1', LIMITS);
    const second = journals.open(HOST, SESSION, 'controller-1', LIMITS);
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
    const blocked = journals.open(HOST, SESSION, 'controller-1', LIMITS);
    expect(await openSession(journals, 'host-2', SESSION, 'controller-2')).toMatchObject({ generation: 1 });
    release();
    expect(await blocked).toMatchObject({ generation: 1 });
  });

  it('refuses publications queued behind a failed write until the session is opened again', async () => {
    const memory = new MemoryJournalStore();
    let failNext = false;
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (failNext) { failNext = false; throw new Error('disk full'); } await memory.apply(changes); } };
    const { journals } = fixture(store);
    await openSession(journals, HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Stored')]);
    failNext = true;
    const first = journals.publish(HOST, SESSION, 1, [append(2, 'm2', 'Lost')]);
    const second = journals.publish(HOST, SESSION, 1, [append(3, 'm3', 'Would skip m2')]);
    await expect(first).rejects.toThrow('disk full');
    expect(await second).toEqual({ events: [], watermark: 0, refusal: { sequence: 3, reason: 'fenced' } });
    expect((await memory.load(KEY))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
    expect((await memory.load(KEY))?.meta.publisher?.watermark).toBe(1);
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 1 });
    expect(await journals.publish(HOST, SESSION, 2, [append(2, 'm2', 'Again')])).toMatchObject({ watermark: 2 });
  });

  it('refuses publications queued behind one whose journal could not be loaded, until the session is opened again', async () => {
    const memory = new MemoryJournalStore();
    const seeded = SessionJournal.create(KEY);
    const { generation } = seeded.claim('controller-1');
    seeded.append({ publisherId: 'controller-1', generation, sequence: 1 }, row('m1', 'Stored'));
    seeded.complete({ publisherId: 'controller-1', generation, sequence: 2 }, 'm1', 'digest-m1');
    seeded.evict(0);
    await memory.apply(seeded.takeChanges()!);
    let failWrite = false, failLoad = false;
    const store: JournalStore = { delete: key => memory.delete(key),
      load: async key => { if (failLoad) { failLoad = false; throw new Error('store unavailable'); } return memory.load(key); },
      apply: async changes => { if (failWrite) { failWrite = false; throw new Error('disk full'); } await memory.apply(changes); } };
    const { journals } = fixture(store);
    await openSession(journals, HOST, SESSION, 'controller-1');
    failWrite = true;
    await expect(journals.fill(HOST, SESSION, [{ row: row('m1', 'Stored'), digest: 'digest-m1' }])).rejects.toThrow('disk full');
    failLoad = true;
    const first = journals.publish(HOST, SESSION, 2, [append(3, 'm3', 'Lost')]);
    const second = journals.publish(HOST, SESSION, 2, [append(4, 'm4', 'Would skip m3')]);
    await expect(first).rejects.toThrow('store unavailable');
    expect(await second).toEqual({ events: [], watermark: 0, refusal: { sequence: 4, reason: 'fenced' } });
    expect((await memory.load(KEY))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
    expect(await openSession(journals, HOST, SESSION, 'controller-1')).toMatchObject({ generation: 3, watermark: 2 });
    expect(await journals.publish(HOST, SESSION, 3, [append(3, 'm3', 'Again')])).toMatchObject({ watermark: 3 });
  });
});
