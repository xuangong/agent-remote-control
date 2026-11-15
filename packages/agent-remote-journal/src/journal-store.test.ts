import { describe, expect, it } from 'vitest';

import { MemoryJournalStore } from './journal-store.js';
import { SessionJournal } from './session-journal.js';
import { openJournal, text } from './journal.test-fixture.js';

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
    await store.apply(journal.takeChanges()!);
    journal.replace(publish(), [{ row: text('m2', 'h2', 'Fresh'), digest: 'digest-2' }], 0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m2']);
    await store.delete(journal.sessionKey);
    expect(await store.load(journal.sessionKey)).toBeUndefined();
  });
});
