import { restartInstance } from '../../faults/instance-process.mjs';
import { mergeInvariantResults, type ScheduleStep } from '../report.js';
import type { Scenario } from '../scenario.js';
import { runRestartRound, type Phase, type RoundPlan } from '../lib/restart-round.js';
import type { Provider } from '../lib/sessions.js';
import { TranscriptRecorder } from '../transcript.js';

/**
 * M3: the instance is restarted (the Relay stops, the Controller with it) while a turn runs, once with the SQLite journal store
 * kept and once with it emptied. The page must reconnect without a blank frame or a stale label.
 */
export const relayRestart: Scenario = {
  id: 'M3',
  title: 'Relay restart mid-turn, with the journal kept and emptied',
  quick: false,
  async run(context) {
    const rounds = Number(process.argv.indexOf('--rounds') > -1 ? process.argv[process.argv.indexOf('--rounds') + 1] : 0) || (context.quick ? 2 : 6);
    const recorder = new TranscriptRecorder();
    const schedule: ScheduleStep[] = [];
    const conditions: Array<{ label: string; results: ReturnType<typeof mergeInvariantResults> }> = [];
    const measurements: Record<string, unknown> = { rounds: [] as unknown[] };
    for (let index = 0; index < rounds; index += 1) {
      const emptyStore = index % 2 === 1;
      const phase: Phase = context.random.pick(['streaming', 'tool-call']);
      const provider: Provider = index % 2 === 0 ? 'claude' : 'codex';
      const plan: RoundPlan = { provider, phase, marker: 'relay-restart', async fault() { return { emptyStore, restarted: await restartInstance(context.instance, { checkout: context.checkout, emptyStore }) }; } };
      const round = await runRestartRound(context, plan, recorder, index);
      conditions.push({ label: `${round.label}, ${emptyStore ? 'empty store' : 'journal kept'}`, results: round.results });
      schedule.push(...round.schedule);
      (measurements.rounds as unknown[]).push({ label: round.label, emptyStore, ...round.measurements });
    }
    return { measurements, invariants: mergeInvariantResults(conditions), schedule, transcript: recorder };
  },
};
