import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyDiagnosticLogs, ScenarioEvidence } from './evidence.js';
import { result } from './invariants/types.js';
import { runScenario } from './run-scenario.js';
import { summarize, type RunReport } from './report.js';
import type { RunContext, Scenario } from './scenario.js';

const context = (evidence: ScenarioEvidence) => ({ evidence, log: () => {} } as unknown as RunContext);
const fake = (run: Scenario['run']): Scenario => ({ id: 'M4', title: 'Quota pressure', quick: true, run });
const noLogs = () => [] as string[];

describe('a scenario that does not finish', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports what it recorded and the step it was stuck in when its deadline fires', async () => {
    const evidence = new ScenarioEvidence();
    const scenario = fake(async ctx => {
      ctx.evidence.schedule.push({ t: 5, action: 'restart-with-limits' });
      ctx.evidence.measurements.sessionQuota = { refusals: 2 };
      ctx.evidence.conditions.push({ label: 'one session', results: [result('trim-reported', 3, [])] });
      ctx.evidence.recorder.mark('relay-restart');
      ctx.evidence.step('restarting the instance');
      ctx.evidence.step('opening page 3 of hostQuota');
      return new Promise(() => {});
    });
    const pending = runScenario({ scenario, context: context(evidence), evidence, deadlineMs: 8 * 60_000, seed: 7, runDirectory: '/run', instanceDirectory: '/instance', copyLogs: noLogs });
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    const { report, transcript } = await pending;
    expect(report.status).toBe('errored');
    expect(report.schedule).toEqual([{ t: 5, action: 'restart-with-limits' }]);
    expect(report.measurements).toEqual({ sessionQuota: { refusals: 2 } });
    expect(report.invariants.map(item => item.invariant)).toEqual(['trim-reported']);
    expect(report.steps?.map(step => step.step)).toEqual(['restarting the instance', 'opening page 3 of hostQuota']);
    expect(report.note).toContain('M4 exceeded its 8 minute deadline');
    expect(report.note).toContain('stuck in "opening page 3 of hostQuota"');
    expect(transcript?.name).toBe('M4.transcript.jsonl');
    expect(report.transcript).toBe('M4.transcript.jsonl');
    const text = summarize({ format: 'arc-smoke-report-1', startedAt: 'now', mode: 'quick', commit: 'abc', build: 'clean', node: 'v22', scenarios: [report], sessions: [] });
    expect(text).toContain('stuck in "opening page 3 of hostQuota"');
  });

  it('reports the evidence and copies the logs when the scenario throws', async () => {
    const evidence = new ScenarioEvidence();
    const copied: Array<[string, string]> = [];
    const scenario = fake(async ctx => { ctx.evidence.schedule.push({ t: 1, action: 'send' }); ctx.evidence.step('sending'); throw new Error('the page crashed'); });
    const { report } = await runScenario({ scenario, context: context(evidence), evidence, deadlineMs: 60_000, seed: 1, runDirectory: '/run', instanceDirectory: '/instance',
      copyLogs: (from, to) => { copied.push([from, to]); return ['controller.agent-host.log']; } });
    expect(report.status).toBe('errored');
    expect(report.schedule).toHaveLength(1);
    expect(report.note).toContain('the page crashed [stuck in "sending"');
    expect(report.diagnostics).toEqual(['controller.agent-host.log']);
    expect(copied).toEqual([['/instance', join('/run', 'M4')]]);
  });

  it('keeps the report of a scenario that finishes and copies no logs', async () => {
    const evidence = new ScenarioEvidence();
    const copyLogs = vi.fn(() => []);
    const scenario = fake(async () => ({ measurements: { a: 1 }, invariants: [result('x', 1, [])], schedule: [] }));
    const { report } = await runScenario({ scenario, context: context(evidence), evidence, deadlineMs: 60_000, seed: 1, runDirectory: '/run', instanceDirectory: '/instance', copyLogs });
    expect(report.status).toBe('passed');
    expect(copyLogs).not.toHaveBeenCalled();
  });
});

describe('copying the instance logs', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'smoke-evidence-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('keeps the tail of each diagnostic log and never a credential file', () => {
    const instance = join(directory, 'instance'); const out = join(directory, 'out');
    mkdirSync(join(instance, 'controller'), { recursive: true }); mkdirSync(join(instance, 'logs'));
    writeFileSync(join(instance, 'controller/agent-host.log'), 'a'.repeat(100) + 'TAIL');
    writeFileSync(join(instance, 'controller/relay-diagnostics.log'), 'diag');
    writeFileSync(join(instance, 'logs/runner.log'), 'runner');
    writeFileSync(join(instance, 'controller/connection.json'), 'SECRET');
    writeFileSync(join(instance, 'controller/cli-credentials.json'), 'SECRET');
    const names = copyDiagnosticLogs(instance, out, 10);
    expect(names.sort()).toEqual(['controller.agent-host.log', 'controller.relay-diagnostics.log', 'logs.runner.log']);
    expect(readFileSync(join(out, 'controller.agent-host.log'), 'utf8')).toBe('aaaaaa' + 'TAIL');
    expect(readdirSync(out).some(name => name.includes('connection') || name.includes('credentials'))).toBe(false);
  });

  it('copies nothing when the instance has no logs', () => {
    expect(copyDiagnosticLogs(join(directory, 'none'), join(directory, 'out'))).toEqual([]);
  });
});
