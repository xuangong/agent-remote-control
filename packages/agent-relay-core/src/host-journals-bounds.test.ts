import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, HOST_JOURNAL_LIMITS, type HostJournals, type HostJournalsOptions, type JournalOpened } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
/** A row larger than the 3500-byte session budget the quota tests use. */
const BIG = 'x'.repeat(4000);
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
  return { ...counted, store, journals: createHostJournals({ ...options, store }) };
}
const open = (journals: HostJournals, hostId: string, sessionKey: string, publisherId = 'controller-1') =>
  journals.open(hostId, sessionKey, publisherId, {}) as Promise<JournalOpened>;
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
    expect(() => createHostJournals({ store: new MemoryJournalStore(), limits: { sessionBytes: 1.5 } })).toThrow(RangeError);
    expect(() => createHostJournals({ store: new MemoryJournalStore(), cache: { maxJournals: -1 } })).toThrow(RangeError);
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

  it('refuses a gap as a gap even when the entry is over the limits, and neither fences the generation nor marks the journal incomplete', async () => {
    const { journals } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'small', 1), head(2)]);
    const gap = await journals.publish(HOST, SESSION, 1, [append(9, 'm2', 'x'.repeat(4000), 2)]);
    expect(gap.refusal).toEqual({ sequence: 9, reason: 'sequence_gap' });
    expect(gap).toMatchObject({ hasHead: true, watermark: 2 });
    expect(gap.unserved).toBeUndefined();
    expect(journals.served(HOST, SESSION)).toBe(true);
    // The generation still publishes: a head is not refused as incomplete, and the next sequence is applied.
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'fits', 2), head(4)])).refusal).toBeUndefined();
  });

  it('refuses an entry larger than the room before it evicts anything', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'small', 1), complete(2, 'm1'), append(3, 'm2', 'small', 2)]);
    const refused = await journals.publish(HOST, SESSION, 1, [append(4, 'm3', 'x'.repeat(4000), 3)]);
    expect(refused.refusal).toEqual({ sequence: 4, reason: 'quota_exceeded' });
    expect(await resident(store)).toEqual([['m1', true], ['m2', true]]);
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

  it('measures appended and prepended rows in UTF-8 bytes', async () => {
    const wide = '字'.repeat(1100);
    const narrow = 'x'.repeat(1100);
    const limits = { sessionBytes: 3500 };
    const appended = fixture({ limits });
    await open(appended.journals, HOST, SESSION);
    expect((await appended.journals.publish(HOST, SESSION, 1, [append(1, 'm1', wide)])).refusal).toEqual({ sequence: 1, reason: 'quota_exceeded' });
    const appendedNarrow = fixture({ limits });
    await open(appendedNarrow.journals, HOST, SESSION);
    expect((await appendedNarrow.journals.publish(HOST, SESSION, 1, [append(1, 'm1', narrow)])).refusal).toBeUndefined();

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

  it('does not count a publication of a fenced generation against the limits', async () => {
    const { journals } = fixture();
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 9, [append(1, 'm1', 'a')])).refusal).toEqual({ sequence: 1, reason: 'fenced' });
  });
});

describe('a quota refusal and the live-only cap', () => {
  it('takes the session out of serving, persisted, and serves it again only after a window and a head from a reopened publisher', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)])).hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const refused = await journals.publish(HOST, SESSION, 1, [append(3, 'm2', BIG)]);
    expect(refused).toMatchObject({ refusal: { sequence: 3, reason: 'quota_exceeded' }, unserved: true, hasHead: false });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await store.load(KEY))?.meta.head).toBeUndefined();
    const restarted = createHostJournals({ store });
    expect(await restarted.servedSessions(HOST)).toEqual([]);
    const reopened = await open(restarted, HOST, SESSION);
    expect(reopened.generation).toBe(2);
    const rebuilt = await restarted.publish(HOST, SESSION, 2, [{ sequence: 3, op: 'window', items: [{ row: rowOf('m1', 'a'), digest: 'digest-m1' }] }, head(4)]);
    expect(rebuilt).toMatchObject({ hasHead: true });
    expect(rebuilt.refusal).toBeUndefined();
    expect(rebuilt.unserved).toBeUndefined();
    expect(restarted.served(HOST, SESSION)).toBe(true);
  });

  it('applies nothing after a quota refusal: the rest of the message is dropped, the next sequence is a gap, the refused sequence is incomplete, and a window from the same generation recovers', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const refused = await journals.publish(HOST, SESSION, 1, [append(3, 'm2', BIG), head(4)]);
    expect(refused.refusal).toEqual({ sequence: 3, reason: 'quota_exceeded' });
    expect(refused.watermark).toBe(2);
    expect(journals.served(HOST, SESSION)).toBe(false);
    const gap = await journals.publish(HOST, SESSION, 1, [head(4)]);
    expect(gap.refusal).toEqual({ sequence: 4, reason: 'sequence_gap' });
    expect(gap.hasHead).toBe(false);
    const resent = await journals.publish(HOST, SESSION, 1, [append(3, 'm1', 'more')]);
    expect(resent.refusal).toEqual({ sequence: 3, reason: 'incomplete' });
    expect((await journals.publish(HOST, SESSION, 1, [head(3)])).refusal).toEqual({ sequence: 3, reason: 'incomplete' });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await store.load(KEY))?.items.map(item => item.itemKey)).toEqual(['m1']);
    const rebuilt = await journals.publish(HOST, SESSION, 1, [{ sequence: 3, op: 'window', items: [{ row: rowOf('m1', 'a'), digest: 'digest-m1' }] }, head(4)]);
    expect(rebuilt.refusal).toBeUndefined();
    expect(rebuilt.hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });

  it('refuses the head of an incomplete journal on its own, without fencing the reopened generation, and accepts the window that follows', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm2', BIG)])).refusal).toEqual({ sequence: 3, reason: 'quota_exceeded' });
    const restarted = createHostJournals({ store });
    expect((await open(restarted, HOST, SESSION)).generation).toBe(2);
    const early = await restarted.publish(HOST, SESSION, 2, [head(3)]);
    expect(early.refusal).toEqual({ sequence: 3, reason: 'incomplete' });
    expect(early.unserved).toBeUndefined();
    expect(restarted.served(HOST, SESSION)).toBe(false);
    const rebuilt = await restarted.publish(HOST, SESSION, 2, [{ sequence: 3, op: 'window', items: [{ row: rowOf('m1', 'a'), digest: 'digest-m1' }] }, head(4)]);
    expect(rebuilt.refusal).toBeUndefined();
    expect(rebuilt.hasHead).toBe(true);
    expect(restarted.served(HOST, SESSION)).toBe(true);
  });

  it('does not serve a journal that lost a row before it had a head, until a window rebuilds it', async () => {
    const { journals } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', BIG)]);
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 2, [head(2)])).refusal).toEqual({ sequence: 2, reason: 'incomplete' });
    expect(journals.served(HOST, SESSION)).toBe(false);
  });

  it('does not report a session without a head as taken out of serving', async () => {
    const { journals } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')])).unserved).toBeUndefined();
  });

  it('removes the oldest complete live-only items beyond the cap, with their bodies, and reports how many', async () => {
    const { journals, store } = fixture({ limits: { liveOnlyItems: 2 } });
    await open(journals, HOST, SESSION);
    const result = await journals.publish(HOST, SESSION, 1, [live(1, 'l1'), live(2, 'l2'), live(3, 'l3'), complete(4, 'l1'), complete(5, 'l2'), complete(6, 'l3'), append(7, 'm1', 'kept', 1)]);
    expect(result.droppedLiveOnly).toBe(true);
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
    expect(completed.droppedLiveOnly).toBe(true);
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l2', 'l3', 'm1']);
  });
});

describe('the default limits', () => {
  const liveRows = (count: number): JournalPublishEntry[] => Array.from({ length: count }, (_, at) => [live(at * 2 + 1, `l${at}`), complete(at * 2 + 2, `l${at}`)]).flat();

  it('keeps 2000 live-only items and removes the oldest beyond that', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    const atCap = await journals.publish(HOST, SESSION, 1, liveRows(2000));
    expect(atCap.droppedLiveOnly).toBeUndefined();
    expect((await store.load(KEY))!.items).toHaveLength(2000);
    const over = await journals.publish(HOST, SESSION, 1, [live(4001, 'l2000'), complete(4002, 'l2000')]);
    expect(over.droppedLiveOnly).toBe(true);
    const kept = (await store.load(KEY))!.items.map(item => item.itemKey);
    expect(kept).toHaveLength(2000);
    expect([kept[0], kept.at(-1)]).toEqual(['l1', 'l2000']);
  });

  it('has the documented defaults: 64 MiB a session, 1 GiB a Host, 2000 live-only items', () => {
    expect(HOST_JOURNAL_LIMITS).toEqual({ sessionBytes: 64 * 1024 * 1024, hostBytes: 1024 * 1024 * 1024, liveOnlyItems: 2000 });
  });

  it.each([[0, true], [1, false]])('admits a publication that needs the room the Host default leaves, and refuses one byte more (%i byte over: admitted %s)', async (over, admitted) => {
    const entry = append(1, 'm1', 'hello');
    // What the journal counts for the session before and after the entry, measured on a Host with no other session.
    const probe = new MemoryJournalStore();
    const probed = createHostJournals({ store: probe });
    await open(probed, HOST, SESSION);
    const before = (await probe.catalog.list(`${HOST}:`))[0]!.bytes;
    const needed = before + new TextEncoder().encode(JSON.stringify(entry)).length;
    const memory = new MemoryJournalStore();
    // Another session of the Host holds all but `needed` bytes of the Host's 1 GiB; no data of that size exists.
    const other = { sessionKey: `${HOST}:codex:other`, hasHead: false, bytes: 1024 * 1024 * 1024 - needed + over };
    const store: JournalStore = { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: async prefix => [...(await memory.catalog.list(prefix)).filter(listing => listing.sessionKey !== other.sessionKey), ...(other.sessionKey.startsWith(prefix) ? [other] : [])], deletePrefix: prefix => memory.catalog.deletePrefix(prefix) } };
    const journals = createHostJournals({ store });
    await open(journals, HOST, SESSION);
    const result = await journals.publish(HOST, SESSION, 1, [entry]);
    if (admitted) expect(result.refusal).toBeUndefined();
    else expect(result.refusal).toEqual({ sequence: 1, reason: 'quota_exceeded' });
  });

  // 17 MiB: the cap is 17 MiB less one message (8 MiB), not less half the session (8.5 MiB), so 9 MiB of live-only items stay.
  it('caps the live-only bytes at the session limit less one message of 8 MiB when the session is larger than 16 MiB', async () => {
    const MiB = 1024 * 1024;
    const { journals, store } = fixture({ limits: { sessionBytes: 17 * MiB } });
    await open(journals, HOST, SESSION);
    const row = (at: number) => [{ sequence: at * 2 + 1, op: 'append' as const, row: { ...rowOf(`l${at}`, 'x'.repeat(Math.floor(2.2 * MiB)), 0), liveOnly: true } }, complete(at * 2 + 2, `l${at}`)];
    for (let at = 0; at < 4; at += 1) expect((await journals.publish(HOST, SESSION, 1, row(at))).droppedLiveOnly).toBeUndefined();
    expect((await store.load(KEY))!.items).toHaveLength(4);
    const over = await journals.publish(HOST, SESSION, 1, row(4));
    expect(over.droppedLiveOnly).toBe(true);
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  // A live-only row of 400 characters takes about 730 bytes. The cap is half a small session (no more than one message below
  // the session limit), so the rows kept at 10,000, 20,000 and 40,000 bytes are the rows that fit in 5,000, 10,000 and 20,000.
  it.each([[10_000, 6], [20_000, 13], [40_000, 27]])('keeps the live-only rows that fit in half of a %i-byte session: %i', async (sessionBytes, kept) => {
    const { journals, store } = fixture({ limits: { sessionBytes } });
    await open(journals, HOST, SESSION);
    for (let at = 0; at < 80; at += 1) {
      const result = await journals.publish(HOST, SESSION, 1, [{ sequence: at * 2 + 1, op: 'append', row: { ...rowOf(`l${at}`, 'x'.repeat(400), 0), liveOnly: true } }, complete(at * 2 + 2, `l${at}`)]);
      expect(result.refusal).toBeUndefined();
    }
    expect((await store.load(KEY))!.items).toHaveLength(kept);
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
    const reloaded = createHostJournals({ store: first.store, retention: { turns: 1, minItems: 0 } });
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

describe('retention and replacement by a window', () => {
  it('measures the window again in a new epoch and evicts everything outside it, including a body that was filled back', async () => {
    const { journals, store } = fixture({ retention: { turns: 1, minItems: 0 } });
    await open(journals, HOST, SESSION);
    const turn = (sequence: number, n: number): JournalPublishEntry[] => [append(sequence, `m${n}`, `text ${n}`, n), complete(sequence + 1, `m${n}`)];
    await journals.publish(HOST, SESSION, 1, [...turn(1, 1), ...turn(3, 2), ...turn(5, 3)]);
    await journals.fill(HOST, SESSION, [{ row: rowOf('m1', 'text 1', 1), digest: 'digest-m1' }]);
    expect(await resident(store)).toEqual([['m1', true], ['m2', false], ['m3', true]]);
    const items = [1, 2, 3, 4].map(n => ({ row: rowOf(`m${n}`, `text ${n}`, n), digest: n === 2 ? 'digest-reread' : `digest-m${n}` }));
    await journals.publish(HOST, SESSION, 1, [{ sequence: 7, op: 'window', items }]);
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
    const restarted = createHostJournals({ store: seeded.store, limits: { hostBytes: total + 500 } });
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
    const restarted = createHostJournals({ store });
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
    const restarted = createHostJournals({ store });
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
    const reader = createHostJournals({ store: seeded.store });
    const [first, second] = await Promise.all([reader.servedSessions(HOST), reader.servedSessions(HOST)]);
    expect([first, second]).toEqual([[SESSION], [SESSION]]);
    expect(seeded.lists.filter(prefix => prefix === `${HOST}:`)).toHaveLength(2);
  });

  it('does not adopt a listing that a deletion overtook', async () => {
    const seeded = fixture();
    await open(seeded.journals, HOST, SESSION);
    await seeded.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const reader = createHostJournals({ store: seeded.store });
    const release = seeded.holdLists();
    const loading = reader.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    await reader.deleteHost(HOST);
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
    const reopened = journals.open(HOST, SESSION, 'controller-1', { allowed: () => current });
    current = false;
    await deleted;
    expect(await reopened).toEqual({ refused: 'unavailable' });
    expect(await store.load(KEY)).toBeUndefined();
  });

  it('opens a fresh journal for a Host whose journals were deleted', async () => {
    const { journals } = fixture();
    await open(journals, HOST, SESSION);
    const first = (await journals.status(HOST, SESSION))!.cursor.epoch;
    await journals.deleteHost(HOST);
    expect(await open(journals, HOST, SESSION)).toEqual({ generation: 1, watermark: 0 });
    expect((await journals.status(HOST, SESSION))!.cursor.epoch).not.toBe(first);
  });
});
