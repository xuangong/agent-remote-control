import { describe, expect, it } from 'vitest';

import { expectNoChange, openJournal, PUBLISHER, text } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import {
  JournalDuplicateItemError, JournalFencedError, JournalInvalidRowError, JournalItemTypeChangedError, JournalSequenceGapError, JournalStaleRevisionError,
  type JournalRowInput,
} from './types.js';

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
    journal.complete(publish(), 'm1', 'digest-1');
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

    it('for a correction against a stale revision', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Hel'));
      expectNoChange(journal, () => journal.correct(publish(), text('m1', 'h1', 'Hello'), 'digest', 99), JournalStaleRevisionError);
    });

    it('for a replacement with an invalid timestamp', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Old'));
      expectNoChange(journal, () => journal.replace(publish(), [
        { row: text('m2', 'h2', 'a'), digest: 'd2' },
        { row: { ...text('m3', 'h3', 'b'), occurredAt: 9e15 }, digest: 'd3' },
      ], 0), JournalInvalidRowError);
    });

    it('for a replacement that repeats an item key', () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'Old'));
      expectNoChange(journal, () => journal.replace(publish(), [
        { row: text('m2', 'h2', 'a'), digest: 'd2' },
        { row: text('m2', 'h3', 'b'), digest: 'd3' },
      ], 0), JournalDuplicateItemError);
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
    expect(journal.index().map(({ itemKey, seqStart }) => [itemKey, seqStart])).toEqual([
      ['m1', -3], ['m2', -2], ['m3', -1], ['m4', 0], ['m5', 1],
    ]);
    expect(journal.prepend(publish(), [complete('m1'), complete('m2')])).toEqual([]);
    expect(journal.prepend(publish(), [complete('m0'), complete('m0')]).map(({ itemKey }) => itemKey)).toEqual(['m0']);
    expect(journal.state().meta.minSeq).toBe(-4);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'm0', seqStart: -4 });
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
    expect(journal.index()[0]).toMatchObject({ state: 'open' });
    expect(journal.index()[0]?.digest).toBeUndefined();
  });

  describe('replacement of an epoch with live-only items', () => {
    const ask: JournalRowInput = { itemKey: 'ask', providerId: 'codex', sourceKey: 'ask', occurredAt: 0, liveOnly: true, item: { type: 'reasoning', text: 'q' } };
    const reread = (...keys: string[]) => keys.map(key => ({ row: text(key, key, key), digest: `digest-${key}` }));
    const setup = () => {
      const { journal, publish } = openJournal();
      journal.append(publish(), text('m1', 'd1', 'One'));
      journal.complete(publish(), 'm1', 'digest-m1');
      journal.append(publish(), ask);
      journal.append(publish(), text('m2', 'd2', 'Two'));
      journal.complete(publish(), 'm2', 'digest-m2');
      return { journal, publish };
    };

    it('keeps one after the item that precedes it', () => {
      const { journal, publish } = setup();
      journal.replace(publish(), reread('m1', 'm2'), 0);
      expect(journal.index().map(({ itemKey, seqStart, seqEnd }) => [itemKey, seqStart, seqEnd])).toEqual([['m1', 1, 1], ['ask', 2, 2], ['m2', 3, 3]]);
      expect(journal.index()[1]).toMatchObject({ liveOnly: true });
      expect(journal.state().items[1]?.sourceSeqRanges).toEqual([{ startSeq: 2, endSeq: 2 }]);
      expect(journal.cursor.seq).toBe(3);
    });

    it('keeps one before the first item when its predecessor does not survive', () => {
      const { journal, publish } = setup();
      journal.replace(publish(), reread('m2'), 0);
      expect(journal.index().map(({ itemKey, seqStart }) => [itemKey, seqStart])).toEqual([['ask', 1], ['m2', 2]]);
    });
  });
  it('keeps the background outcome when a correction carries none', () => {
    const { journal, publish } = openJournal();
    const background = { id: 'review-1', kind: 'review' as const, status: 'visible' as const };
    const call = (extra: object) => ({ itemKey: 'c1', providerId: 'codex', sourceKey: 'c1', occurredAt: 0, item: { type: 'tool_call' as const, callId: 'c1', name: 'shell', status: 'completed' as const, error: null, detail: { type: 'shell' as const, command: 'ls' }, ...extra } });
    journal.append(publish(), call({ background }));
    journal.complete(publish(), 'c1', 'digest-1');
    const revision = journal.index()[0]?.revision as number;
    journal.correct(publish(), call({}), 'digest-2', revision);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ background });
  });

  it('treats a sealed item as relay-only', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Interrupt'));
    journal.seal(publish(), 'm1');
    expect(journal.index()[0]).toMatchObject({ state: 'complete', liveOnly: true });
    journal.replace(publish(), [{ row: text('m2', 'h2', 'Fresh'), digest: 'digest-2' }], 0);
    expect(journal.index().map(({ itemKey }) => itemKey)).toEqual(['m1', 'm2']);
  });

  it('keeps background and alias through a correction of an evicted item, and returns what pages show', () => {
    const { journal, publish } = openJournal();
    const background = { id: 'review-1', kind: 'review' as const, status: 'visible' as const };
    const user = { itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, turnId: 'turn-1', item: { type: 'user_message' as const, text: 'ask', background } };
    journal.append(publish(), user);
    journal.alias(publish(), 'u1', 'client-1');
    journal.complete(publish(), 'u1', 'digest-1');
    journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
    expect(journal.evict(1)).toEqual(['u1']);
    const revision = journal.index()[0]!.revision;
    const row = journal.correct(publish(), { ...user, item: { type: 'user_message', text: 'ask!' } }, 'digest-2', revision);
    const stored = journal.state().items[0]!;
    expect(stored.body?.item).toMatchObject({ text: 'ask!', clientMessageId: 'client-1', background });
    expect(row?.item).toEqual(stored.body?.item);
    expect(stored.liveOnly).toBe(false);
  });

  it('clears the live-only mark when native history corrects an item', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Interrupt'));
    journal.seal(publish(), 'm1');
    journal.correct(publish(), text('m1', 'h1', 'Interrupted'), 'digest-1', journal.index()[0]!.revision);
    expect(journal.index()[0]).toMatchObject({ liveOnly: false, digest: 'digest-1' });
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
    expect(reloaded.index().map(entry => entry.itemKey)).toEqual(['m1']);
  });
});
