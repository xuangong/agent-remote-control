import type { InvariantResult } from './invariants/types.js';
import type { Finding, ScheduleStep } from './report.js';
import type { TranscriptRecorder } from './transcript.js';
import type { SessionPool, Provider } from './lib/sessions.js';
import type { Instance, } from '@orchardworks/agent-e2e/faults/instance-process.mjs';
import type { SeededRandom } from '@orchardworks/agent-e2e/faults/seeded-random.mjs';

/** Everything a scenario needs from the run: the instance, a browser, the sessions it may drive and the seeded generator. */
export interface RunContext {
  checkout: string;
  instance: Instance;
  seed: number;
  quick: boolean;
  random: SeededRandom;
  pool: SessionPool;
  browser: any;
  runDirectory: string;
  log(message: string): void;
  /** A session of this run with a few turns of history, created on first use. */
  sessionWithHistory(provider: Provider): Promise<string>;
  /** A session whose history is taller than the page's viewport, so a reader can be somewhere in the middle of it. */
  sessionWithLongHistory(provider: Provider): Promise<string>;
  /** The scenario's clock: milliseconds since it started. */
  now(): number;
}

export interface ScenarioOutcome {
  measurements: Record<string, unknown>;
  invariants: InvariantResult[];
  schedule: ScheduleStep[];
  transcript?: TranscriptRecorder;
  findings?: Finding[];
  note?: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** Part of `pnpm smoke:quick`. */
  quick: boolean;
  run(context: RunContext): Promise<ScenarioOutcome>;
}

/** A scenario of the plan that this version does not run, and why. */
export interface DeferredScenario { id: string; title: string; reason: string }
