import { restartInstance, stopController } from '../../faults/instance-process.mjs';
import { mergeInvariantResults } from '../report.js';
import type { Scenario } from '../scenario.js';
import { runRestartRound, type Phase, type RoundPlan } from '../lib/restart-round.js';
import type { Provider } from '../lib/sessions.js';

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
    const recorder = context.evidence.recorder;
    const schedule = context.evidence.schedule;
    const conditions = context.evidence.conditions;
    const measurements: Record<string, unknown> = Object.assign(context.evidence.measurements, { rounds: [] as unknown[] });
    for (let index = 0; index < rounds; index += 1) {
      const mode = index % 2 === 0 ? 'kill' : 'graceful';
      const phase: Phase = context.random.pick(['streaming', 'tool-call']);
      const provider: Provider = index % 2 === 0 ? 'claude' : 'codex';
      const plan: RoundPlan = { provider, phase, marker: 'controller-restart', async fault() {
        context.evidence.step(`round ${index + 1}: stopping the Controller (${mode})`);
        const stopped = await stopController(context.instance, { mode });
        context.log(`M2 round ${index + 1}: Controller ${mode}: runner stopped ${stopped.runnerStopped} after ${stopped.ms} ms`);
        context.evidence.step(`round ${index + 1}: restarting the instance`);
        const restarted = await restartInstance(context.instance, { checkout: context.checkout });
        return { mode, stopped, restarted };
      } };
      context.evidence.step(`round ${index + 1}: running the restart round`);
      const round = await runRestartRound(context, plan, recorder, index);
      conditions.push({ label: round.label, results: round.results });
      schedule.push(...round.schedule);
      (measurements.rounds as unknown[]).push({ label: round.label, ...round.measurements });
    }
    return { measurements, invariants: mergeInvariantResults(conditions), schedule, transcript: recorder };
  },
};
