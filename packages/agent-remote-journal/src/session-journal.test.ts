import { describe, expect, it } from 'vitest';

import { expectNoChange, indexOf, openJournal, PUBLISHER, text } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import {
  JournalDuplicateItemError, JournalFencedError, JournalInvalidRowError, JournalItemTypeChangedError, JournalSequenceGapError,
  type JournalRowInput,
} from './types.js';

describe('SessionJournal', () => {
  it('stamps dense sequences and folds deltas into one item', () => {
    const { journal, publish } = openJournal();
    const first = journal.append(publish(), text('m1', 'd1', 'Hel'));
    const second = journal.append(publish(), text('m1', 'd2', 'lo'));
    expect([first?.seq, second?.seq]).toEqual([1, 2]);
    expect(journal.cursor).toEqual({ epoch: 'epoch-1', seq: 2 });
    expect(indexOf(journal)).toEqual([expect.objectContaining({ itemKey: 'm1', seqStart: 1, seqEnd: 2, state: 'open', resident: true })]);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ type: 'assistant_message', text: 'Hello' });
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

  it('completes and aliases items', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hello'));
    journal.complete(publish(), 'm1', 'digest-1');
    journal.append(publish(), { itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, item: { type: 'user_message', text: 'Hi' } });
    journal.alias(publish(), 'u1', 'operation-1');
    const index = indexOf(journal);
    expect(index[0]).toMatchObject({ itemKey: 'm1', state: 'complete', digest: 'digest-1' });
    expect(index[1]).toMatchObject({ itemKey: 'u1', clientMessageId: 'operation-1' });
    expect(journal.state().items[1]?.body?.item).toMatchObject({ clientMessageId: 'operation-1' });
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

  it('starts a new epoch with one sequence per item', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Old'));
    journal.complete(publish(), 'm1', 'digest-1');
    journal.takeChanges();
    const result = journal.sync(publish(), [{ row: text('m2', 'h2', 'Fresh'), digest: 'digest-2' }], { roomBytes: Number.MAX_SAFE_INTEGER });
    if (result.outcome !== 'replaced') throw new Error('Expected a replacement.');
    const { epoch } = result;
    expect(epoch).not.toBe('epoch-1');
    expect(journal.cursor).toEqual({ epoch, seq: 1 });
    expect(indexOf(journal)).toEqual([expect.objectContaining({ itemKey: 'm2', seqStart: 1, seqEnd: 1, state: 'complete', digest: 'digest-2' })]);
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
    expect(indexOf(journal).map(({ itemKey, seqStart }) => [itemKey, seqStart])).toEqual([['m1', -1], ['m2', 0], ['m3', 1]]);
    expect(indexOf(journal)[0]).toMatchObject({ state: 'complete', digest: 'digest-1' });
  });

  describe('leaves the journal unchanged when a call throws', () => {
    it('for an invalid timestamp', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Hel'));
      expectNoChange(journal, () => journal.append(publish(), { ...text('m2', 'd2', 'x'), occurredAt: Number.NaN }), JournalInvalidRowError);
    });

    it('for a row that changes its item\'s type', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Hel'));
      expectNoChange(journal, () => journal.append(publish(), {
        itemKey: 'm1', providerId: 'codex', sourceKey: 'r1', occurredAt: 0, item: { type: 'reasoning', text: 'x' },
      }), JournalItemTypeChangedError);
    });

    it('for a replacement with an invalid timestamp', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Old'));
      expectNoChange(journal, () => journal.sync(publish(), [
        { row: text('m2', 'h2', 'a'), digest: 'd2' },
        { row: { ...text('m3', 'h3', 'b'), occurredAt: 9e15 }, digest: 'd3' },
      ], { roomBytes: Number.MAX_SAFE_INTEGER }), JournalInvalidRowError);
    });

    it('for a replacement that repeats an item key', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Old'));
      expectNoChange(journal, () => journal.sync(publish(), [
        { row: text('m2', 'h2', 'a'), digest: 'd2' },
        { row: text('m2', 'h3', 'b'), digest: 'd3' },
      ], { roomBytes: Number.MAX_SAFE_INTEGER }), JournalDuplicateItemError);
    });

    it('for a prepend that exhausts positions', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Now'));
      const state = journal.state();
      state.meta.minSeq = Number.MIN_SAFE_INTEGER + 1;
      state.items[0]!.seqStart = Number.MIN_SAFE_INTEGER + 1;
      const exhausted = new SessionJournal(state);
      const publication = { publisherId: PUBLISHER, generation: 1, sequence: 2 };
      expectNoChange(exhausted, () => exhausted.prepend(publication, ['a', 'b', 'c'].map(key => ({ row: text(key, key, key), digest: key }))), /exhausted/);
    });
  });

  it('refuses a publication from another publisher that carries the current generation', () => {
    const { journal } = openJournal();
    const foreign = { publisherId: 'controller-2', generation: 1, sequence: 1 };
    expect(() => journal.append(foreign, text('m1', 'd1', 'Hel'))).toThrow(JournalFencedError);
  });

  it('prepends batches contiguously, skips repeats and tracks the lowest sequence', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m5', 'd5', 'Now'));
    const complete = (key: string) => ({ row: text(key, key, key), digest: `digest-${key}` });
    journal.prepend(publish(), [complete('m3'), complete('m4')]);
    journal.prepend(publish(), [complete('m1'), complete('m2')]);
    expect(indexOf(journal).map(({ itemKey, seqStart }) => [itemKey, seqStart])).toEqual([
      ['m1', -3], ['m2', -2], ['m3', -1], ['m4', 0], ['m5', 1],
    ]);
    expect(journal.prepend(publish(), [complete('m1'), complete('m2')])).toEqual([]);
    expect(journal.prepend(publish(), [complete('m0'), complete('m0')]).map(({ itemKey }) => itemKey)).toEqual(['m0']);
    expect(journal.state().meta.minSeq).toBe(-4);
    expect(indexOf(journal)[0]).toMatchObject({ itemKey: 'm0', seqStart: -4 });
  });

  it('does not let a returned row change the journal', () => {
    const { journal, publish } = openJournal();
    const call = (sourceKey: string): JournalRowInput => ({
      itemKey: 'c1', providerId: 'codex', sourceKey, occurredAt: 0,
      item: { type: 'tool_call', callId: 'call-1', name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: 'ls' }, background: { id: 'review-1', kind: 'review', status: 'visible' } },
      resources: [],
    });
    const first = journal.append(publish(), call('s1'))!;
    const second = journal.append(publish(), call('s2'))!;
    const before = journal.state();
    for (const row of [first, second]) {
      if (row.item.type === 'tool_call') {
        row.item.name = 'changed';
        if (row.item.background) row.item.background.status = 'hidden' as never;
      }
      row.resources.push({ id: 'r' } as never);
    }
    expect(journal.state()).toEqual(before);
  });

  it('reopens a completed item that receives more content', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    journal.complete(publish(), 'm1', 'digest-1');
    journal.append(publish(), text('m1', 'd2', 'lo'));
    expect(indexOf(journal)[0]).toMatchObject({ state: 'open' });
    expect(indexOf(journal)[0]?.digest).toBeUndefined();
  });

  it('prepends 200,000 items and keeps the sequence contiguous', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('last', 'dl', 'last'));
    const older = Array.from({ length: 200_000 }, (_, at) => ({ row: text(`k${at}`, `s${at}`, 'x'), digest: `d${at}` }));
    const rows = journal.prepend(publish(), older);
    expect(rows).toHaveLength(200_000);
    const items = journal.state().items;
    expect(items).toHaveLength(200_001);
    expect(items[0]?.seqStart).toBe(1 - 200_000);
    expect(items.every((item, at) => at === 0 || item.seqStart === (items[at - 1] as typeof item).seqEnd + 1)).toBe(true);
  });
});

describe('publication sequences', () => {
  const at = (sequence: number) => ({ publisherId: PUBLISHER, generation: 1, sequence });

  it('refuses a publication that skips ahead of the watermark and changes nothing', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'one'));
    expectNoChange(journal, () => journal.append(at(3), text('m2', 'd2', 'two')), JournalSequenceGapError);
    expectNoChange(journal, () => journal.complete(at(5), 'm1', 'digest-1'), JournalSequenceGapError);
    expect(journal.publisher?.watermark).toBe(1);
    expect(journal.append(at(2), text('m2', 'd2', 'two'))?.seq).toBe(2);
  });

  it('skips a duplicate of an applied publication and refuses every later one after a failed entry, also after the journal is stored and loaded again', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'one'));
    expect(journal.append(at(1), text('m1', 'd9', 'again'))).toBeUndefined();
    expect(() => journal.complete(at(2), 'unknown', 'digest')).toThrow();
    const reloaded = new SessionJournal(journal.state());
    expect(() => reloaded.append(at(3), text('m2', 'd2', 'two'))).toThrow(JournalSequenceGapError);
    expect(indexOf(reloaded).map(entry => entry.itemKey)).toEqual(['m1']);
  });
});
