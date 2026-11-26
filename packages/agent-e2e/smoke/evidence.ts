import { mkdirSync, openSync, closeSync, readSync, fstatSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InvariantResult } from './invariants/types.js';
import { mergeInvariantResults, type ScheduleStep, type ScenarioReport, type StepMarker } from './report.js';
import { TranscriptRecorder } from './transcript.js';

/**
 * What a scenario has found out so far. A scenario writes into it as it goes instead of returning everything at its end, so a run that
 * hits its deadline or throws still has the schedule, the measurements, the invariants of the conditions it finished and the step it was in.
 */
export class ScenarioEvidence {
  readonly schedule: ScheduleStep[] = [];
  readonly measurements: Record<string, unknown> = {};
  /** The invariant results of each condition the scenario has finished. */
  readonly conditions: Array<{ label: string; results: InvariantResult[] }> = [];
  readonly steps: StepMarker[] = [];
  readonly recorder: TranscriptRecorder;
  constructor(private readonly now: () => number = Date.now) { this.recorder = new TranscriptRecorder(now); }

  /** Records that the scenario is now in `step`, for example "restarting instance" or "opening page 3 of hostQuota". */
  step(step: string): void { this.steps.push({ at: new Date(this.now()).toISOString(), t: this.recorder.clock(), step }); }
  /** The step the scenario is in. */
  currentStep(): StepMarker | undefined { return this.steps.at(-1); }
  invariants(): InvariantResult[] { return mergeInvariantResults(this.conditions); }
}

/** The report fields of a scenario that did not finish: what its evidence holds and the step it was stuck in. */
export function unfinishedReport(evidence: ScenarioEvidence, error: Error): Pick<ScenarioReport, 'schedule' | 'measurements' | 'invariants' | 'steps' | 'note'> {
  const stuck = evidence.currentStep();
  const where = stuck ? ` [stuck in "${stuck.step}" since t=${Math.round(stuck.t)} ms]` : '';
  return { schedule: [...evidence.schedule], measurements: { ...evidence.measurements }, invariants: evidence.invariants(), steps: evidence.steps.slice(-50),
    note: `${error.message}${where}${error.stack && error.name !== 'DeadlineError' ? ' | ' + error.stack.split('\n').slice(1, 4).map(line => line.trim()).join(' | ') : ''}` };
}

/** Logs worth keeping when a scenario fails, relative to the instance directory. Credential files and cookies are never in this list. */
const DIAGNOSTIC_LOGS = ['controller/agent-host.log', 'controller/relay-diagnostics.log', 'logs/runner.log', 'logs/controller.log'];
export const DIAGNOSTIC_TAIL_BYTES = 2 * 1024 * 1024;

/** Copies the last `maxBytes` of the instance's diagnostic logs into `destination`, which the next `pnpm local up` cannot overwrite. Returns the names copied. */
export function copyDiagnosticLogs(instanceDirectory: string, destination: string, maxBytes = DIAGNOSTIC_TAIL_BYTES): string[] {
  const copied: string[] = [];
  for (const relative of DIAGNOSTIC_LOGS) {
    const source = join(instanceDirectory, relative);
    if (!existsSync(source)) continue;
    mkdirSync(destination, { recursive: true });
    const name = relative.replace('/', '.');
    const descriptor = openSync(source, 'r');
    try {
      const size = fstatSync(descriptor).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(descriptor, buffer, 0, length, size - length);
      writeFileSync(join(destination, name), buffer);
      copied.push(name);
    } finally { closeSync(descriptor); }
  }
  return copied;
}
