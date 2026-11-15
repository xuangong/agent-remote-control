import { describe, expect, it } from 'vitest';

import { JournalDuplicateItemError } from './types.js';
import { planReconcile } from './reconcile.js';
import type { JournalIndexEntry } from './types.js';

const entry = (itemKey: string, digest: string | undefined, extra: Partial<JournalIndexEntry> = {}): JournalIndexEntry => ({
  itemKey, seqStart: 0, seqEnd: 0, state: 'complete', ...(digest === undefined ? {} : { digest }), liveOnly: false, revision: 1, resident: true, ...extra,
});
const journal = [entry('a', 'da'), entry('b', 'db'), entry('c', 'dc')];

describe('planReconcile', () => {
  it('continues with nothing to do when the reread matches', () => {
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }]))
      .toEqual({ kind: 'continue', prepend: [], append: [], correct: [], abandon: [] });
  });

  it('appends new items after the known ones and corrects changed or open items', () => {
    const index = [entry('a', 'da'), entry('b', undefined, { state: 'open' }), entry('c', 'dc')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'changed' }, { itemKey: 'd', digest: 'dd' }]))
      .toEqual({ kind: 'continue', prepend: [], append: ['d'], correct: ['b', 'c'], abandon: [] });
  });

  it('compares only inside the reread window, leaving older journal items alone', () => {
    expect(planReconcile(journal, [{ itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }, { itemKey: 'd', digest: 'dd' }]))
      .toEqual({ kind: 'continue', prepend: [], append: ['d'], correct: [], abandon: [] });
  });

  it('ignores live-only journal items', () => {
    const index = [entry('a', 'da'), entry('ask', 'dask', { liveOnly: true }), entry('b', 'db')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }]).kind).toBe('continue');
  });

  it('abandons open items the native history never kept', () => {
    const index = [entry('a', 'da'), entry('b', undefined, { state: 'open' }), entry('c', 'dc'), entry('d', undefined, { state: 'open' })];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'c', digest: 'dc' }]))
      .toEqual({ kind: 'continue', prepend: [], append: [], correct: [], abandon: ['b', 'd'] });
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
    expect(planReconcile([], [{ itemKey: 'a', digest: 'da' }])).toEqual({ kind: 'continue', prepend: [], append: ['a'], correct: [], abandon: [] });
    expect(planReconcile(journal, [])).toEqual({ kind: 'replace', reason: 'missing' });
    expect(planReconcile([entry('a', undefined, { state: 'open' })], [])).toEqual({ kind: 'continue', prepend: [], append: [], correct: [], abandon: ['a'] });
  });

  it('treats a sealed (live-only, digestless) item as relay-only, and lets native history adopt it', () => {
    const index = [entry('a', 'da'), entry('s', undefined, { liveOnly: true }), entry('b', 'db')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }]))
      .toEqual({ kind: 'continue', prepend: [], append: [], correct: [], abandon: [] });
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 's', digest: 'ds' }, { itemKey: 'b', digest: 'db' }]))
      .toEqual({ kind: 'continue', prepend: [], append: [], correct: ['s'], abandon: [] });
  });

  it('prepends older items when the reread reaches further back than the journal', () => {
    const index = [entry('b', 'db'), entry('c', 'dc')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }, { itemKey: 'd', digest: 'dd' }]))
      .toEqual({ kind: 'continue', prepend: ['a'], append: ['d'], correct: [], abandon: [] });
    const withLive = [entry('ask', 'x', { liveOnly: true }), entry('b', 'db')];
    expect(planReconcile(withLive, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }]))
      .toEqual({ kind: 'continue', prepend: ['a'], append: [], correct: [], abandon: [] });
  });

  it('does not prepend before a known item that is not the journal\'s first', () => {
    expect(planReconcile(journal, [{ itemKey: 'a0', digest: 'x' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }]))
      .toEqual({ kind: 'replace', reason: 'inserted' });
  });

  it('rejects a reread that repeats an item key', () => {
    expect(() => planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'a', digest: 'da' }])).toThrow(JournalDuplicateItemError);
  });

  it('compares evicted items by digest like resident ones', () => {
    const index = [entry('a', 'da', { resident: false }), entry('b', 'db', { resident: false })];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'other' }]))
      .toEqual({ kind: 'continue', prepend: [], append: [], correct: ['b'], abandon: [] });
  });

  it('walks a journal of only relay-only items from the start like an empty one', () => {
    const index = [entry('u1', undefined, { liveOnly: true })];
    expect(planReconcile(index, [{ itemKey: 'u2', digest: 'd2' }, { itemKey: 'm1', digest: 'dm' }]))
      .toEqual({ kind: 'continue', prepend: [], append: ['u2', 'm1'], correct: [], abandon: [] });
    expect(planReconcile(index, [{ itemKey: 'u1', digest: 'd1' }, { itemKey: 'm1', digest: 'dm' }]))
      .toEqual({ kind: 'continue', prepend: [], append: ['m1'], correct: ['u1'], abandon: [] });
  });

  it('prepends older items before a sealed item that leads the journal', () => {
    const index = [entry('s', undefined, { liveOnly: true }), entry('a', 'da')];
    expect(planReconcile(index, [{ itemKey: 'x', digest: 'dx' }, { itemKey: 's', digest: 'ds' }, { itemKey: 'a', digest: 'da' }]))
      .toEqual({ kind: 'continue', prepend: ['x'], append: [], correct: ['s'], abandon: [] });
  });

  it('does not prepend before a known item that follows a journal item of native history', () => {
    const index = [entry('a', 'da'), entry('s', undefined, { liveOnly: true }), entry('b', 'db')];
    expect(planReconcile(index, [{ itemKey: 'x', digest: 'dx' }, { itemKey: 's', digest: 'ds' }, { itemKey: 'b', digest: 'db' }]))
      .toEqual({ kind: 'replace', reason: 'inserted' });
  });
});
