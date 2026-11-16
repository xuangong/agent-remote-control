import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import type { AgentSnapshotPayload, JournalPublishEntry, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const PUBLISHER = 'controller-1';
const pending: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' };
const settled: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-2', status: 'available' };
const row = (itemKey: string, text: string, resources: ResourceBinding[] = []) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1_725_000_000_000, turnId: 'turn-1', resources,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const snapshot: AgentSnapshotPayload = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};

async function seeded(limits?: { liveOnlyItems?: number; sessionBytes?: number }) {
  const store = new MemoryJournalStore();
  const journal = SessionJournal.create(KEY);
  journal.claim(PUBLISHER);
  await store.apply(journal.takeChanges()!);
  return { store, journals: createHostJournals({ store, now: () => 1_000, ...(limits ? { limits } : {}) }) };
}

describe('amendments published to a journal', () => {
  it('applies a rebind and an outcome in place, stores them, and lists what subscribers hear in order', async () => {
    const { store, journals } = await seeded();
    const entries: JournalPublishEntry[] = [
      { sequence: 1, op: 'append', row: { ...row('a', 'Alpha', [pending]), item: { type: 'assistant_message', text: 'Alpha', messageId: 'a', background: { id: 'review-1', kind: 'review', status: 'pending' } } } },
      { sequence: 2, op: 'rebind', itemKey: 'a', previous: pending, replacement: settled },
      { sequence: 3, op: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_500 },
    ];
    const result = await journals.publish(HOST, SESSION, 1, entries);
    expect(result.refusal).toBeUndefined();
    expect(result.watermark).toBe(3);
    expect(result.events.map(event => event.kind)).toEqual(['row', 'rebound', 'outcome']);
    expect(result.events[1]).toEqual({ kind: 'rebound', epoch: result.cursor!.epoch, seq: 1, previous: pending, replacement: settled });
    expect(result.events[2]).toEqual({ kind: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_500 });
    const saved = await store.load(KEY);
    expect(saved?.items[0]?.body?.resources).toEqual([settled]);
    expect(saved?.meta.publisher?.watermark).toBe(3);
  });

  it('tells subscribers nothing for a publication it already applied', async () => {
    const { journals } = await seeded();
    const entries: JournalPublishEntry[] = [
      { sequence: 1, op: 'append', row: row('a', 'Alpha', [pending]) },
      { sequence: 2, op: 'rebind', itemKey: 'a', previous: pending, replacement: settled },
    ];
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toHaveLength(2);
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toEqual([]);
  });

  it('refuses an open correction that names a stale revision, and keeps the entries before it', async () => {
    const { journals } = await seeded();
    const result = await journals.publish(HOST, SESSION, 1, [
      { sequence: 1, op: 'append', row: row('a', 'Alpha') },
      { sequence: 2, op: 'correct', row: row('a', 'Alpha, in full'), expectedRevision: 99 },
      { sequence: 3, op: 'rebind', itemKey: 'a', previous: pending, replacement: settled },
    ]);
    expect(result.refusal).toEqual({ sequence: 2, reason: 'stale_revision', itemKey: 'a' });
    expect(result.watermark).toBe(1);
    expect(result.events.map(event => event.kind)).toEqual(['row']);
  });

  it('accepts the entries after a refused one when they are sent again under the refused entry\'s number, and does not take them for a duplicate', async () => {
    const { store, journals } = await seeded();
    const result = await journals.publish(HOST, SESSION, 1, [
      { sequence: 1, op: 'append', row: row('a', 'Alpha') },
      { sequence: 2, op: 'correct', row: row('b', 'Ghost'), expectedRevision: 1 },
      { sequence: 3, op: 'append', row: row('c', 'Gamma') },
    ]);
    expect(result.refusal).toEqual({ sequence: 2, reason: 'unknown_item', itemKey: 'b' });
    expect(result.watermark).toBe(1);
    // The entry that followed was not applied, and the refused sequence is still free.
    expect((await journals.publish(HOST, SESSION, 1, [{ sequence: 3, op: 'append', row: row('c', 'Gamma') }])).refusal).toEqual({ sequence: 3, reason: 'sequence_gap' });
    const again = await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'append', row: row('c', 'Gamma') }]);
    expect(again.refusal).toBeUndefined();
    expect(again.watermark).toBe(2);
    expect(again.events.map(event => event.kind)).toEqual(['row']);
    expect((await store.load(KEY))?.items.map(item => item.itemKey)).toEqual(['a', 'c']);
  });

  it('takes a replacement whose last item is still open, without a digest', async () => {
    const { store, journals } = await seeded();
    const result = await journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'replace', items: [{ row: row('a', 'Alpha'), digest: 'd'.repeat(64) }, { row: row('b', 'Still streaming') }] }]);
    expect(result.refusal).toBeUndefined();
    const saved = await store.load(KEY);
    expect(saved?.items.map(item => [item.itemKey, item.state, item.digest])).toEqual([['a', 'complete', 'd'.repeat(64)], ['b', 'open', undefined]]);
  });

  it('does not count a rebind as growth: it replaces a binding in place and is never refused for the quota', async () => {
    const { journals } = await seeded({ sessionBytes: 3000 });
    expect((await journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'append', row: row('a', 'Alpha', [pending]) }])).refusal).toBeUndefined();
    const large: ResourceBinding = { ...settled, locator: 'docs/' + 'x'.repeat(3500) };
    const result = await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'rebind', itemKey: 'a', previous: pending, replacement: large }]);
    expect(result.refusal).toBeUndefined();
    expect(result.watermark).toBe(2);
    expect(result.events.map(event => event.kind)).toEqual(['rebound']);
  });

  it('counts prepended live-only items against the live-only cap', async () => {
    const { journals } = await seeded({ liveOnlyItems: 1 });
    const live = (itemKey: string) => ({ row: { ...row(itemKey, itemKey), liveOnly: true }, digest: 'd'.repeat(64) });
    const result = await journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'prepend', items: [live('q1'), live('q2')] }]);
    expect(result.droppedLiveOnly).toBe(1);
  });
});

describe('taking a session out of serving at the Controller\'s word', () => {
  const served = async () => {
    const fixture = await seeded();
    await fixture.journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'append', row: row('a', 'Alpha') }, { sequence: 2, op: 'head', head: { snapshot, observedAt: 5 } }]);
    return fixture;
  };

  it('clears the head, persists that, and reports it as unserved', async () => {
    const { store, journals } = await served();
    expect(journals.served(HOST, SESSION)).toBe(true);
    const result = await journals.unserveHead(HOST, SESSION, 1);
    expect(result).toMatchObject({ unserved: true, hasHead: false, events: [], watermark: 2 });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await store.load(KEY))?.meta.head).toBeUndefined();
    expect(await journals.status(HOST, SESSION)).toMatchObject({ cursor: { seq: 1 } });
    expect((await journals.status(HOST, SESSION))?.head).toBeUndefined();
  });

  it('serves the session again when a later publication sets a head', async () => {
    const { journals } = await served();
    await journals.unserveHead(HOST, SESSION, 1);
    await journals.publish(HOST, SESSION, 1, [{ sequence: 3, op: 'head', head: { snapshot, observedAt: 6 } }]);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });

  it('ignores a generation that is not the publisher\'s, and a session that has no head to clear', async () => {
    const { store, journals } = await served();
    expect(await journals.unserveHead(HOST, SESSION, 7)).toBeUndefined();
    expect((await store.load(KEY))?.meta.head).toBeDefined();
    expect(await journals.unserveHead(HOST, SESSION, 1)).toMatchObject({ unserved: true });
    expect(await journals.unserveHead(HOST, SESSION, 1)).toMatchObject({ hasHead: false });
    expect((await journals.unserveHead(HOST, SESSION, 1))?.unserved).toBeUndefined();
    expect(await journals.unserveHead(HOST, 'codex:unknown', 1)).toBeUndefined();
  });
});
