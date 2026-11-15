import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import type { AgentSnapshotPayload, JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type JournalOpened } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const LIMITS = { maxIndexItems: 1_000_000, pageItems: 1_000_000 };
const snapshot: AgentSnapshotPayload = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'append', row: row(itemKey, itemKey) });
const complete = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
const head = (sequence: number): JournalPublishEntry => ({ sequence, op: 'head', head: { snapshot, observedAt: 5 } });

async function overlarge() {
  const store = new MemoryJournalStore();
  const journals = createHostJournals({ store, now: () => 1_000 });
  await journals.open(HOST, SESSION, 'controller-1', LIMITS);
  await journals.publish(HOST, SESSION, 1, [append(1, 'm1'), complete(2, 'm1'), append(3, 'm2'), complete(4, 'm2'), append(5, 'm3'), complete(6, 'm3'), head(7)]);
  return { store, journals };
}

describe('opening a journal without its index', () => {
  it('claims a journal whose index is too large, takes it out of serving, and accepts only a replacement until one is stored', async () => {
    const { journals } = await overlarge();
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 })).toEqual({ refused: 'index_too_large', unserved: true });

    const opened = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true }) as JournalOpened;
    expect(opened).toMatchObject({ generation: 2, index: [], more: false });
    expect(journals.served(HOST, SESSION)).toBe(false);

    const next = opened.watermark + 1;
    expect((await journals.publish(HOST, SESSION, 2, [append(next, 'm4')])).refusal).toEqual({ sequence: next, reason: 'incomplete' });
    expect((await journals.publish(HOST, SESSION, 2, [head(next)])).refusal).toEqual({ sequence: next, reason: 'incomplete' });

    const replaced = await journals.publish(HOST, SESSION, 2, [
      { sequence: next, op: 'replace', items: [{ row: row('m3', 'm3'), digest: 'digest-m3' }] },
      head(next + 1),
    ]);
    expect(replaced.refusal).toBeUndefined();
    expect(replaced.hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const again = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 }) as JournalOpened;
    expect(again.index.map(entry => entry.itemKey)).toEqual(['m3']);
  });

  it('refuses every entry but a replacement while the journal waits for one', async () => {
    const { journals } = await overlarge();
    const opened = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true }) as JournalOpened;
    const next = opened.watermark + 1;
    const binding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' as const };
    const refused: JournalPublishEntry[] = [
      complete(next, 'm1'), { sequence: next, op: 'seal', itemKey: 'm1' }, { sequence: next, op: 'alias', itemKey: 'm1', clientMessageId: 'operation-1' },
      { sequence: next, op: 'correct', row: row('m1', 'm1'), digest: 'digest-m1', expectedRevision: 1 },
      { sequence: next, op: 'prepend', items: [{ row: row('m0', 'm0'), digest: 'digest-m0' }] },
      { sequence: next, op: 'rebind', itemKey: 'm1', previous: binding, replacement: { ...binding, status: 'available' } },
      { sequence: next, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 },
    ];
    for (const entry of refused) expect((await journals.publish(HOST, SESSION, 2, [entry])).refusal).toEqual({ sequence: next, reason: 'incomplete' });
    expect((await journals.publish(HOST, SESSION, 2, [{ sequence: next, op: 'replace', items: [{ row: row('m3', 'm3'), digest: 'digest-m3' }] }])).refusal).toBeUndefined();
  });

  it('keeps the journal out of serving across a restart of the Relay until a replacement is stored', async () => {
    const { store, journals } = await overlarge();
    await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true });
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect(await restarted.servedSessions(HOST)).toEqual([]);
    const reopened = await restarted.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true }) as JournalOpened;
    expect((await restarted.publish(HOST, SESSION, reopened.generation, [append(reopened.watermark + 1, 'm4')])).refusal).toMatchObject({ reason: 'incomplete' });
  });

  it('opens a journal that has no head and no rows the same way', async () => {
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
    const opened = await journals.open(HOST, SESSION, 'controller-1', { ...LIMITS, reset: true }) as JournalOpened;
    expect(opened).toMatchObject({ generation: 1, index: [], more: false });
    expect(opened.unserved).toBeUndefined();
  });
});
