import { describe, expect, it } from 'vitest';

import { bodyFromRow } from './journal-items.js';
import { openJournal, text } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import type { JournalRowInput } from './types.js';

const encoder = new TextEncoder();
const utf8 = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** The size of a journal measured from scratch: its meta and every item record, in UTF-8 bytes of JSON. */
function recomputed(journal: SessionJournal): number {
  const { meta, items } = journal.state();
  return utf8(meta) + items.reduce((total, item) => total + utf8(item), 0);
}

/** What the journal reports, what it hands to a store, and what a journal rebuilt from its state reports must all be the recomputed size. */
function expectSizeToHold(journal: SessionJournal, label: string): void {
  const expected = recomputed(journal);
  expect(journal.residentBytes(), `${label}: residentBytes`).toBe(expected);
  expect(journal.takeChanges()?.bytes ?? expected, `${label}: changes.bytes`).toBe(expected);
  expect(new SessionJournal(journal.state()).residentBytes(), `${label}: after a reload`).toBe(expected);
}

const snapshot = {
  id: 's', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 's', status: 'idle' as const },
};

describe('the running size of a journal', () => {
  it('equals a full recomputation after every kind of operation and after a reload', () => {
    const { journal, publish } = openJournal();
    const row = (key: string, chunk: string, turn: string): JournalRowInput => text(key, `d-${key}-${chunk.length}`, chunk, turn);
    expectSizeToHold(journal, 'a new journal');
    journal.append(publish(), row('m1', 'one', 't1'));
    expectSizeToHold(journal, 'append');
    journal.append(publish(), row('m1', 'one more', 't1'));
    expectSizeToHold(journal, 'extending append');
    journal.complete(publish(), 'm1', 'digest-m1');
    expectSizeToHold(journal, 'complete');
    journal.append(publish(), { ...row('l1', 'live', 't2'), liveOnly: true });
    journal.seal(publish(), 'l1');
    expectSizeToHold(journal, 'seal');
    journal.alias(publish(), 'm1', 'operation-1');
    expectSizeToHold(journal, 'alias');
    journal.correct(publish(), row('m1', 'corrected text', 't1'), 'digest-m1b', journal.state().items.find(item => item.itemKey === 'm1')!.revision);
    expectSizeToHold(journal, 'correct');
    journal.prepend(publish(), [{ row: row('m0', 'older', 't0'), digest: 'digest-m0' }]);
    expectSizeToHold(journal, 'prepend');
    journal.setHead(publish(), { snapshot, observedAt: 1 });
    expectSizeToHold(journal, 'head');
    journal.evict(0);
    expectSizeToHold(journal, 'evict');
    journal.fill('m1', bodyFromRow(row('m1', 'corrected text', 't1')), 'digest-m1b');
    expectSizeToHold(journal, 'fill');
    journal.append(publish(), { ...row('l2', 'live two', 't3'), liveOnly: true });
    journal.seal(publish(), 'l2');
    expect(journal.dropOldestLiveOnly(1)).toEqual(['l1']);
    expectSizeToHold(journal, 'dropOldestLiveOnly');
    journal.clearHead();
    expectSizeToHold(journal, 'clearHead');
    journal.replace(publish(), [{ row: row('n1', 'fresh', 't9'), digest: 'digest-n1' }], 0);
    expectSizeToHold(journal, 'replace');
    journal.append(publish(), row('n2', 'after the replacement', 't9'));
    expectSizeToHold(journal, 'append after replace');
  });

  it('counts UTF-8 bytes, three for a Chinese character and four for an emoji', () => {
    const ascii = openJournal();
    ascii.journal.append(ascii.publish(), text('m1', 'd1', 'a'.repeat(300)));
    const chinese = openJournal();
    chinese.journal.append(chinese.publish(), text('m1', 'd1', '字'.repeat(300)));
    const emoji = openJournal();
    emoji.journal.append(emoji.publish(), text('m1', 'd1', '😀'.repeat(300)));
    expect(chinese.journal.residentBytes() - ascii.journal.residentBytes()).toBe(600);
    expect(emoji.journal.residentBytes() - ascii.journal.residentBytes()).toBe(900);
    expectSizeToHold(chinese.journal, 'chinese');
    expectSizeToHold(emoji.journal, 'emoji');
  });

  it.each([1, 2, 3, 4, 5, 6])('equals a full recomputation through a random run of operations (seed %i)', seed => {
    let state = seed * 2_654_435_761;
    const random = (limit: number) => { state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + 1_013_904_223) >>> 0; return state % limit; };
    const { journal, publish } = openJournal();
    let counter = 0;
    const words = ['plain', '字符很多的文本', '😀 emoji', 'x'.repeat(400)];
    const key = () => `k${random(12)}`;
    const row = (itemKey: string): JournalRowInput => ({ ...text(itemKey, `d${++counter}`, words[random(words.length)]!, `turn-${random(5)}`), ...(random(4) === 0 ? { liveOnly: true } : {}) });
    const known = () => journal.state().items;
    for (let step = 0; step < 150; step++) {
      const items = known();
      const pick = items.length === 0 ? undefined : items[random(items.length)]!;
      try {
        switch (random(12)) {
          case 0: case 1: journal.append(publish(), row(pick && random(2) ? pick.itemKey : key())); break;
          case 2: if (pick) journal.complete(publish(), pick.itemKey, `digest-${pick.itemKey}`); break;
          case 3: if (pick) journal.seal(publish(), pick.itemKey); break;
          case 4: if (pick) journal.alias(publish(), pick.itemKey, `operation-${++counter}`); break;
          case 5: if (pick) journal.correct(publish(), { ...row(pick.itemKey), liveOnly: false }, `digest-${++counter}`, pick.revision); break;
          case 6: journal.prepend(publish(), [{ row: { ...row(`p${++counter}`), liveOnly: false }, digest: `digest-p${counter}` }]); break;
          case 7: journal.evict(random(3)); break;
          case 8: if (pick?.digest !== undefined) journal.fill(pick.itemKey, bodyFromRow({ ...row(pick.itemKey), liveOnly: false }), pick.digest); break;
          case 9: journal.dropOldestLiveOnly(random(3)); break;
          case 10: random(2) ? journal.clearHead() : journal.setHead(publish(), { snapshot, observedAt: step }); break;
          default: if (random(6) === 0) journal.replace(publish(), [{ row: { ...row(`r${++counter}`), liveOnly: false }, digest: `digest-r${counter}` }], step); break;
        }
      } catch { /* an operation the journal refuses changes nothing */ }
      expectSizeToHold(journal, `seed ${seed} step ${step}`);
    }
  });
});

describe('dropping live-only items', () => {
  it('never drops one that is still open, and keeps the open one growing in place', () => {
    const { journal, publish } = openJournal();
    const live = (key: string, chunk: string): JournalRowInput => ({ ...text(key, `s-${key}-${chunk}`, chunk), liveOnly: true });
    journal.append(publish(), live('open', 'first '));
    journal.append(publish(), live('sealed-1', 'a'));
    journal.seal(publish(), 'sealed-1');
    journal.append(publish(), live('sealed-2', 'b'));
    journal.seal(publish(), 'sealed-2');
    expect(journal.liveOnlyCount).toBe(3);
    expect(journal.dropOldestLiveOnly(0)).toEqual(['sealed-1', 'sealed-2']);
    expect(journal.has('open')).toBe(true);
    journal.append(publish(), live('open', 'second'));
    expect(journal.state().items.find(item => item.itemKey === 'open')?.body?.item).toMatchObject({ text: 'first second' });
    expectSizeToHold(journal, 'after dropping around an open item');
  });
});
