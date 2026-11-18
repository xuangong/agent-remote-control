import { describe, expect, it } from 'vitest';

import { SessionJournal } from './session-journal.js';
import { decideWindow } from './window-decision.js';
import { describeDecision, heldTail, windowItems, windowVectors } from './window-vectors.js';
import { sequentialEpochs } from './testing.js';

describe('SessionJournal.sync over the window vectors', () => {
  it.each(windowVectors.map(vector => [vector.name, vector] as const))('%s', (_name, vector) => {
    const tail = heldTail(vector);
    const journal = new SessionJournal({
      meta: { sessionKey: 'host-1:codex:session-1', epoch: 'epoch-1', nextSeq: tail.items.length + 1, minSeq: 1, publisher: { publisherId: 'p', generation: 1, watermark: 0 }, ...(vector.incomplete ? { incomplete: true as const } : {}) },
      items: [...tail.items],
    }, sequentialEpochs());
    const roomBytes = vector.room === undefined ? Number.MAX_SAFE_INTEGER : journal.residentBytes() + vector.room.roomBytes - vector.room.resident;
    const result = journal.sync({ publisherId: 'p', generation: 1, sequence: 1 }, windowItems(vector), { roomBytes });
    const { expect: wanted } = vector;
    if (wanted.outcome === 'unchanged') expect(result).toEqual({ outcome: 'unchanged' });
    else if (wanted.outcome === 'replace') expect(result).toMatchObject({ outcome: 'replaced', reason: wanted.reason });
    else expect(result).toMatchObject({ outcome: 'appended', rows: expect.arrayContaining([]) });
    if (result.outcome === 'appended' && wanted.outcome === 'extend') {
      expect(result.rows.map(({ itemKey }) => itemKey).sort()).toEqual([...wanted.append, ...(wanted.update ?? [])].sort());
    }
  });
});

describe('decideWindow', () => {
  it.each(windowVectors.map(vector => [vector.name, vector] as const))('%s', (_name, vector) => {
    const window = windowItems(vector);
    const decision = decideWindow(heldTail(vector), window, vector.room === undefined ? undefined : { roomBytes: vector.room.roomBytes });
    expect(describeDecision(decision, window)).toEqual(vector.expect);
  });

  it('has a vector for every outcome and every reason', () => {
    const seen = new Set(windowVectors.map(({ expect: { outcome, ...rest } }) => `${outcome}${'reason' in rest ? `:${rest.reason}` : ''}`));
    expect([...seen].sort()).toEqual(['extend', 'replace:changed', 'replace:incomplete', 'replace:new', 'replace:open_item', 'unchanged']);
  });

  it('sizes an extension by the items it writes, and nothing else', () => {
    const vector = windowVectors.find(({ name }) => name === 'a rewrite in place and an extension are one append')!;
    const window = windowItems(vector);
    const decision = decideWindow(heldTail(vector), window);
    if (decision.outcome !== 'extend') throw new Error('expected an extension');
    const written = window.filter(({ row }) => row.itemKey === 'b' || row.itemKey === 'todo');
    expect(decision.bytes).toBe(written.reduce((sum, item) => sum + new TextEncoder().encode(JSON.stringify(item)).length, 0));
  });

  it('reads its arguments and writes nothing to them', () => {
    const vector = windowVectors.find(({ name }) => name === 'a rewrite in place and an extension are one append')!;
    const tail = heldTail(vector);
    const window = windowItems(vector);
    const before = JSON.stringify([tail.items, window]);
    decideWindow(tail, window);
    expect(JSON.stringify([tail.items, window])).toBe(before);
  });
});
