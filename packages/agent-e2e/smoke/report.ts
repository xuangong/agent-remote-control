import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InvariantResult, InvariantStatus } from './invariants/types.js';

/** A step of a fault schedule: what was done, when, and what came of it. */
export interface ScheduleStep { t: number; action: string; detail?: Record<string, unknown> }

export type ScenarioStatus = 'passed' | 'failed' | 'not_exercised' | 'deferred' | 'errored';

/** A finding in the form the test pipeline needs: the scenario's evidence and the tests it should become. */
export interface Finding {
  id: string;
  summary: string;
  evidence: string;
  /** The integration test on the seam where the rule breaks, then the unit test in the owning module (section 5.7). */
  candidateTests: string[];
}

export interface ScenarioReport {
  scenario: string;
  title: string;
  status: ScenarioStatus;
  seed: number;
  startedAt: string;
  durationMs: number;
  /** The timed actions the run applied, so the seed and this list replay it. */
  schedule: ScheduleStep[];
  measurements: Record<string, unknown>;
  invariants: InvariantResult[];
  /** Relative path of the wire transcript in the run directory. */
  transcript?: string;
  findings: Finding[];
  /** Why the scenario was not run or could not finish. */
  note?: string;
}

export interface RunReport {
  format: 'arc-smoke-report-1';
  startedAt: string;
  mode: 'quick' | 'full';
  commit: string;
  build: string;
  node: string;
  scenarios: ScenarioReport[];
  /** Codex sessions created and released, and Claude sessions created, so the run's footprint is auditable. */
  sessions: Array<{ address: string; provider: string; released: boolean }>;
}

/** The status of a scenario from its invariants: failed on any failed invariant, not exercised when none examined anything. */
export function scenarioStatus(invariants: InvariantResult[]): ScenarioStatus {
  if (invariants.some(item => item.status === 'failed')) return 'failed';
  return invariants.some(item => item.status === 'passed') ? 'passed' : 'not_exercised';
}

const label: Record<InvariantStatus | ScenarioStatus, string> = { passed: 'PASS', failed: 'FAIL', not_exercised: 'n/e', deferred: 'DEFER', errored: 'ERROR' };

/** A one-page text summary: one line per scenario and one per invariant, failures with their first violations. */
export function summarize(run: RunReport): string {
  const lines = [`Smoke ${run.mode} run at ${run.commit} (${run.build}), ${run.startedAt}`, ''];
  for (const scenario of run.scenarios) {
    lines.push(`${label[scenario.status].padEnd(6)} ${scenario.scenario}  ${scenario.title}  (${Math.round(scenario.durationMs / 1000)} s, seed ${scenario.seed})`);
    if (scenario.note) lines.push(`       ${scenario.note}`);
    for (const item of scenario.invariants) {
      lines.push(`       ${label[item.status].padEnd(6)} ${item.invariant}  checked ${item.checked}`);
      for (const violation of item.violations.slice(0, 3)) lines.push(`              - ${violation.message}${violation.at === undefined ? '' : ` (t=${Math.round(violation.at)} ms)`}`);
      if (item.violations.length > 3) lines.push(`              ... and ${item.violations.length - 3} more`);
    }
    for (const finding of scenario.findings) lines.push(`       finding ${finding.id}: ${finding.summary}`);
  }
  const failed = run.scenarios.filter(scenario => scenario.status === 'failed' || scenario.status === 'errored').length;
  lines.push('', `${run.scenarios.length} scenarios, ${failed} failed or errored.`);
  return lines.join('\n') + '\n';
}

/** Writes `report.json`, `summary.txt` and the scenario transcripts under `<directory>`. Returns the report path. */
export function writeReport(directory: string, run: RunReport, transcripts: Record<string, string> = {}): string {
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(transcripts)) writeFileSync(join(directory, name), content);
  writeFileSync(join(directory, 'summary.txt'), summarize(run));
  const path = join(directory, 'report.json');
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

/**
 * Combines the results of one invariant over several conditions of a scenario (a latency level, a restart round) into one
 * result per invariant: failed when any failed, with each violation prefixed by the condition it came from.
 */
export function mergeInvariantResults(conditions: Array<{ label: string; results: InvariantResult[] }>): InvariantResult[] {
  const merged = new Map<string, InvariantResult>();
  for (const { label, results } of conditions) {
    for (const item of results) {
      const found = merged.get(item.invariant) ?? { invariant: item.invariant, status: 'not_exercised' as InvariantStatus, checked: 0, violations: [] };
      found.checked += item.checked;
      found.violations.push(...item.violations.map(violation => ({ ...violation, message: `[${label}] ${violation.message}` })));
      found.status = found.violations.length > 0 ? 'failed' : found.checked > 0 ? 'passed' : 'not_exercised';
      merged.set(item.invariant, found);
    }
  }
  return [...merged.values()];
}
