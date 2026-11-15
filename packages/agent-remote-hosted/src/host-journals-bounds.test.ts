import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalOpened } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const LIMITS = { maxIndexItems: 1_000_000, pageItems: 1_000_000 };
const rowOf = (itemKey: string, text: string, turn = 1) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId: `turn-${turn}`,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string, text: string, turn = 1): JournalPublishEntry => ({ sequence, op: 'append', row: rowOf(itemKey, text, turn) });
const live = (sequence: number, itemKey: string, text = 'live'): JournalPublishEntry => ({ sequence, op: 'append', row: { ...rowOf(itemKey, text, 0), liveOnly: true } });
const complete = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
};
const head = (sequence: number): JournalPublishEntry => ({ sequence, op: 'head', head: { snapshot, observedAt: 5 } });

/** A store that counts how often a journal and a listing are read from it, and can hold a listing back after it was read, so the reader holds a listing that later changes make stale. */
function countingStore() {
  const memory = new MemoryJournalStore();
  const loads: string[] = [];
  const lists: string[] = [];
  let gate: Promise<void> | undefined;
  const store: JournalStore = {
    load: key => { loads.push(key); return memory.load(key); }, apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: async prefix => { lists.push(prefix); const listing = await memory.catalog.list(prefix); await gate; return listing; }, deletePrefix: prefix => memory.catalog.deletePrefix(prefix) },
  };
  return { store, memory, loads, lists, holdLists: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return () => { gate = undefined; release(); }; } };
}

function fixture(options: Partial<Omit<HostJournalsOptions, 'store'>> & { store?: JournalStore } = {}) {
  const counted = countingStore();
  const store = options.store ?? counted.store;
  return { ...counted, store, journals: createHostJournals({ now: () => 1_000, ...options, store }) };
}
const open = (journals: HostJournals, hostId: string, sessionKey: string, publisherId = 'controller-1') =>
  journals.open(hostId, sessionKey, publisherId, LIMITS) as Promise<JournalOpened>;
const resident = async (store: JournalStore, key = KEY) => (await store.load(key))!.items.map(item => [item.itemKey, item.body !== null] as const);

describe('the journal cache', () => {
  it('keeps at most the configured number of journals and reads an evicted one from the store again', async () => {
    const { journals, loads } = fixture({ cache: { maxJournals: 2 } });
    for (const session of ['codex:s1', 'codex:s2', 'codex:s3']) await open(journals, HOST, session);
    expect(loads).toHaveLength(3);
    await journals.status(HOST, 'codex:s1');
    expect(loads).toHaveLength(4);
    await journals.status(HOST, 'codex:s3');
    expect(loads).toHaveLength(4);
  });

  it('keeps no more than the configured size, apart from the journal in use', async () => {
    const { journals, loads } = fixture({ cache: { maxBytes: 1 } });
    await open(journals, HOST, 'codex:s1');
    await open(journals, HOST, 'codex:s2');
    expect(loads).toHaveLength(2);
    expect(loads).toHaveLength(2);
    await journals.status(HOST, 'codex:s2');
    expect(loads).toHaveLength(2);
    await journals.status(HOST, 'codex:s1');
    expect(loads).toHaveLength(3);
  });

  it('rejects limits that are not whole numbers', () => {
    expect(() => createHostJournals({ store: new MemoryJournalStore(), now: () => 1, limits: { sessionBytes: 1.5 } })).toThrow(RangeError);
    expect(() => createHostJournals({ store: new MemoryJournalStore(), now: () => 1, cache: { maxJournals: -1 } })).toThrow(RangeError);
  });
});

describe('the safety limits', () => {
  it('evicts bodies to make room for a row, and refuses a row that still does not fit', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    const big = 'x'.repeat(2000);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1), complete(2, 'm1')])).refusal).toBeUndefined();
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm2', big, 2)])).refusal).toBeUndefined();
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
    const refused = await journals.publish(HOST, SESSION, 1, [append(4, 'm3', big, 3)]);
    expect(refused.refusal).toEqual({ sequence: 4, reason: 'quota_exceeded' });
    expect(refused.events).toEqual([]);
  });

  it('refuses an entry larger than the room before it evicts anything', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'small', 1), complete(2, 'm1'), append(3, 'm2', 'small', 2)]);
    const refused = await journals.publish(HOST, SESSION, 1, [append(4, 'm3', 'x'.repeat(4000), 3)]);
    expect(refused.refusal).toEqual({ sequence: 4, reason: 'quota_exceeded' });
    expect(await resident(store)).toEqual([['m1', true], ['m2', true]]);
  });

  it('refuses a new item beyond the item limit but lets an item that exists grow', async () => {
    const { journals } = fixture({ limits: { sessionItems: 2 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b')]);
    const grown = await journals.publish(HOST, SESSION, 1, [append(3, 'm1', 'more')]);
    expect(grown.refusal).toBeUndefined();
    expect(grown.events).toHaveLength(1);
    expect((await journals.publish(HOST, SESSION, 1, [append(4, 'm3', 'c')])).refusal).toEqual({ sequence: 4, reason: 'quota_exceeded' });
  });

  it('refuses growth of a Host over its quota without touching another Host', async () => {
    const { journals } = fixture({ limits: { hostBytes: 6000 } });
    const big = 'x'.repeat(3000);
    await open(journals, HOST, 'codex:s1');
    await open(journals, HOST, 'codex:s2');
    await open(journals, 'host-2', 'codex:s1', 'controller-2');
    expect((await journals.publish(HOST, 'codex:s1', 1, [append(1, 'm1', big)])).refusal).toBeUndefined();
    expect((await journals.publish(HOST, 'codex:s2', 1, [append(1, 'm1', big)])).refusal).toEqual({ sequence: 1, reason: 'quota_exceeded' });
    expect((await journals.publish('host-2', 'codex:s1', 1, [append(1, 'm1', big)])).refusal).toBeUndefined();
  });

  it('measures appended, corrected and prepended rows in UTF-8 bytes', async () => {
    const wide = '字'.repeat(1100);
    const narrow = 'x'.repeat(1100);
    const limits = { sessionBytes: 3500 };
    const appended = fixture({ limits });
    await open(appended.journals, HOST, SESSION);
    expect((await appended.journals.publish(HOST, SESSION, 1, [append(1, 'm1', wide)])).refusal).toEqual({ sequence: 1, reason: 'quota_exceeded' });
    const appendedNarrow = fixture({ limits });
    await open(appendedNarrow.journals, HOST, SESSION);
    expect((await appendedNarrow.journals.publish(HOST, SESSION, 1, [append(1, 'm1', narrow)])).refusal).toBeUndefined();

    const corrected = fixture({ limits });
    await open(corrected.journals, HOST, SESSION);
    await corrected.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'small'), complete(2, 'm1')]);
    const revision = (await corrected.store.load(KEY))!.items[0]!.revision;
    const correct = (text: string): JournalPublishEntry => ({ sequence: 3, op: 'correct', row: rowOf('m1', text), digest: 'digest-m1b', expectedRevision: revision });
    expect((await corrected.journals.publish(HOST, SESSION, 1, [correct(wide)])).refusal).toEqual({ sequence: 3, reason: 'quota_exceeded' });
    const correctedNarrow = fixture({ limits });
    await open(correctedNarrow.journals, HOST, SESSION);
    await correctedNarrow.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'small'), complete(2, 'm1')]);
    expect((await correctedNarrow.journals.publish(HOST, SESSION, 1, [correct(narrow)])).refusal).toBeUndefined();

    const prepend = (text: string): JournalPublishEntry => ({ sequence: 1, op: 'prepend', items: [{ row: rowOf('m0', text, 0), digest: 'digest-m0' }] });
    const prepended = fixture({ limits });
    await open(prepended.journals, HOST, SESSION);
    expect((await prepended.journals.publish(HOST, SESSION, 1, [prepend(wide)])).refusal).toEqual({ sequence: 1, reason: 'quota_exceeded' });
    const prependedNarrow = fixture({ limits });
    await open(prependedNarrow.journals, HOST, SESSION);
    expect((await prependedNarrow.journals.publish(HOST, SESSION, 1, [prepend(narrow)])).refusal).toBeUndefined();
  });

  it('evicts bodies of the session to make room under the Host quota before it refuses', async () => {
    const { journals, store } = fixture({ limits: { hostBytes: 3500 } });
    await open(journals, HOST, SESSION);
    const big = 'x'.repeat(2000);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1), complete(2, 'm1')]);
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm2', big, 2)])).refusal).toBeUndefined();
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
    expect((await journals.publish(HOST, SESSION, 1, [append(4, 'm3', big, 3)])).refusal).toEqual({ sequence: 4, reason: 'quota_exceeded' });
  });

  it('counts the open items a replacement seals as well as the live-only items it carries', async () => {
    const { journals } = fixture({ limits: { sessionItems: 3 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [live(1, 'l1', 'live'), append(2, 'o1', 'open', 1)]);
    const reread = (...keys: string[]): JournalPublishEntry => ({ sequence: 3, op: 'replace', items: keys.map(key => ({ row: rowOf(key, key), digest: `digest-${key}` })) });
    expect((await journals.publish(HOST, SESSION, 1, [reread('a', 'b')])).refusal).toEqual({ sequence: 3, reason: 'quota_exceeded' });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 2, [reread('a')])).refusal).toBeUndefined();
  });

  it('counts the size of the open items a replacement seals', async () => {
    const { journals } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'o1', 'x'.repeat(2000), 1)]);
    const reread = (sequence: number, text: string): JournalPublishEntry => ({ sequence, op: 'replace', items: [{ row: rowOf('a', text), digest: 'digest-a' }] });
    expect((await journals.publish(HOST, SESSION, 1, [reread(2, 'y'.repeat(1500))])).refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 2, [reread(2, 'y'.repeat(100))])).refusal).toBeUndefined();
  });

  it('does not count a publication of a fenced generation against the limits', async () => {
    const { journals } = fixture({ limits: { sessionItems: 0 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 9, [append(1, 'm1', 'a')])).refusal).toEqual({ sequence: 1, reason: 'fenced' });
  });

  it('admits a replacement by its own size and the live-only items it carries, without evicting first', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    const big = 'x'.repeat(2000);
    await journals.publish(HOST, SESSION, 1, [live(1, 'l1', big)]);
    const tooBig = await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'replace', items: [{ row: rowOf('m1', big), digest: 'digest-m1' }] }]);
    expect(tooBig.refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l1']);
    await open(journals, HOST, SESSION);
    const fits = await journals.publish(HOST, SESSION, 2, [{ sequence: 2, op: 'replace', items: [{ row: rowOf('m1', 'small'), digest: 'digest-m1' }] }]);
    expect(fits.refusal).toBeUndefined();
    expect((await store.load(KEY))!.items.map(item => item.itemKey).sort()).toEqual(['l1', 'm1']);
  });

  it('refuses an open whose index is over the item bound, before claiming anything, and sends the index a page at a time', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b'), append(3, 'm3', 'c')]);
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 })).toEqual({ refused: 'index_too_large' });
    expect((await store.load(KEY))?.meta.publisher?.generation).toBe(1);
    const first = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 10, pageItems: 2 }) as JournalOpened;
    expect(first).toMatchObject({ generation: 2, more: true });
    expect(first.index.map(entry => entry.itemKey)).toEqual(['m1', 'm2']);
    const after = first.index.at(-1)!.seqStart;
    expect((await journals.indexPage(HOST, SESSION, first.epoch, after, 10))!.map(entry => entry.itemKey)).toEqual(['m3']);
    expect(await journals.indexPage(HOST, SESSION, first.epoch, 100, 10)).toEqual([]);
    expect(await journals.indexPage(HOST, 'codex:none', first.epoch, 0, 10)).toBeUndefined();
  });

  it('takes a served session out of serving when its index is over the bound, because its publisher is locked out', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b'), head(3)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 1, pageItems: 1 })).toEqual({ refused: 'index_too_large', unserved: true });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await store.load(KEY))?.meta.head).toBeUndefined();
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect(await restarted.servedSessions(HOST)).toEqual([]);
  });

  it('answers a page of a big index from a snapshot and stays correct when the journal changes between pages', async () => {
    const { journals } = fixture();
    const opened = await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, Array.from({ length: 50 }, (_, at) => append(at + 1, `m${at}`, 'a', at)));
    const seen: string[] = [];
    let after = -Infinity;
    for (;;) {
      const page = (await journals.indexPage(HOST, SESSION, opened.epoch, after, 7))!;
      if (page.length === 0) break;
      seen.push(...page.map(entry => entry.itemKey));
      after = page.at(-1)!.seqStart;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, at) => `m${at}`));
  });

  it('refuses an index page for an epoch a replacement ended', async () => {
    const { journals } = fixture();
    const opened = await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')]);
    expect(await journals.indexPage(HOST, SESSION, opened.epoch, 0, 10)).toHaveLength(1);
    await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'replace', items: [{ row: rowOf('m9', 'fresh'), digest: 'digest-m9' }] }]);
    expect(await journals.indexPage(HOST, SESSION, opened.epoch, 0, 10)).toBeUndefined();
  });
});

describe('a quota refusal and the live-only cap', () => {
  it('takes the session out of serving, persisted, and serves it again only after a replacement and a head from a reopened publisher', async () => {
    const { journals, store } = fixture({ limits: { sessionItems: 1 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)])).hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const refused = await journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'b')]);
    expect(refused).toMatchObject({ refusal: { sequence: 3, reason: 'quota_exceeded' }, unserved: true, hasHead: false });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await store.load(KEY))?.meta.head).toBeUndefined();
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect(await restarted.servedSessions(HOST)).toEqual([]);
    const reopened = await open(restarted, HOST, SESSION);
    expect(reopened.generation).toBe(2);
    const rebuilt = await restarted.publish(HOST, SESSION, 2, [{ sequence: 3, op: 'replace', items: [{ row: rowOf('m1', 'a'), digest: 'digest-m1' }] }, head(4)]);
    expect(rebuilt).toMatchObject({ hasHead: true });
    expect(rebuilt.refusal).toBeUndefined();
    expect(rebuilt.unserved).toBeUndefined();
    expect(restarted.served(HOST, SESSION)).toBe(true);
  });

  it('refuses everything the generation publishes after a quota refusal, so a head cannot serve a journal with a hole', async () => {
    const { journals } = fixture({ limits: { sessionItems: 1 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'b')])).refusal).toEqual({ sequence: 3, reason: 'quota_exceeded' });
    const later = await journals.publish(HOST, SESSION, 1, [head(4)]);
    expect(later.refusal).toEqual({ sequence: 4, reason: 'quota_exceeded' });
    expect(later.hasHead).toBeUndefined();
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await journals.publish(HOST, SESSION, 1, [append(4, 'm1', 'more')])).refusal).toEqual({ sequence: 4, reason: 'quota_exceeded' });
  });

  it('refuses the head of an incomplete journal on its own, without fencing the reopened generation, and accepts the replacement that follows', async () => {
    const { journals, store } = fixture({ limits: { sessionItems: 1 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'b')])).refusal).toEqual({ sequence: 3, reason: 'quota_exceeded' });
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect((await open(restarted, HOST, SESSION)).generation).toBe(2);
    const early = await restarted.publish(HOST, SESSION, 2, [head(3)]);
    expect(early.refusal).toEqual({ sequence: 3, reason: 'incomplete' });
    expect(early.unserved).toBeUndefined();
    expect(restarted.served(HOST, SESSION)).toBe(false);
    const rebuilt = await restarted.publish(HOST, SESSION, 2, [{ sequence: 3, op: 'replace', items: [{ row: rowOf('m1', 'a'), digest: 'digest-m1' }] }, head(4)]);
    expect(rebuilt.refusal).toBeUndefined();
    expect(rebuilt.hasHead).toBe(true);
    expect(restarted.served(HOST, SESSION)).toBe(true);
  });

  it('forgets the fence of a deleted Host, so the fresh generation 1 of the same Host id publishes', async () => {
    const { journals } = fixture({ limits: { sessionItems: 1 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')]);
    expect((await journals.publish(HOST, SESSION, 1, [append(2, 'm2', 'b')])).refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
    await journals.deleteHost(HOST);
    expect((await open(journals, HOST, SESSION)).generation).toBe(1);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')])).refusal).toBeUndefined();
  });

  it('does not serve a journal that lost a row before it had a head, until a replacement rebuilds it', async () => {
    const { journals } = fixture({ limits: { sessionItems: 1 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b')]);
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 2, [head(3)])).refusal).toEqual({ sequence: 3, reason: 'incomplete' });
    expect(journals.served(HOST, SESSION)).toBe(false);
  });

  it('does not report a session without a head as taken out of serving', async () => {
    const { journals } = fixture({ limits: { sessionItems: 0 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')])).unserved).toBeUndefined();
  });

  it('removes the oldest complete live-only items beyond the cap, with their bodies, and reports how many', async () => {
    const { journals, store } = fixture({ limits: { liveOnlyItems: 2 } });
    await open(journals, HOST, SESSION);
    const result = await journals.publish(HOST, SESSION, 1, [live(1, 'l1'), live(2, 'l2'), live(3, 'l3'), complete(4, 'l1'), complete(5, 'l2'), complete(6, 'l3'), append(7, 'm1', 'kept', 1)]);
    expect(result.droppedLiveOnly).toBe(1);
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l2', 'l3', 'm1']);
    expect((await journals.publish(HOST, SESSION, 1, [append(8, 'm1', 'more', 1)])).droppedLiveOnly).toBeUndefined();
  });

  it('never removes an open live-only item, so the count may stay above the cap, and removes the excess when an item completes', async () => {
    const { journals, store } = fixture({ limits: { liveOnlyItems: 2 } });
    await open(journals, HOST, SESSION);
    const open3 = await journals.publish(HOST, SESSION, 1, [live(1, 'l1'), live(2, 'l2'), live(3, 'l3'), append(4, 'm1', 'kept', 1)]);
    expect(open3.droppedLiveOnly).toBeUndefined();
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l1', 'l2', 'l3', 'm1']);
    const completed = await journals.publish(HOST, SESSION, 1, [complete(5, 'l1')]);
    expect(completed.droppedLiveOnly).toBe(1);
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l2', 'l3', 'm1']);
  });

  it('measures a replacement in UTF-8 bytes, so a three-byte character counts three times against the session budget', async () => {
    const { journals } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    const replace = (sequence: number, text: string): JournalPublishEntry => ({ sequence, op: 'replace', items: [{ row: rowOf('m1', text), digest: 'digest-m1' }] });
    expect((await journals.publish(HOST, SESSION, 1, [replace(1, 'x'.repeat(1100))])).refusal).toBeUndefined();
    expect((await journals.publish(HOST, SESSION, 1, [replace(2, '字'.repeat(1100))])).refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
  });
});

describe('retention', () => {
  const turn = (sequence: number, n: number): JournalPublishEntry[] => [append(sequence, `m${n}`, `text ${n}`, n), complete(sequence + 1, `m${n}`)];

  it('evicts bodies outside the latest turns after a publication and keeps live-only items', async () => {
    const { journals, store } = fixture({ retention: { turns: 2, minItems: 0 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [live(1, 'l0'), complete(2, 'l0'), ...turn(3, 1), ...turn(5, 2), ...turn(7, 3), ...turn(9, 4)]);
    expect(await resident(store)).toEqual([['l0', true], ['m1', false], ['m2', false], ['m3', true], ['m4', true]]);
    await journals.publish(HOST, SESSION, 1, turn(11, 5));
    expect(await resident(store)).toEqual([['l0', true], ['m1', false], ['m2', false], ['m3', false], ['m4', true], ['m5', true]]);
  });

  it('does not evict for a publication the journal did not apply', async () => {
    const { journals, store } = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [...turn(1, 1)]);
    await journals.publish(HOST, SESSION, 1, [...turn(3, 2)]);
    const before = await resident(store);
    await journals.publish(HOST, SESSION, 9, turn(5, 3));
    expect(await resident(store)).toEqual(before);
  });
});

describe('retention across fills and reloads', () => {
  const turn = (sequence: number, n: number): JournalPublishEntry[] => [append(sequence, `m${n}`, `text ${n}`, n), complete(sequence + 1, `m${n}`)];
  const item = (n: number) => ({ row: rowOf(`m${n}`, `text ${n}`, n), digest: `digest-m${n}` });
  const request = { requestId: 'page', agentId: 'agent', direction: 'tail' as const, limit: 10 };

  it('keeps a body that was filled back when the next publication arrives', async () => {
    const { journals, store } = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [...turn(1, 1), ...turn(3, 2), ...turn(5, 3)]);
    expect(await resident(store)).toEqual([['m1', false], ['m2', false], ['m3', true]]);
    await journals.fill(HOST, SESSION, [item(1)]);
    await journals.publish(HOST, SESSION, 1, [head(7)]);
    expect(await resident(store)).toEqual([['m1', true], ['m2', false], ['m3', true]]);
    expect((await journals.page(HOST, SESSION, { ...request, limit: 3 }, false))?.kind).toBe('missing');
    await journals.publish(HOST, SESSION, 1, turn(8, 4));
    expect(await resident(store)).toEqual([['m1', true], ['m2', false], ['m3', false], ['m4', true]]);
  });

  it('evicts only what left the window since the last publication, so a filled body stays until a limit needs room', async () => {
    const { journals, store } = fixture({ retention: { turns: 2, minItems: 0 }, limits: { sessionBytes: 6000 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [...turn(1, 1), ...turn(3, 2), ...turn(5, 3), ...turn(7, 4)]);
    await journals.fill(HOST, SESSION, [item(1)]);
    for (let n = 5; n <= 8; n++) await journals.publish(HOST, SESSION, 1, turn(n * 2 - 1, n));
    expect((await resident(store)).filter(([, body]) => body).map(([key]) => key)).toEqual(['m1', 'm7', 'm8']);
  });

  it('measures the window again when a journal is loaded, and evicts nothing for it', async () => {
    const first = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(first.journals, HOST, SESSION);
    await first.journals.publish(HOST, SESSION, 1, [...turn(1, 1), ...turn(3, 2)]);
    await first.journals.fill(HOST, SESSION, [item(1)]);
    const reloaded = createHostJournals({ store: first.store, now: () => 1_000, retention: { turns: 1, minItems: 0 } });
    await open(reloaded, HOST, SESSION);
    await reloaded.publish(HOST, SESSION, 2, [head(5)]);
    expect(await resident(first.store)).toEqual([['m1', true], ['m2', true]]);
  });

  it('keeps the latest items resident even when they are more than the turns', async () => {
    const { journals, store } = fixture({ retention: { turns: 2, minItems: 5 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => turn(n * 2 - 1, n)));
    expect((await resident(store)).filter(([, body]) => body).map(([key]) => key)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8']);
  });

  it('keeps the default tail resident for items without a turn, so opening a session needs no fill', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    const withoutTurn = (sequence: number, n: number): JournalPublishEntry => ({ sequence, op: 'append', row: { ...rowOf(`m${n}`, `text ${n}`), turnId: undefined } });
    await journals.publish(HOST, SESSION, 1, Array.from({ length: 150 }, (_, at) => withoutTurn(at * 2 + 1, at)).flatMap((entry, at) => [entry, complete(at * 2 + 2, `m${at}`)]));
    expect((await resident(store)).every(([, body]) => body)).toBe(true);
    expect((await journals.page(HOST, SESSION, { ...request, limit: 100 }, false))?.kind).toBe('page');
  });
});

describe('retention and replacement', () => {
  it('measures the window again in a new epoch and evicts everything outside it, including a body that was filled back', async () => {
    const { journals, store } = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(journals, HOST, SESSION);
    const turn = (sequence: number, n: number): JournalPublishEntry[] => [append(sequence, `m${n}`, `text ${n}`, n), complete(sequence + 1, `m${n}`)];
    await journals.publish(HOST, SESSION, 1, [...turn(1, 1), ...turn(3, 2), ...turn(5, 3)]);
    await journals.fill(HOST, SESSION, [{ row: rowOf('m1', 'text 1', 1), digest: 'digest-m1' }]);
    expect(await resident(store)).toEqual([['m1', true], ['m2', false], ['m3', true]]);
    const items = [1, 2, 3, 4].map(n => ({ row: rowOf(`m${n}`, `text ${n}`, n), digest: `digest-m${n}` }));
    await journals.publish(HOST, SESSION, 1, [{ sequence: 7, op: 'replace', items }]);
    expect(await resident(store)).toEqual([['m1', false], ['m2', false], ['m3', false], ['m4', true]]);
  });
});

describe('filling bodies back', () => {
  const big = 'x'.repeat(2000);
  const item = (key: string, turn: number) => ({ row: rowOf(key, big, turn), digest: `digest-${key}` });

  it('puts back the bodies that fit and leaves the rest missing', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1), complete(2, 'm1'), append(3, 'm2', big, 2)]);
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
    const result = await journals.fill(HOST, SESSION, [item('m1', 1)]);
    expect(result).toEqual({ filled: [], mismatched: [], unknown: [], skipped: ['m1'] });
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
  });

  it('fills when it fits, and reports an item the journal does not have as unknown', async () => {
    const { journals, store } = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1), complete(2, 'm1'), append(3, 'm2', big, 2), complete(4, 'm2')]);
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
    const result = await journals.fill(HOST, SESSION, [item('m1', 1), item('nope', 1)]);
    expect(result).toEqual({ filled: ['m1'], mismatched: [], unknown: ['nope'] });
    expect(await resident(store)).toEqual([['m1', true], ['m2', true]]);
  });

  it('reads the page in the same step as the fill, so a publication queued behind it is not in the page', async () => {
    const { journals } = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1), complete(2, 'm1'), append(3, 'm2', big, 2), complete(4, 'm2')]);
    const request = { requestId: 'page', agentId: 'agent', direction: 'tail' as const, limit: 10 };
    expect((await journals.page(HOST, SESSION, request, false))?.kind).toBe('missing');
    const filling = journals.fill(HOST, SESSION, [item('m1', 1)], { request, olderBeyondJournal: () => false });
    const publishing = journals.publish(HOST, SESSION, 1, [append(5, 'm3', 'later', 3)]);
    const filled = await filling;
    expect(filled.page?.kind).toBe('page');
    if (filled.page?.kind === 'page') expect(JSON.stringify(filled.page.page)).not.toContain('later');
    await publishing;
    expect((await journals.fill(HOST, 'codex:none', [], { request, olderBeyondJournal: () => false })).page).toBeUndefined();
  });

  it('never reports a body that is already in memory as skipped', async () => {
    const { journals } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1)]);
    expect(await journals.fill(HOST, SESSION, [item('m1', 1)])).toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
  });

  it('does not fill past the Host quota, counting what the Host\'s other sessions hold even before any publication loaded them', async () => {
    const seeded = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(seeded.journals, HOST, 'codex:s1');
    await seeded.journals.publish(HOST, 'codex:s1', 1, [append(1, 'm1', big, 1)]);
    await open(seeded.journals, HOST, 'codex:s2');
    await seeded.journals.publish(HOST, 'codex:s2', 1, [append(1, 'm1', big, 1), complete(2, 'm1'), append(3, 'm2', 'x', 2)]);
    expect((await seeded.store.load(`${HOST}:codex:s2`))!.items[0]!.body).toBeNull();
    const total = (await seeded.store.catalog!.list(`${HOST}:`)).reduce((sum, listing) => sum + listing.bytes, 0);
    const restarted = createHostJournals({ store: seeded.store, now: () => 1_000, limits: { hostBytes: total + 500 } });
    const result = await restarted.fill(HOST, 'codex:s2', [item('m1', 1)]);
    expect(result).toEqual({ filled: [], mismatched: [], unknown: [], skipped: ['m1'] });
  });

  it('makes room by evicting bodies outside the latest turns once, so an idle session read back past the limit is not stuck', async () => {
    const text = 'x'.repeat(1500);
    const bodies = (key: string, turn: number) => ({ row: rowOf(key, text, turn), digest: `digest-${key}` });
    const { journals, store } = fixture({ limits: { sessionBytes: 5500 }, retention: { turns: 1, minItems: 0 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [1, 2, 3].flatMap(n => [append(n * 2 - 1, `m${n}`, text, n), complete(n * 2, `m${n}`)]));
    expect(await resident(store)).toEqual([['m1', false], ['m2', false], ['m3', true]]);
    const result = await journals.fill(HOST, SESSION, [bodies('m1', 1), bodies('m2', 2)]);
    expect(result).toEqual({ filled: ['m2'], mismatched: [], unknown: [], skipped: ['m1'] });
    expect(await resident(store)).toEqual([['m1', false], ['m2', true], ['m3', true]]);
  });
});

describe('the head index', () => {
  it('is unknown for a Host until it is loaded, and then answers from memory', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)])).hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(journals.served(HOST, 'codex:other')).toBe(false);
    expect(journals.served('host-9', SESSION)).toBeUndefined();
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect(restarted.served(HOST, SESSION)).toBeUndefined();
    expect(await restarted.servedSessions(HOST)).toEqual([SESSION]);
    expect(restarted.served(HOST, SESSION)).toBe(true);
    expect(restarted.served(HOST, 'codex:other')).toBe(false);
  });

  it('is complete for every Host after the startup load', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    await open(journals, 'host-2', SESSION, 'controller-2');
    await journals.publish('host-2', SESSION, 1, [append(1, 'm1', 'a')]);
    const restarted = createHostJournals({ store, now: () => 1_000 });
    await restarted.loadAllServed();
    expect([restarted.served(HOST, SESSION), restarted.served('host-2', SESSION), restarted.served('host-3', SESSION)]).toEqual([true, false, false]);
  });

  it('does not count a journal without a head', async () => {
    const { journals } = fixture();
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')])).hasHead).toBe(false);
    expect(await journals.servedSessions(HOST)).toEqual([]);
  });

  it('loads a Host once however many ask, without waiting for the Host\'s queue', async () => {
    const seeded = fixture();
    await open(seeded.journals, HOST, SESSION);
    await seeded.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const reader = createHostJournals({ store: seeded.store, now: () => 1_000 });
    const [first, second] = await Promise.all([reader.servedSessions(HOST), reader.servedSessions(HOST)]);
    expect([first, second]).toEqual([[SESSION], [SESSION]]);
    expect(seeded.lists.filter(prefix => prefix === `${HOST}:`)).toHaveLength(2);
  });

  it('discards a listing that a deletion overtook', async () => {
    const seeded = fixture();
    await open(seeded.journals, HOST, SESSION);
    await seeded.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const reader = createHostJournals({ store: seeded.store, now: () => 1_000 });
    const release = seeded.holdLists();
    const loading = reader.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    await reader.deleteHost(HOST);
    release();
    expect(await loading).toEqual([]);
    expect(reader.served(HOST, SESSION)).toBe(false);
  });

  it('discards a listing that a head change overtook, so a session whose head was cleared is not served again', async () => {
    const seeded = fixture();
    await open(seeded.journals, HOST, SESSION);
    await seeded.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const reader = createHostJournals({ store: seeded.store, now: () => 1_000 });
    const release = seeded.holdLists();
    const loading = reader.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    // Another process of the Relay's data clears the head in the store while the reader holds the older listing.
    const limited = createHostJournals({ store: seeded.memory, now: () => 1_000, limits: { sessionItems: 1 } });
    await limited.open(HOST, SESSION, 'controller-1', LIMITS);
    expect((await limited.publish(HOST, SESSION, 2, [append(3, 'm2', 'b')])).unserved).toBe(true);
    reader.unserve(HOST, SESSION);
    release();
    expect(await loading).toEqual([]);
    expect(reader.served(HOST, SESSION)).toBe(false);
  });

  it('forgets a session that was found without a head, until a publication gives it one', async () => {
    const { journals } = fixture();
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    journals.unserve(HOST, SESSION);
    expect(journals.served(HOST, SESSION)).toBe(false);
    await journals.publish(HOST, SESSION, 1, [head(3)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });
});

describe('deletion', () => {
  it('deletes every journal of a Host and none of another Host', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, 'codex:s1');
    await open(journals, HOST, 'codex:s2');
    await open(journals, 'host-2', 'codex:s1', 'controller-2');
    await journals.deleteHost(HOST);
    expect(await store.catalog!.list('')).toMatchObject([{ sessionKey: 'host-2:codex:s1' }]);
    expect(await journals.servedSessions(HOST)).toEqual([]);
    expect(await journals.status(HOST, 'codex:s1')).toBeUndefined();
  });

  it('orders a deletion against publications: earlier ones apply, later ones are refused and nothing returns', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    const before = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const deleted = journals.deleteHost(HOST);
    const after = journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'b')]);
    expect((await before).watermark).toBe(2);
    await deleted;
    expect((await after).refusal).toEqual({ sequence: 3, reason: 'fenced' });
    expect(await store.load(KEY)).toBeUndefined();
    expect(journals.served(HOST, SESSION)).toBe(false);
  });

  it('does not open a journal for a connection that ended behind a deletion of its Host', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    let current = true;
    const deleted = journals.deleteHost(HOST);
    const reopened = journals.open(HOST, SESSION, 'controller-1', { ...LIMITS, allowed: () => current });
    current = false;
    await deleted;
    expect(await reopened).toEqual({ refused: 'unavailable' });
    expect(await store.load(KEY)).toBeUndefined();
  });

  it('opens a fresh journal for a Host whose journals were deleted', async () => {
    const { journals } = fixture();
    const first = await open(journals, HOST, SESSION);
    await journals.deleteHost(HOST);
    const second = await open(journals, HOST, SESSION);
    expect(second).toMatchObject({ generation: 1, watermark: 0, index: [] });
    expect(second.epoch).not.toBe(first.epoch);
  });
});
