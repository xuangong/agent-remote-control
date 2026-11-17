import { createHostJournals, createRelayState, type HostJournals, type HostJournalsOptions } from '@orchardworks/agent-relay-core';
import { buildCompleteRelayState, MemoryRelayStateStore, relayStateStoreAuth } from '@orchardworks/agent-relay-core/testing';
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';
import { openNodeJournalDatabase } from '@orchardworks/agent-remote-journal-sqlite/node';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * S4, Relay to stores: the Relay's journal service and its account state over each store implementation. The stores
 * themselves meet the contract suites of `agent-remote-journal/testing` and `agent-relay-core/testing` in their own packages and
 * in the Workers project; this seam checks what the Relay relies on: an acknowledgement means durable, a service that starts
 * again over the same store finds every journal, and a store that fails leaves the Relay unavailable instead of wrong.
 */
const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const row = (itemKey: string, text: string, turn = 1) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId: `turn-${turn}`,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string, text: string, turn = 1): JournalPublishEntry => ({ sequence, op: 'append', row: row(itemKey, text, turn) });
const complete = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
const tail = { requestId: 'p', agentId: 'a', direction: 'tail' as const, limit: 10 };

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

const journalStores: Array<[string, () => Promise<MemoryJournalStore | SqlJournalStore>]> = [
  ['the memory store', async () => new MemoryJournalStore()],
  ['the SQLite store', async () => {
    const database = await openNodeJournalDatabase(':memory:');
    closers.push(() => database.close());
    return new SqlJournalStore(database);
  }],
];

describe.each(journalStores)('S4 the journal service over %s', (_name, openStore) => {
  const service = (store: MemoryJournalStore | SqlJournalStore, options: Partial<Omit<HostJournalsOptions, 'store'>> = {}): HostJournals => createHostJournals({ store, ...options });

  it('acknowledges a publication only after its changes are in the store', async () => {
    const store = await openStore();
    const journals = service(store);
    await journals.open(HOST, SESSION, 'controller-1', {});
    const published = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')]);
    expect(published).toMatchObject({ watermark: 2 });
    const stored = await store.load(`${HOST}:${SESSION}`);
    expect(stored?.items.map(item => item.itemKey)).toEqual(['m1']);
    expect(stored?.meta.publisher?.watermark).toBe(2);
  });

  it('finds every journal again when the service starts over the same store, and fences the old generation', async () => {
    const store = await openStore();
    const first = service(store);
    await first.open(HOST, SESSION, 'controller-1', {});
    await first.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')]);
    const second = service(store);
    expect(await second.open(HOST, SESSION, 'controller-1', {})).toMatchObject({ generation: 2, watermark: 2 });
    expect(await second.page(HOST, SESSION, tail, false)).toMatchObject({ kind: 'page', page: { payload: { entries: [expect.objectContaining({ item: expect.objectContaining({ text: 'Hello' }) })] } } });
    expect(await second.publish(HOST, SESSION, 1, [append(3, 'm2', 'Late')])).toMatchObject({ refusal: { reason: 'fenced' } });
  });

  it('serves the sessions that have a head after the service starts again', async () => {
    const store = await openStore();
    const first = service(store);
    await first.open(HOST, SESSION, 'controller-1', {});
    await first.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), { sequence: 2, op: 'head', head: { snapshot: { id: 's', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
      capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
      pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 's', status: 'idle' } }, observedAt: 5 } }]);
    const second = service(store);
    expect(await second.servedSessions(HOST)).toEqual([SESSION]);
    expect(second.served(HOST, SESSION)).toBe(true);
  });

  it('refuses growth over the session limit and stores nothing of the refused entry', async () => {
    const store = await openStore();
    const journals = service(store, { limits: { sessionBytes: 3500 } });
    const big = 'x'.repeat(2000);
    await journals.open(HOST, SESSION, 'controller-1', {});
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1)]);
    expect(await journals.publish(HOST, SESSION, 1, [append(2, 'm2', big, 2)])).toMatchObject({ refusal: { sequence: 2, reason: 'quota_exceeded' } });
    expect((await store.load(`${HOST}:${SESSION}`))?.items.map(item => item.itemKey)).toEqual(['m1']);
  });

  it('deletes the journals of one Host and no other, and a service that starts again finds none of them', async () => {
    const store = await openStore();
    const journals = service(store);
    for (const host of [HOST, 'host-2']) {
      await journals.open(host, SESSION, 'controller-1', {});
      await journals.publish(host, SESSION, 1, [append(1, 'm1', 'Hello')]);
    }
    await journals.deleteHost(HOST);
    expect(await store.load(`${HOST}:${SESSION}`)).toBeUndefined();
    expect(await store.load(`host-2:${SESSION}`)).toBeDefined();
    expect(await service(store).page(HOST, SESSION, tail, false)).toBeUndefined();
  });

  it('keeps few journals in memory and reads a dropped one from the store again', async () => {
    const store = await openStore();
    const journals = service(store, { cache: { maxJournals: 1 } });
    for (const key of ['codex:a', 'codex:b']) {
      await journals.open(HOST, key, 'controller-1', {});
      await journals.publish(HOST, key, 1, [append(1, 'm1', key)]);
    }
    expect(await journals.page(HOST, 'codex:a', tail, false)).toMatchObject({ kind: 'page', page: { payload: { entries: [expect.objectContaining({ item: expect.objectContaining({ text: 'codex:a' }) })] } } });
  });
});

describe('S4 the account state over the memory store', () => {
  const failed = () => {}; const published = () => {};

  it('resolves a change only after the whole state is committed, and starts again from it', async () => {
    const store = new MemoryRelayStateStore();
    const state = createRelayState(relayStateStoreAuth, store, failed, published);
    await state.mutate(draft => { draft.sessionTitleRevision = 7; });
    expect(store.reopen().initial?.sessionTitleRevision).toBe(7);
    expect(createRelayState(relayStateStoreAuth, store.reopen(), failed, published).read().sessionTitleRevision).toBe(7);
  });

  it('starts from the complete state a store holds', async () => {
    const stored = buildCompleteRelayState(relayStateStoreAuth);
    const store = new MemoryRelayStateStore({ state: stored });
    const state = createRelayState(relayStateStoreAuth, store, failed, published);
    expect(state.read().tenants.map(tenant => tenant.subject)).toEqual(stored.tenants.map(tenant => tenant.subject));
  });

  it('leaves the Relay unavailable, with the stored state untouched, when a commit fails', async () => {
    const store = new MemoryRelayStateStore();
    let failures = 0;
    const state = createRelayState(relayStateStoreAuth, store, () => { failures++; }, published);
    await state.mutate(draft => { draft.sessionTitleRevision = 1; });
    store.breakStorage();
    await expect(state.mutate(draft => { draft.sessionTitleRevision = 2; })).rejects.toThrow();
    expect(failures).toBe(1);
    expect(() => state.assertAvailable()).toThrow();
    store.repairStorage();
    expect(store.reopen().initial?.sessionTitleRevision).toBe(1);
    expect(state.read().sessionTitleRevision).toBe(1);
  });
});
