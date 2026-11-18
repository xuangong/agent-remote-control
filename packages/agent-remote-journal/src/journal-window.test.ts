import { describe, expect, it } from 'vitest';

import { indexOf, openJournal, text } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import { sequentialEpochs } from './testing.js';

/** `count` complete items, each its own turn unless `turn` says otherwise. */
function completeItems(count: number, turn: (at: number) => string | undefined = at => `turn-${at}`) {
  const { journal, publish } = openJournal();
  for (let at = 1; at <= count; at++) {
    const row = text(`m${at}`, `d${at}`, `text ${at}`, turn(at) ?? '');
    journal.append(publish(), turn(at) === undefined ? { ...row, turnId: undefined } : row);
    journal.complete(publish(), `m${at}`, `digest-${at}`);
  }
  return { journal, publish };
}
const resident = (journal: SessionJournal) => indexOf(journal).filter(entry => entry.resident).map(entry => entry.itemKey);

describe('the retained window', () => {
  it('is the latest turns or the latest items, whichever reaches further back', () => {
    const { journal } = completeItems(6);
    expect(journal.evict(2, 0)).toEqual(['m1', 'm2', 'm3', 'm4']);
    const second = completeItems(6);
    expect(second.journal.evict(2, 4)).toEqual(['m1', 'm2']);
    expect(resident(second.journal)).toEqual(['m3', 'm4', 'm5', 'm6']);
    const third = completeItems(6);
    expect(third.journal.evict(5, 2)).toEqual(['m1']);
  });

  it('counts an item without a turn as a turn of its own', () => {
    const { journal } = completeItems(5, () => undefined);
    expect(journal.evict(2)).toEqual(['m1', 'm2', 'm3']);
  });

  it('says where it starts, and where the next item will start when the journal is empty', () => {
    const { journal } = completeItems(6);
    expect(journal.windowStart(2)).toBe(5);
    expect(journal.windowStart(2, 4)).toBe(3);
    expect(journal.windowStart(50, 200)).toBe(1);
    expect(openJournal().journal.windowStart(2)).toBe(1);
  });

  it('evicts only the bodies of items whose sequence is in the range it is given', () => {
    const { journal } = completeItems(6);
    expect(journal.evictRange(2, 4)).toEqual(['m2', 'm3']);
    expect(journal.evictRange(2, 4)).toEqual([]);
    expect(resident(journal)).toEqual(['m1', 'm4', 'm5', 'm6']);
  });

  it('tells whether an item body is in memory', () => {
    const { journal } = completeItems(2);
    journal.evict(1);
    expect([journal.resident('m1'), journal.resident('m2'), journal.resident('nope')]).toEqual([false, true, false]);
  });
});

describe('an incomplete journal', () => {
  it('is marked, stored with the meta, and made whole again by a replacement', () => {
    const { journal, publish } = completeItems(2);
    expect(journal.incomplete).toBe(false);
    journal.takeChanges();
    journal.markIncomplete();
    expect(journal.takeChanges()?.meta.incomplete).toBe(true);
    expect(new SessionJournal(journal.state(), sequentialEpochs()).incomplete).toBe(true);
    journal.sync(publish(), [], { roomBytes: Number.MAX_SAFE_INTEGER });
    expect(journal.incomplete).toBe(false);
  });
});

describe('the live-only totals', () => {
  it('follow items that become live-only, stop being so, or are dropped', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'first', 'turn-1'));
    expect(journal.liveOnlyCount).toBe(0);
    expect(journal.liveOnlyBytes()).toBe(0);
    journal.append(publish(), { ...text('m1', 'd1b', ' more', 'turn-1'), liveOnly: true });
    journal.complete(publish(), 'm1', 'digest-m1');
    expect(journal.liveOnlyCount).toBe(1);
    const sealedBytes = journal.liveOnlyBytes();
    expect(sealedBytes).toBeGreaterThan(0);
    journal.append(publish(), { ...text('l1', 'l1', 'live', 'turn-0'), liveOnly: true });
    journal.complete(publish(), 'l1', 'digest-l1');
    expect(journal.liveOnlyBytes()).toBeGreaterThan(sealedBytes);
    journal.dropOldestLiveOnly(0);
    expect(journal.liveOnlyCount).toBe(0);
    expect(journal.liveOnlyBytes()).toBe(0);
  });
});
