import { describe, expect, it } from 'vitest';

import { planReconcile } from './reconcile.js';
import type { JournalIndexEntry } from './types.js';

const entry = (itemKey: string, digest: string | undefined, extra: Partial<JournalIndexEntry> = {}): JournalIndexEntry => ({
  itemKey, seqStart: 0, seqEnd: 0, state: 'complete', ...(digest === undefined ? {} : { digest }), liveOnly: false, revision: 1, resident: true, ...extra,
});
const journal = [entry('a', 'da'), entry('b', 'db'), entry('c', 'dc')];

describe('planReconcile', () => {
  it('continues with nothing to do when the reread matches', () => {
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }]))
      .toEqual({ kind: 'continue', append: [], correct: [], abandon: [] });
  });

  it('appends new items after the known ones and corrects changed or open items', () => {
    const index = [entry('a', 'da'), entry('b', undefined, { state: 'open' }), entry('c', 'dc')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'changed' }, { itemKey: 'd', digest: 'dd' }]))
      .toEqual({ kind: 'continue', append: ['d'], correct: ['b', 'c'], abandon: [] });
  });

  it('compares only inside the reread window, leaving older journal items alone', () => {
    expect(planReconcile(journal, [{ itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }, { itemKey: 'd', digest: 'dd' }]))
      .toEqual({ kind: 'continue', append: ['d'], correct: [], abandon: [] });
  });

  it('ignores live-only journal items', () => {
    const index = [entry('a', 'da'), entry('ask', 'dask', { liveOnly: true }), entry('b', 'db')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }]).kind).toBe('continue');
  });

  it('abandons open items the native history never kept', () => {
    const index = [entry('a', 'da'), entry('b', undefined, { state: 'open' }), entry('c', 'dc'), entry('d', undefined, { state: 'open' })];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'c', digest: 'dc' }]))
      .toEqual({ kind: 'continue', append: [], correct: [], abandon: ['b', 'd'] });
  });

  it('replaces when a complete item inside the window is missing, reordered or preceded by a new one', () => {
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'c', digest: 'dc' }])).toEqual({ kind: 'replace', reason: 'missing' });
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }])).toEqual({ kind: 'replace', reason: 'missing' });
    expect(planReconcile(journal, [{ itemKey: 'b', digest: 'db' }, { itemKey: 'a', digest: 'da' }])).toEqual({ kind: 'replace', reason: 'reordered' });
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'x', digest: 'dx' }, { itemKey: 'b', digest: 'db' }])).toEqual({ kind: 'replace', reason: 'inserted' });
    expect(planReconcile(journal, [{ itemKey: 'x', digest: 'dx' }, { itemKey: 'c', digest: 'dc' }])).toEqual({ kind: 'replace', reason: 'inserted' });
  });

  it('asks for older history when the reread starts after everything the journal knows', () => {
    expect(planReconcile(journal, [{ itemKey: 'x', digest: 'dx' }, { itemKey: 'y', digest: 'dy' }])).toEqual({ kind: 'gap' });
  });

  it('appends everything to an empty journal and replaces a journal whose native history is now empty', () => {
    expect(planReconcile([], [{ itemKey: 'a', digest: 'da' }])).toEqual({ kind: 'continue', append: ['a'], correct: [], abandon: [] });
    expect(planReconcile(journal, [])).toEqual({ kind: 'replace', reason: 'missing' });
    expect(planReconcile([entry('a', undefined, { state: 'open' })], [])).toEqual({ kind: 'continue', append: [], correct: [], abandon: ['a'] });
  });
});
