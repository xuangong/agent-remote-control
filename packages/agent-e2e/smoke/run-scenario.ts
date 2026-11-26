import { join } from 'node:path';
import { findingsFromFailures } from './findings.js';
import { copyDiagnosticLogs, unfinishedReport, type ScenarioEvidence } from './evidence.js';
import { scenarioStatus, type ScenarioReport } from './report.js';
import type { RunContext, Scenario } from './scenario.js';

export interface ScenarioRun { report: ScenarioReport; transcript?: { name: string; content: string } }

/**
 * Runs one scenario against its deadline. A scenario that finishes reports what it returned; one that times out or throws reports
 * what its evidence holds, the step it was stuck in, and the instance's diagnostic logs copied into `<runDirectory>/<scenario>/`.
 */
export async function runScenario({ scenario, context, evidence, deadlineMs, seed, runDirectory, instanceDirectory, copyLogs = copyDiagnosticLogs, now = Date.now }: {
  scenario: Scenario; context: RunContext; evidence: ScenarioEvidence; deadlineMs: number; seed: number; runDirectory: string; instanceDirectory: string;
  copyLogs?: typeof copyDiagnosticLogs; now?: () => number;
}): Promise<ScenarioRun> {
  const started = now();
  const base = { scenario: scenario.id, title: scenario.title, seed, startedAt: new Date(started).toISOString(), schedule: [], measurements: {}, invariants: [], findings: [] };
  let timer: NodeJS.Timeout | undefined;
  try {
    const message = `${scenario.id} exceeded its ${deadlineMs >= 60_000 ? `${deadlineMs / 60_000} minute` : `${deadlineMs / 1000} second`} deadline`;
    const outcome = await Promise.race([scenario.run(context), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'DeadlineError' })), deadlineMs); })]);
    const transcriptName = outcome.transcript ? `${scenario.id}.transcript.jsonl` : undefined;
    const report: ScenarioReport = { ...base, status: scenarioStatus(outcome.invariants), durationMs: now() - started, schedule: outcome.schedule, measurements: outcome.measurements, invariants: outcome.invariants,
      ...(transcriptName ? { transcript: transcriptName } : {}),
      findings: [...findingsFromFailures(scenario.id, seed, outcome.invariants, transcriptName, { schedule: outcome.schedule, ...(outcome.transcript ? { entries: outcome.transcript.transcript() } : {}) }), ...(outcome.findings ?? [])],
      ...(outcome.note ? { note: outcome.note } : {}) };
    return { report, ...(outcome.transcript && transcriptName ? { transcript: { name: transcriptName, content: outcome.transcript.toJsonLines() } } : {}) };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    const transcriptName = evidence.recorder.transcript().length > 0 ? `${scenario.id}.transcript.jsonl` : undefined;
    let diagnostics: string[] = [];
    try { diagnostics = copyLogs(instanceDirectory, join(runDirectory, scenario.id)); } catch (copyError) { context.log(`${scenario.id}: copying the instance logs failed: ${(copyError as Error).message}`); }
    const report: ScenarioReport = { ...base, ...unfinishedReport(evidence, error), status: 'errored', durationMs: now() - started, ...(transcriptName ? { transcript: transcriptName } : {}), ...(diagnostics.length > 0 ? { diagnostics } : {}) };
    return { report, ...(transcriptName ? { transcript: { name: transcriptName, content: evidence.recorder.toJsonLines() } } : {}) };
  } finally { clearTimeout(timer); }
}
