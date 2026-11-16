import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { composerUnchanged, journalServed, parseJournalMeta, rowlessStates, reportable } from '../performance/journal-measurement.mjs';
import { composerKept, figure, replacementResult, rowSurvival, summarize, usable } from '../performance/summarize-p1d.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const write = (directory: string, name: string, body: unknown) => writeFileSync(join(directory, name), JSON.stringify(body));
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 's4-summary-')); directories.push(directory); return directory; };

describe('which samples were served from the journal', () => {
  const epochs = ['e1', 'e1'];
  it('trusts the item-key flag when the build has one', () => {
    expect(journalServed({ signal: 'flag', itemKeysEchoed: true, pageEpochs: [], metaBefore: null, metaAfter: null })).toBe(true);
    expect(journalServed({ signal: 'flag', itemKeysEchoed: false, pageEpochs: epochs, metaBefore: { epoch: 'e1' }, metaAfter: { epoch: 'e1' } })).toBe(false);
  });
  it('compares the page epochs with the journal epoch before and after the sample when there is no flag', () => {
    expect(journalServed({ signal: 'meta', itemKeysEchoed: false, pageEpochs: epochs, metaBefore: { epoch: 'e1' }, metaAfter: { epoch: 'e1' } })).toBe(true);
    expect(journalServed({ signal: 'meta', itemKeysEchoed: false, pageEpochs: epochs, metaBefore: { epoch: 'e1' }, metaAfter: { epoch: 'e2' } })).toBe(false);
    expect(journalServed({ signal: 'meta', itemKeysEchoed: false, pageEpochs: epochs, metaBefore: null, metaAfter: null })).toBe(false);
    expect(journalServed({ signal: 'meta', itemKeysEchoed: false, pageEpochs: [], metaBefore: { epoch: 'e1' }, metaAfter: { epoch: 'e1' } })).toBe(false);
  });
  it('reads the epoch from the chunks of the meta record', () => {
    const json = JSON.stringify({ epoch: 'abc', nextSeq: 7, other: 'x' });
    const bytes = Buffer.from(json);
    const chunks = [bytes.subarray(0, 10).toString('hex'), bytes.subarray(10).toString('hex')];
    expect(parseJournalMeta(chunks)).toEqual({ epoch: 'abc', nextSeq: 7 });
    expect(parseJournalMeta([])).toBeNull();
    expect(parseJournalMeta([Buffer.from('not json').toString('hex')])).toBeNull();
  });
});

describe('the counted observations', () => {
  it('counts states without rows only after rows were shown', () => {
    expect(rowlessStates([{ entries: 0 }, { entries: 3 }, { entries: 0 }, { entries: 3 }])).toBe(1);
    expect(rowlessStates([{ entries: 0 }, { entries: 0 }])).toBe(0);
  });
  it('compares the composer by text, focus and selection', () => {
    const before = { text: 'draft', focused: true, selectionStart: 5, selectionEnd: 5 };
    expect(composerUnchanged(before, { ...before })).toBe(true);
    expect(composerUnchanged(before, { ...before, text: 'draf' })).toBe(false);
    expect(composerUnchanged(before, { ...before, focused: false })).toBe(false);
  });
  it('states a percentile only from the minimum count', () => {
    expect(reportable([1, 2, 3], 20)).toMatchObject({ n: 3, p50: null, max: 3, belowMinimum: 20 });
    expect(reportable(Array.from({ length: 20 }, (_, index) => index + 1), 20)).toMatchObject({ n: 20, p50: 10, p95: 19 });
    expect(figure([5, 9], 10)).toBe('max 9 (n=2)');
  });
});

describe('the summary', () => {
  it('uses only journal-served samples of a journal arm and all samples of the crude arm', () => {
    const samples = [{ journalServed: true }, { journalServed: false }];
    expect(usable('s4a', samples)).toHaveLength(1);
    expect(usable('control', samples)).toHaveLength(1);
    expect(usable('s4a-crude', samples)).toHaveLength(2);
  });

  it('keeps a draft by its text and selection, not by its focus, which a disabled editor loses', () => {
    const before = { text: 'draft', focused: true, selectionStart: 5, selectionEnd: 5 };
    expect(composerKept({ composerBefore: before, composerAfter: { ...before, focused: false } })).toBe(true);
    expect(composerKept({ composerBefore: before, composerAfter: { ...before, text: 'draf' } })).toBe(false);
    expect(composerKept({ composerBefore: before, composerAfter: { ...before, selectionStart: 2 } })).toBe(false);
    expect(composerKept({ composerUnchanged: true })).toBe(true);
  });

  it('counts re-keyed rows and row-less states', () => {
    expect(rowSurvival([{ rows: { total: 10, alive: 10 }, rowlessStates: 0 }, { rows: { total: 20, alive: 15 }, rowlessStates: 2 }])).toEqual({ n: 2, rows: 30, rekeyed: 5, rowlessMax: 2 });
  });

  it('passes a forced replacement only when rows, composer and anchor held, and counts only forced samples', () => {
    const good = { wheelIntent: true, replacementForced: true, rows: { total: 10, alive: 10 }, rowlessStates: 0, composerUnchanged: true, anchorKey: 'k', anchorSurvived: true, anchorShiftPx: 0.5 };
    expect(replacementResult([good, { ...good, replacementForced: false, rows: { total: 10, alive: 0 } }]).pass).toBe(true);
    expect(replacementResult([{ ...good, anchorShiftPx: 3 }]).pass).toBe(false);
    expect(replacementResult([{ ...good, rows: { total: 10, alive: 9 } }]).pass).toBe(false);
    expect(replacementResult([{ ...good, replacementForced: false }]).pass).toBe(false);
    // A sample that scrolled without a wheel event says nothing about the reading position, but its rows and draft count.
    expect(replacementResult([{ ...good, wheelIntent: undefined, anchorShiftPx: 90 }]).pass).toBe(true);
  });

  it('prints a table per target with the verdicts, excludes an invalid run and states what it did not use', () => {
    const directory = temporary();
    const sample = (alive: number, extra: Record<string, unknown> = {}) => ({ journalServed: true, rows: { total: 10, alive }, rowlessStates: 0, ...extra });
    write(directory, 'control-1x.json', { scenarios: {
      'restart-continuity': { samples: [sample(10), sample(4), { journalServed: false, rows: { total: 9, alive: 0 }, rowlessStates: 5 }] },
      switch: { switch: { cold: { shownMs: 300, httpApi: 4, openingStates: 2, rowlessStates: 1 }, warm: { shownMs: 120, httpApi: 1, openingStates: 0, rowlessStates: 0 } } },
    } });
    write(directory, 's4a-1x.json', { scenarios: {
      'restart-continuity': { samples: [sample(10), sample(10)] },
      'replacement-absorbed': { samples: [sample(10, { replacementForced: true, composerUnchanged: true, anchorKey: 'k', anchorSurvived: true, anchorShiftPx: 0 })] },
    } });
    write(directory, 's4a-rtt100.json', { invalid: 'No WebSocket crossed the latency proxy; these numbers are not latency numbers.', scenarios: { 'restart-continuity': { samples: [sample(0)] } } });
    const text = summarize(directory, directory);
    expect(text).toContain('Invalid runs');
    expect(text).toContain('s4a/rtt100: No WebSocket crossed');
    expect(text).toMatch(/\| control \| no emulation \| 2\/3 \| 20 \| 6 \| 0 \| miss \|/);
    expect(text).toMatch(/\| s4a \| no emulation \| 2\/2 \| 20 \| 0 \| 0 \| pass \|/);
    expect(text).toMatch(/\| s4a \| no emulation \| 1\/1\/1 \| 10 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| pass \|/);
    expect(text).toMatch(/\| control \| no emulation \| 300 \| 120 \| 4 \/ 1 \| 2 \/ 0 \| 1 \/ 0 \| pass \|/);
    expect(text).not.toMatch(/100 ms round trip \| 1\/1/);
  });
});
