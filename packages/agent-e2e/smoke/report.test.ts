import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { result } from './invariants/types.js';
import { scenarioStatus, summarize, writeReport, type RunReport, type ScenarioReport } from './report.js';

const scenario = (extra: Partial<ScenarioReport> = {}): ScenarioReport => ({ scenario: 'M1', title: 'Bad network', status: 'passed', seed: 7, startedAt: 'now', durationMs: 61_000, schedule: [], measurements: {}, invariants: [], findings: [], ...extra });
const run = (scenarios: ScenarioReport[]): RunReport => ({ format: 'arc-smoke-report-1', startedAt: '2026-11-18', mode: 'quick', commit: 'abc123', build: 'clean', node: 'v22', scenarios, sessions: [] });

describe('scenario status', () => {
  it('fails on any failed invariant and is not exercised when nothing was examined', () => {
    expect(scenarioStatus([result('a', 3, []), result('b', 2, [{ message: 'x' }])])).toBe('failed');
    expect(scenarioStatus([result('a', 3, []), result('b', 0, [])])).toBe('passed');
    expect(scenarioStatus([result('a', 0, [])])).toBe('not_exercised');
  });
});

describe('the report', () => {
  it('summarizes scenarios, invariants, violations, findings and deferred scenarios on one page', () => {
    const text = summarize(run([
      scenario({ invariants: [result('message-settles-once', 4, [{ message: 'send r1 never settled', at: 1200 }])], status: 'failed', findings: [{ id: 'F1', summary: 'a send never settled', evidence: 't', candidateTests: ['x'] }] }),
      scenario({ scenario: 'M5', title: 'Many sessions', status: 'deferred', note: 'needs the Node host' }),
    ]));
    expect(text).toContain('FAIL   M1  Bad network  (61 s, seed 7)');
    expect(text).toContain('- send r1 never settled (t=1200 ms)');
    expect(text).toContain('finding F1: a send never settled');
    expect(text).toContain('DEFER  M5');
    expect(text).toContain('2 scenarios, 1 failed or errored.');
  });
  it('writes the report, the summary and the transcripts into the run directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arc-smoke-report-'));
    try {
      const path = writeReport(directory, run([scenario()]), { 'M1.transcript.jsonl': '{"n":1}\n' });
      expect(JSON.parse(readFileSync(path, 'utf8')).format).toBe('arc-smoke-report-1');
      expect(readFileSync(join(directory, 'M1.transcript.jsonl'), 'utf8')).toBe('{"n":1}\n');
      expect(readFileSync(join(directory, 'summary.txt'), 'utf8')).toContain('Smoke quick run');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('merging conditions', () => {
  it('fails when any condition failed and names the condition in the violation', async () => {
    const { mergeInvariantResults } = await import('./report.js');
    const merged = mergeInvariantResults([
      { label: '300 ms', results: [result('a', 2, []), result('b', 0, [])] },
      { label: '1500 ms', results: [result('a', 3, [{ message: 'late' }]), result('b', 1, [])] },
    ]);
    expect(merged.find(item => item.invariant === 'a')).toMatchObject({ status: 'failed', checked: 5, violations: [{ message: '[1500 ms] late' }] });
    expect(merged.find(item => item.invariant === 'b')?.status).toBe('passed');
  });
});
