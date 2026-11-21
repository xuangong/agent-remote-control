import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { noBlankFrame, noDuplicateItemKey, noSessionConnectionLabel, journalSequencesContiguous, messagesSettleOnce, oneReplacementPerRestart, turnRowsCompleteAfterReturn, type InvariantResult, type MarkerName } from '../invariants/index.js';
import type { ScheduleStep } from '../report.js';
import type { RunContext } from '../scenario.js';
import { TranscriptRecorder } from '../transcript.js';
import { PageProbe, withContext } from './probe.js';
import type { Provider } from './sessions.js';

/** What the model is asked to be doing when the fault lands. */
export type Phase = 'streaming' | 'tool-call';

export interface RoundPlan {
  provider: Provider;
  phase: Phase;
  /** The marker the transcript gets at the moment of the fault. */
  marker: MarkerName;
  /** Applies the fault and brings the instance back. Called while the model works. */
  fault(): Promise<Record<string, unknown>>;
}

export interface RoundResult { label: string; results: InvariantResult[]; measurements: Record<string, unknown>; schedule: ScheduleStep[] }

/**
 * Whether the model is visibly in the middle of the turn just sent: a row that was not there before the send (`before`, its
 * keys) shows a tool call, or a partial reply long enough to be streaming.
 */
export function landedMidTurn(rows: ReadonlyArray<{ key: string; kind: string; text: string }>, before: ReadonlySet<string>, phase: Phase): boolean {
  return rows.some(row => !before.has(row.key) && (phase === 'tool-call' ? row.kind === 'tool_call' : row.kind === 'assistant_message' && row.text.length > 120));
}

const promptFor = (phase: Phase, word: string): string => phase === 'tool-call'
  ? `Run the shell command: sleep 20; echo ${word}-done. Then reply with the single word ${word}.`
  : `Write a 300 word story about a lighthouse keeper. Put the single word ${word} on its own line at the very end.`;

/**
 * One restart round on a session of the run: the page is open and sends a long turn; when the model is mid-stream or mid-tool-call
 * the fault is applied and the instance returns; the page is left alone to recover; then a follow-up turn proves the session works.
 * The invariants are evaluated on the transcript and page of this round only.
 */
export async function runRestartRound(context: RunContext, plan: RoundPlan, recorder: TranscriptRecorder, index: number): Promise<RoundResult> {
  const label = `round ${index + 1}: ${plan.provider}, ${plan.phase}, ${plan.marker}`;
  const schedule: ScheduleStep[] = [];
  const address = await context.sessionWithHistory(plan.provider);
  const foreign = await context.pool.foreignActiveSessions();
  if (foreign.length > 0) throw new Error(`Sessions this run did not create are active (${foreign.length}); a restart would interrupt them.`);
  const url = await context.pool.link(address);
  const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: recorder.tap, onSocket: recorder.socket });
  const fromNumber = recorder.transcript().length === 0 ? 0 : recorder.transcript().at(-1)!.n;
  const measurements: Record<string, unknown> = {};
  try {
    const word = `QUARTZ${context.random.int(100, 999)}`;
    const after = `AFTER${context.random.int(100, 999)}`;
    const firstPrompt = promptFor(plan.phase, word);
    const outcome = await withContext(context.browser, proxy.origin, async browserContext => {
      // The fault lands on a tool call the page shows as a row of its own: the Full process display shows every step of a turn.
      const probe = await PageProbe.create(browserContext, recorder.origin, { process: 'full' });
      await probe.open(url.replace(context.instance.origin, proxy.origin), `open, ${label}`);
      await probe.page.waitForFunction(() => (window as any).__smoke.read().composer === 'enabled', undefined, { timeout: 60_000 });
      // The session is shared by the rounds of a run: only the rows of this turn may say that the model is mid-turn.
      const before = new Set((await probe.rows()).map(row => row.key));
      recorder.mark('turn-sent', { word, phase: plan.phase });
      await probe.send(firstPrompt);
      // The fault lands once the model is visibly mid-turn: a tool call row, or a long enough partial reply.
      let reached = false;
      for (const until = Date.now() + 90_000; !reached && Date.now() < until;) {
        reached = landedMidTurn(await probe.rows(), before, plan.phase);
        if (!reached) await probe.page.waitForTimeout(250);
      }
      measurements.faultLandedMidTurn = reached;
      if (plan.phase === 'tool-call') await probe.page.waitForTimeout(1500);
      recorder.mark(plan.marker, { phase: plan.phase });
      schedule.push({ t: recorder.clock(), action: plan.marker, detail: { provider: plan.provider, phase: plan.phase } });
      measurements.fault = await plan.fault();
      schedule.push({ t: recorder.clock(), action: 'instance-back', detail: {} });
      // The page is left alone: it must reconnect and show the conversation again by itself.
      const recovered = await probe.page.waitForFunction(() => {
        const state = (window as any).__smoke.read();
        return state.composer === 'enabled' && state.entries > 0 && !state.labels.some((text: string) => /reconnect|synchroniz|connecting/i.test(text));
      }, undefined, { timeout: 120_000 }).then(() => true, () => false);
      measurements.pageRecovered = recovered;
      let followUp = false;
      if (recovered) {
        recorder.mark('turn-sent', { word: after, phase: 'follow-up' });
        await probe.send(`Reply with the single word ${after} and nothing else.`);
        followUp = await probe.waitForReplyContaining(after, 150_000);
      }
      measurements.followUpReplied = followUp;
      await probe.page.waitForTimeout(2500);
      await probe.snapshotKeys();
      const page = await probe.report();
      await probe.close();
      return page;
    });
    const wire = recorder.transcript().filter(entry => entry.n > fromNumber);
    const results = [
      oneReplacementPerRestart(wire), journalSequencesContiguous(wire), messagesSettleOnce(wire, { final: false }), noDuplicateItemKey(wire, outcome),
      noBlankFrame(outcome), noSessionConnectionLabel(outcome),
      // Each turn is found by the word only its own prompt carries: the rounds of a run ask the same questions.
      turnRowsCompleteAfterReturn(outcome, [{ prompt: word, requireReply: false }, { prompt: `Reply with the single word ${after}` }]),
    ];
    return { label, results, measurements, schedule };
  } finally { await proxy.close(); }
}
