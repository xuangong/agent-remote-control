import { describe, expect, it } from 'vitest';

import { openJournal, PUBLISHER, text } from './journal.test-fixture.js';
import { JournalFencedError, JournalItemTypeChangedError, JournalStaleRevisionError } from './types.js';

describe('SessionJournal', () => {
  it('stamps dense sequences and folds deltas into one item', () => {
    const { journal, publish } = openJournal();
    const first = journal.append(publish(), text('m1', 'd1', 'Hel'));
    const second = journal.append(publish(), text('m1', 'd2', 'lo'));
    expect([first?.seq, second?.seq]).toEqual([1, 2]);
    expect(journal.cursor).toEqual({ epoch: 'epoch-1', seq: 2 });
    expect(journal.index()).toEqual([expect.objectContaining({ itemKey: 'm1', seqStart: 1, seqEnd: 2, state: 'open', resident: true, revision: 2 })]);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ type: 'assistant_message', text: 'Hello' });
  });

  it('refuses a row that changes its item\'s type', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    expect(() => journal.append(publish(), {
      itemKey: 'm1', providerId: 'codex', sourceKey: 'r1', occurredAt: 0, item: { type: 'reasoning', text: 'x' },
    })).toThrow(JournalItemTypeChangedError);
    expect(journal.cursor.seq).toBe(1);
  });

  it('ignores a publication it already applied', () => {
    const { journal, publish } = openJournal();
    const publication = publish();
    expect(journal.append(publication, text('m1', 'd1', 'Hel'))?.seq).toBe(1);
    expect(journal.append(publication, text('m1', 'd1', 'Hel'))).toBeUndefined();
    expect(journal.cursor.seq).toBe(1);
  });

  it('fences off an older connection of the publisher', () => {
    const { journal, publish } = openJournal();
    const stale = publish();
    journal.claim(PUBLISHER);
    expect(() => journal.append(stale, text('m1', 'd1', 'Hel'))).toThrow(JournalFencedError);
  });

  it('resumes a reconnecting publisher after its watermark and starts a new one from zero', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    expect(journal.claim(PUBLISHER)).toEqual({ generation: 2, watermark: 1 });
    expect(journal.claim('controller-2')).toEqual({ generation: 3, watermark: 0 });
  });

  it('completes, seals and aliases items', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hello'));
    journal.complete(publish(), 'm1', 'digest-1');
    journal.append(publish(), { itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, item: { type: 'user_message', text: 'Hi' } });
    journal.alias(publish(), 'u1', 'operation-1');
    journal.append(publish(), text('m2', 'd2', 'Interrupt'));
    journal.seal(publish(), 'm2');
    const index = journal.index();
    expect(index[0]).toMatchObject({ itemKey: 'm1', state: 'complete', digest: 'digest-1' });
    expect(index[1]).toMatchObject({ itemKey: 'u1', clientMessageId: 'operation-1' });
    expect(journal.state().items[1]?.body?.item).toMatchObject({ clientMessageId: 'operation-1' });
    expect(index[2]).toMatchObject({ itemKey: 'm2', state: 'complete' });
    expect(index[2]?.digest).toBeUndefined();
  });

  it('hands out only what changed', () => {
    const { journal, publish } = openJournal();
    journal.takeChanges();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    const changes = journal.takeChanges();
    expect(changes?.upsert.map(({ itemKey }) => itemKey)).toEqual(['m1']);
    expect(changes?.meta.nextSeq).toBe(2);
    expect(changes?.replaced).toBe(false);
    expect(journal.takeChanges()).toBeUndefined();
  });

  it('corrects an item that has not moved since the index was read', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    journal.complete(publish(), 'm1', 'digest-old');
    const revision = journal.index()[0]!.revision;
    const row = journal.correct(publish(), text('m1', 'h1', 'Hello!'), 'digest-new', revision);
    expect(row?.seq).toBe(2);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'm1', seqStart: 1, seqEnd: 2, state: 'complete', digest: 'digest-new' });
    expect(journal.state().items[0]?.sourceSeqRanges).toEqual([{ startSeq: 1, endSeq: 2 }]);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ text: 'Hello!' });
  });

  it('refuses a correction computed against an older revision', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    const revision = journal.index()[0]!.revision;
    journal.append(publish(), text('m1', 'd2', 'lo'));
    expect(() => journal.correct(publish(), text('m1', 'h1', 'Hello'), 'digest', revision)).toThrow(JournalStaleRevisionError);
  });

  it('replaces the epoch with one sequence per item and remembers the retired epoch', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Old'));
    journal.takeChanges();
    const epoch = journal.replace(publish(), [{ row: text('m2', 'h2', 'Fresh'), digest: 'digest-2' }], 1_725_000_000_000);
    expect(epoch).not.toBe('epoch-1');
    expect(journal.cursor).toEqual({ epoch, seq: 1 });
    expect(journal.index()).toEqual([expect.objectContaining({ itemKey: 'm2', seqStart: 1, seqEnd: 1, state: 'complete', digest: 'digest-2' })]);
    expect(journal.state().meta.retiredEpochs).toEqual([{ epoch: 'epoch-1', retiredAt: 1_725_000_000_000 }]);
    const changes = journal.takeChanges();
    expect(changes?.replaced).toBe(true);
    expect(changes?.upsert.map(({ itemKey }) => itemKey)).toEqual(['m2']);
  });

  it('prepends older items below the lowest sequence in one batch and skips known ones', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m3', 'd3', 'Now'));
    const rows = journal.prepend(publish(), [
      { row: text('m1', 'h1', 'Oldest'), digest: 'digest-1' },
      { row: text('m2', 'h2', 'Older'), digest: 'digest-2' },
      { row: text('m3', 'h3', 'Now'), digest: 'digest-3' },
    ]);
    expect(rows.map(({ itemKey, seq }) => [itemKey, seq])).toEqual([['m1', -1], ['m2', 0]]);
    expect(journal.index().map(({ itemKey, seqStart }) => [itemKey, seqStart])).toEqual([['m1', -1], ['m2', 0], ['m3', 1]]);
    expect(journal.index()[0]).toMatchObject({ state: 'complete', digest: 'digest-1' });
  });
});
