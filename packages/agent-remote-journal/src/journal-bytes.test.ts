import { describe, expect, it, vi } from 'vitest';

import { indexOf, openJournal, text } from './journal.test-fixture.js';

const big = (character: string) => character.repeat(10_000);
const snapshot = {
  id: 's', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 's', status: 'idle' as const },
};

describe('what a journal knows about its own size', () => {
  it('counts resident bodies and shrinks when they are evicted', () => {
    const { journal, publish } = openJournal();
    for (const [at, key] of ['m1', 'm2', 'm3'].entries()) {
      journal.append(publish(), text(key, `d${at}`, big(String(at)), `turn-${at}`));
      journal.complete(publish(), key, `digest-${key}`);
    }
    const full = journal.residentBytes();
    expect(full).toBeGreaterThan(30_000);
    expect(journal.evict(1)).toEqual(['m1', 'm2']);
    const kept = journal.residentBytes();
    expect(kept).toBeLessThan(full - 15_000);
    expect(kept).toBeGreaterThan(10_000);
  });

  it('grows when an item is extended', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', big('a')));
    const first = journal.residentBytes();
    journal.append(publish(), text('m1', 'd2', big('b')));
    expect(journal.residentBytes()).toBeGreaterThan(first + 9_000);
  });

  it('measures only the items that changed, not the whole journal', () => {
    const { journal, publish } = openJournal();
    for (let at = 0; at < 200; at++) journal.append(publish(), text(`m${at}`, `d${at}`, 'x'.repeat(100)));
    journal.residentBytes();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      journal.append(publish(), text('m200', 'd200', 'y'.repeat(100)));
      journal.residentBytes();
      journal.residentBytes();
      expect(stringify.mock.calls.length).toBeLessThanOrEqual(12);
    } finally { stringify.mockRestore(); }
  });

  it('reports the same size with the changes it hands to a store', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', big('a')));
    const changes = journal.takeChanges()!;
    expect(changes.bytes).toBe(journal.residentBytes());
    expect(changes.bytes).toBeGreaterThan(10_000);
    expect(changes.removed).toEqual([]);
  });

  it('knows how many items it holds, which, and whether it has a head', () => {
    const { journal, publish } = openJournal();
    expect(journal.hasHead).toBe(false);
    journal.append(publish(), text('m1', 'd1', 'one'));
    journal.append(publish(), text('m2', 'd2', 'two'));
    journal.append(publish(), text('m2', 'd3', 'more'));
    expect(journal.itemCount).toBe(2);
    expect(journal.has('m2')).toBe(true);
    expect(journal.has('m3')).toBe(false);
    journal.setHead(publish(), { snapshot, observedAt: 1 });
    expect(journal.hasHead).toBe(true);
  });

  it('clears its head and hands the change to the store', () => {
    const { journal, publish } = openJournal();
    journal.setHead(publish(), { snapshot, observedAt: 1 });
    journal.takeChanges();
    journal.clearHead();
    expect(journal.hasHead).toBe(false);
    expect(journal.takeChanges()!.meta.head).toBeUndefined();
  });
});

describe('live-only items', () => {
  const live = (key: string) => ({ ...text(key, `s-${key}`, `body ${key}`), liveOnly: true });

  it('counts them and the bytes they take', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), live('l1'));
    journal.append(publish(), text('m1', 'd1', big('a')));
    expect(journal.liveOnlyCount).toBe(1);
    expect(journal.liveOnlyBytes()).toBeGreaterThan(0);
    expect(journal.liveOnlyBytes()).toBeLessThan(journal.residentBytes() - 10_000);
  });

  it('removes the oldest beyond the byte cap as well, and an open one only when asked', () => {
    const { journal, publish } = openJournal();
    for (const key of ['l1', 'l2', 'l3']) {
      journal.append(publish(), live(key));
      journal.complete(publish(), key, `digest-${key}`);
    }
    journal.append(publish(), live('open'));
    const each = journal.liveOnlyBytes() / 4;
    expect(journal.dropOldestLiveOnly(10, 2.5 * each)).toEqual(['l1', 'l2']);
    expect(indexOf(journal).map(entry => entry.itemKey)).toEqual(['l3', 'open']);
    expect(journal.dropOldestLiveOnly(10, 0)).toEqual(['l3']);
    expect(journal.has('open')).toBe(true);
    expect(journal.dropOldestLiveOnly(10, 0, true)).toEqual(['open']);
  });

  it('removes the oldest beyond the cap, item and body, and tells the store', () => {
    const { journal, publish } = openJournal();
    for (const key of ['l1', 'l2', 'l3']) {
      journal.append(publish(), live(key));
      journal.complete(publish(), key, `digest-${key}`);
    }
    journal.append(publish(), text('m1', 'd1', 'kept'));
    journal.takeChanges();
    expect(journal.dropOldestLiveOnly(1)).toEqual(['l1', 'l2']);
    expect(indexOf(journal).map(entry => entry.itemKey)).toEqual(['l3', 'm1']);
    expect(journal.liveOnlyCount).toBe(1);
    const changes = journal.takeChanges()!;
    expect(changes.removed).toEqual(['l1', 'l2']);
    expect(journal.dropOldestLiveOnly(5)).toEqual([]);
  });
});
