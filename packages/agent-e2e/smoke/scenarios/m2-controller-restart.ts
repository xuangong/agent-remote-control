import { restartInstance, stopController } from '@orchardworks/agent-e2e/faults/instance-process.mjs';
import { mergeInvariantResults, type ScheduleStep } from '../report.js';
import type { Scenario } from '../scenario.js';
import { runRestartRound, type Phase, type RoundPlan } from '../lib/restart-round.js';
import type { Provider } from '../lib/sessions.js';
import { TranscriptRecorder } from '../transcript.js';

/**
 * M2: the Controller is stopped while a model turn streams or runs a tool, by SIGKILL (a crash) and SIGTERM (a deploy). The
 * runner stops the site when its Controller exits, so each round also restarts the instance; the Relay's journal store is kept.
 */
export const controllerRestart: Scenario = {
  id: 'M2',
  title: 'Controller restart mid-turn',
  quick: true,
  async run(context) {
    const rounds = Number(process.argv.indexOf('--rounds') > -1 ? process.argv[process.argv.indexOf('--rounds') + 1] : 0) || (context.quick ? 2 : 20);
    const recorder = new TranscriptRecorder();
    const schedule: ScheduleStep[] = [];
    const conditions: Array<{ label: string; results: ReturnType<typeof mergeInvariantResults> }> = [];
    const measurements: Record<string, unknown> = { rounds: [] as unknown[] };
    for (let index = 0; index < rounds; index += 1) {
      const mode = index % 2 === 0 ? 'kill' : 'graceful';
      const phase: Phase = context.random.pick(['streaming', 'tool-call']);
      const provider: Provider = index % 2 === 0 ? 'claude' : 'codex';
      const plan: RoundPlan = { provider, phase, marker: 'controller-restart', async fault() {
        const stopped = await stopController(context.instance, { mode });
        context.log(`M2 round ${index + 1}: Controller ${mode}: runner stopped ${stopped.runnerStopped} after ${stopped.ms} ms`);
        const restarted = await restartInstance(context.instance, { checkout: context.checkout });
        return { mode, stopped, restarted };
      } };
      const round = await runRestartRound(context, plan, recorder, index);
      conditions.push({ label: round.label, results: round.results });
      schedule.push(...round.schedule);
      (measurements.rounds as unknown[]).push({ label: round.label, ...round.measurements });
    }
    return { measurements, invariants: mergeInvariantResults(conditions), schedule, transcript: recorder };
  },
};
