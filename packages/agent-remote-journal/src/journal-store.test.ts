import { describe, expect, it } from 'vitest';

import { bodyFromRow } from './journal-items.js';
import { MemoryJournalStore } from './journal-store.js';
import { SessionJournal } from './session-journal.js';
import { openJournal, text } from './journal.test-fixture.js';

const snapshot = () => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
});

describe('MemoryJournalStore', () => {
  it('restores a journal from the changes it applied', async () => {
    const store = new MemoryJournalStore();
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    await store.apply(journal.takeChanges()!);
    journal.append(publish(), text('m1', 'd2', 'lo'));
    journal.append(publish(), text('m2', 'd3', 'Next'));
    await store.apply(journal.takeChanges()!);
    const restored = new SessionJournal((await store.load(journal.sessionKey))!);
    expect(restored.index()).toEqual(journal.index());
    expect(restored.cursor).toEqual(journal.cursor);
    const request = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };
    expect(restored.page(request, { olderBeyondJournal: false })).toEqual(journal.page(request, { olderBeyondJournal: false }));
  });

  it('drops the old items after a replacement and deletes a journal', async () => {
    const store = new MemoryJournalStore();
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Old'));
    journal.complete(publish(), 'm1', 'digest-1');
    await store.apply(journal.takeChanges()!);
    journal.replace(publish(), [{ row: text('m2', 'h2', 'Fresh'), digest: 'digest-2' }], 0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m2']);
    await store.delete(journal.sessionKey);
    expect(await store.load(journal.sessionKey)).toBeUndefined();
  });

  it('restores an equivalent journal after evict, fill and prepend', async () => {
    const store = new MemoryJournalStore();
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'first', 'turn-1'));
    journal.complete(publish(), 'm1', 'digest-1');
    journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
    await store.apply(journal.takeChanges()!);
    journal.evict(1);
    journal.prepend(publish(), [{ row: text('m0', 'd0', 'zeroth', 'turn-0'), digest: 'digest-0' }]);
    await store.apply(journal.takeChanges()!);
    journal.fill('m1', bodyFromRow(text('m1', 'd1', 'first', 'turn-1')), 'digest-1');
    await store.apply(journal.takeChanges()!);
    const restored = new SessionJournal((await store.load(journal.sessionKey))!);
    expect(restored.state()).toEqual(journal.state());
  });

  it('deletes the items a journal removed', async () => {
    const store = new MemoryJournalStore();
    const { journal, publish } = openJournal();
    journal.append(publish(), { ...text('l1', 's1', 'live'), liveOnly: true });
    journal.append(publish(), text('m1', 'd1', 'kept'));
    await store.apply(journal.takeChanges()!);
    journal.dropOldestLiveOnly(0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('lists stored journals by key prefix with their head flag and size, and deletes them by prefix', async () => {
    const store = new MemoryJournalStore();
    const keep = openJournal();
    const other = SessionJournal.create('host-2:codex:session-1', 'epoch-2');
    const { generation } = other.claim('controller-1');
    other.append({ publisherId: 'controller-1', generation, sequence: 1 }, text('m1', 'd1', 'Hello'));
    keep.journal.append(keep.publish(), text('m1', 'd1', 'Hello'));
    keep.journal.setHead(keep.publish(), { snapshot: snapshot(), observedAt: 5 });
    await store.apply(keep.journal.takeChanges()!);
    await store.apply(other.takeChanges()!);
    expect(await store.catalog.list('host-1:')).toEqual([{ sessionKey: 'host-1:codex:session-1', hasHead: true, bytes: expect.any(Number) }]);
    expect((await store.catalog.list('')).map(({ sessionKey, hasHead }) => [sessionKey, hasHead])).toEqual([['host-1:codex:session-1', true], ['host-2:codex:session-1', false]]);
    await store.catalog.deletePrefix('host-2:');
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['host-1:codex:session-1']);
  });
});
