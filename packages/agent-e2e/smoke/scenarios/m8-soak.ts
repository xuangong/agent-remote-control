import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { journalSequencesContiguous, memoryFlat, noBlankFrame, noDuplicateItemKey, noStaleLabel, rowCountsStable, socketCountsStable, type InvariantResult } from '../invariants/index.js';
import { positiveInteger } from '../lib/arguments.js';
import { PageProbe, withContext } from '../lib/probe.js';
import { startScriptedHost } from '../lib/scripted-host.js';
import { mergeInvariantResults, type ScheduleStep } from '../report.js';
import type { Scenario } from '../scenario.js';
import { TranscriptRecorder } from '../transcript.js';
import { setTimeout as delay } from 'node:timers/promises';

const SESSIONS = ['soak-a', 'soak-b', 'soak-c'];
const CYCLE_MS = 10_000;
const SAMPLE_MS = 10_000;

/**
 * M8: three scripted sessions stream a reply every ten seconds (a message in, an answer in two pieces) while three pages, one per session,
 * stay open. `--duration` is the number of minutes (the plan says 30; the default is 30). Row counts beyond what the sessions wrote, the
 * heap after a collection and the open sockets are sampled every ten seconds and must not drift.
 */
export const soak: Scenario = {
  id: 'M8',
  title: 'Soak',
  quick: false,
  async run(context) {
    const minutes = positiveInteger('--duration', 30);
    const recorder = new TranscriptRecorder();
    const schedule: ScheduleStep[] = [];
    const measurements: Record<string, unknown> = { minutes, sessions: SESSIONS.length, cycleMs: CYCLE_MS };
    const host = await startScriptedHost(context.instance, { name: 'Smoke M8 Host', installationId: `smoke-m8-${context.seed}`, stream: true, replyDelayMs: 1500,
      answer: text => `Soak answer to ${text}. ${'The lighthouse keeper watched the water. '.repeat(4)}`,
      sessions: Object.fromEntries(SESSIONS.map(id => [id, { title: id, history: [{ role: 'user' as const, text: `Hello ${id}` }, { role: 'assistant' as const, text: `Ready ${id}` }] }])) });
    const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: recorder.tap, onSocket: recorder.socket });
    try {
      const outcome = await withContext(context.browser, proxy.origin, async browserContext => {
        const probes: PageProbe[] = [];
        for (const id of SESSIONS) {
          const probe = await PageProbe.create(browserContext, recorder.origin);
          await probe.open(host.sessionUrl(id).replace(context.instance.origin, proxy.origin), `open ${id}`, { rowsDeadlineMs: 90_000 });
          probes.push(probe);
        }
        const openedAt = recorder.clock();
        const live = SESSIONS.map(id => host.provider.session(id));
        for (let at = 0; at < 100 && live.some(item => !item); at += 1) { await delay(100); SESSIONS.forEach((id, index) => { live[index] ??= host.provider.session(id); }); }
        if (live.some(item => !item)) throw new Error('The scripted Host did not open every session.');
        const written = SESSIONS.map(() => 2);
        const started = Date.now();
        const until = started + minutes * 60_000;
        let cycles = 0, lastWord = '';
        let nextSample = started;
        schedule.push({ t: recorder.clock(), action: 'soak-start', detail: { minutes, cycleMs: CYCLE_MS } });
        while (Date.now() < until) {
          const cycleStart = Date.now();
          lastWord = `SOAK${cycles}`;
          for (const [index, session] of live.entries()) { await (session as unknown as { sendMessage(text: string): Promise<void> }).sendMessage(lastWord); written[index]! += 2; }
          cycles += 1;
          if (Date.now() >= nextSample) {
            for (const [index, probe] of probes.entries()) await probe.sampleResources(proxy.openWebSockets(), written[index]!);
            nextSample = Date.now() + SAMPLE_MS;
          }
          const rest = CYCLE_MS - (Date.now() - cycleStart);
          if (rest > 0) await delay(rest);
        }
        schedule.push({ t: recorder.clock(), action: 'soak-end', detail: { cycles } });
        const delivered: boolean[] = [];
        for (const probe of probes) delivered.push(await probe.waitForReplyContaining(lastWord, 30_000));
        await probes[0]!.page.waitForTimeout(2000);
        const pages = [];
        for (const probe of probes) { await probe.sampleResources(proxy.openWebSockets(), written[probes.indexOf(probe)]!); await probe.snapshotKeys(); pages.push(await probe.report()); await probe.close(); }
        return { pages, cycles, delivered, written, openedAt };
      });
      const wire = recorder.transcript();
      measurements.cycles = outcome.cycles;
      measurements.lastReplyShown = outcome.delivered;
      measurements.rowsWritten = outcome.written;
      measurements.series = outcome.pages.map((page, index) => {
        const resources = page.resources ?? [];
        return { session: SESSIONS[index], samples: resources.length, heapBytes: { first: resources[0]?.heapBytes, last: resources.at(-1)?.heapBytes, max: Math.max(...resources.map(sample => sample.heapBytes)) }, extraRows: { first: resources[0]?.rows, last: resources.at(-1)?.rows, max: Math.max(...resources.map(sample => sample.rows)) }, sockets: { min: Math.min(...resources.map(sample => sample.sockets)), max: Math.max(...resources.map(sample => sample.sockets)) } };
      });
      const delivery: InvariantResult = { invariant: 'streamed-replies-shown', checked: outcome.delivered.length, status: outcome.delivered.every(Boolean) ? 'passed' : 'failed', violations: outcome.delivered.flatMap((shown, index) => shown ? [] : [{ message: `the last streamed reply of ${SESSIONS[index]} never appeared` }]) };
      const conditions = outcome.pages.map((page, index) => ({ label: SESSIONS[index]!, results: [memoryFlat(page), rowCountsStable(page), socketCountsStable(page), noDuplicateItemKey(wire, page), noBlankFrame({ ...page, samples: page.samples.filter(sample => sample.t > outcome.openedAt) }), noStaleLabel(wire, page)] }));
      // Opening another page of the same browser makes the pages already open show an empty conversation for a frame or two; the soak judges the steady state and reports that apart.
      const blanksWhileOpening = outcome.pages.map(page => noBlankFrame({ ...page, samples: page.samples.filter(sample => sample.t <= outcome.openedAt) }).violations.length);
      measurements.blankFramesWhileOpeningOtherPages = blanksWhileOpening;
      conditions.push({ label: 'all sessions', results: [journalSequencesContiguous(wire), delivery] });
      const findings = blanksWhileOpening.some(count => count > 0) ? [{ id: `M8-blank-while-opening-other-page`, summary: 'A page that is already open shows an empty conversation (no placeholder, no label) while another page of the same browser opens.', evidence: `seed ${context.seed}: blank samples per page ${JSON.stringify(blanksWhileOpening)}; see the M8 transcript and report.`, candidateTests: ['a client seam test that opens a second page on the same device store while the first shows rows', 'the unit test of the module that clears the displayed rows'] }] : [];
      return { measurements, invariants: mergeInvariantResults(conditions), schedule, transcript: recorder, findings };
    } finally { await proxy.close(); await host.close(); }
  },
};
