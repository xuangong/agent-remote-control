import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { journalSequencesContiguous, memoryFlat, noBlankFrame, noDuplicateItemKey, noSessionConnectionLabel, rowCountsStable, socketCountsStable, type InvariantResult, type PageReport, type ResourceSample } from '../invariants/index.js';
import { positiveInteger } from '../lib/arguments.js';
import { createBotGroup } from '../lib/bot-group.js';
import { PageProbe, withContext } from '../lib/probe.js';
import { startScriptedHost } from '../lib/scripted-host.js';
import { mergeInvariantResults } from '../report.js';
import type { Scenario } from '../scenario.js';
import { setTimeout as delay } from 'node:timers/promises';

const SESSIONS = ['soak-a', 'soak-b', 'soak-c'];
const CYCLE_MS = 10_000;
const SAMPLE_MS = 10_000;
const perRow = (sample: ResourceSample | undefined) => sample?.retainedRows ? Math.round(sample.heapBytes / sample.retainedRows) : undefined;

/**
 * M8: three scripted sessions, the panes of one Window in one page, stream a reply every ten seconds (a message in, an answer in two pieces). `--duration` is the number of minutes (the plan says 30; the default is 30). Row counts beyond what the sessions wrote, the
 * heap after a collection and the open sockets are sampled every ten seconds and must not drift. The heap is judged per retained row
 * against a fresh page that loaded the same rows after the run (`memory-flat`), because the conversations grow for the whole run.
 */
export const soak: Scenario = {
  id: 'M8',
  title: 'Soak',
  quick: false,
  journals: true,
  async run(context) {
    const minutes = positiveInteger('--duration', 30);
    const recorder = context.evidence.recorder;
    const schedule = context.evidence.schedule;
    const measurements: Record<string, unknown> = Object.assign(context.evidence.measurements, { minutes, sessions: SESSIONS.length, cycleMs: CYCLE_MS });
    const host = await startScriptedHost(context.instance, { name: 'Smoke M8 Host', installationId: `smoke-m8-${context.seed}`, stream: true, replyDelayMs: 1500,
      answer: text => `Soak answer to ${text}. ${'The lighthouse keeper watched the water. '.repeat(4)}`,
      sessions: Object.fromEntries(SESSIONS.map(id => [id, { title: id, history: [{ role: 'user' as const, text: `Hello ${id}` }, { role: 'assistant' as const, text: `Ready ${id}` }] }])) });
    const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: recorder.tap, onSocket: recorder.socket });
    const group = await createBotGroup(context.instance.origin, { id: `smoke-m8-${context.seed}`, title: 'Smoke M8 soak', hostId: host.hostId, providerId: host.provider.providerId, sessions: SESSIONS.map(id => ({ nativeSessionId: id, title: id })), asBots: false });
    try {
      const outcome = await withContext(context.browser, proxy.origin, async browserContext => {
        // The Relay keeps one Window per user, so three pages of one browser would share it; the three sessions are the panes of one Window in one page.
        const probe = await PageProbe.create(browserContext, recorder.origin);
        await probe.page.setViewportSize({ width: 1800, height: 900 });
        context.evidence.step('opening the Window page');
        await probe.open(`${proxy.origin}/?window=${encodeURIComponent(group.id)}`, 'open Window', { rowsDeadlineMs: 90_000 });
        let written = SESSIONS.length * 2;
        const started = Date.now();
        const until = started + minutes * 60_000;
        let cycles = 0, lastWord = '';
        let nextSample = started;
        context.evidence.step(`soaking for ${minutes} minutes`);
        schedule.push({ t: recorder.clock(), action: 'soak-start', detail: { minutes, cycleMs: CYCLE_MS } });
        while (Date.now() < until) {
          const cycleStart = Date.now();
          lastWord = `SOAK${cycles}`;
          // A send through the command line reaches the Controller as a person's send does, and opens the session again if the Controller let it go while idle.
          for (const id of SESSIONS) { await context.pool.command('session', 'send', `${host.hostId}/${host.provider.providerId}/${id}`, lastWord); written += 2; }
          cycles += 1;
          if (Date.now() >= nextSample) { await probe.sampleResources(proxy.openWebSockets(), written); nextSample = Date.now() + SAMPLE_MS; }
          const rest = CYCLE_MS - (Date.now() - cycleStart);
          if (rest > 0) await delay(rest);
        }
        schedule.push({ t: recorder.clock(), action: 'soak-end', detail: { cycles } });
        const shown = await probe.waitForReplyContaining(lastWord, 30_000);
        const lastReplies = await probe.page.evaluate((word: string) => [...document.querySelectorAll('.agent-message-assistant')].filter(node => (node.textContent ?? '').includes(word)).length, lastWord);
        await probe.page.waitForTimeout(2000);
        await probe.sampleResources(proxy.openWebSockets(), written);
        await probe.snapshotKeys();
        const soaked = probe.lastResources();
        const report = await probe.report();
        await probe.close();
        // A fresh page opens the same Window and loads the rows the soaked page held: the heap those rows cost without thirty minutes of history.
        const fresh = await PageProbe.create(browserContext, recorder.origin);
        await fresh.page.setViewportSize({ width: 1800, height: 900 });
        context.evidence.step('opening a fresh page after the soak');
        await fresh.open(`${proxy.origin}/?window=${encodeURIComponent(group.id)}`, 'fresh page', { rowsDeadlineMs: 90_000 });
        const loaded = await fresh.loadOlderUntil(soaked?.retainedRows ?? 0, 180_000);
        await fresh.page.waitForTimeout(2000);
        await fresh.sampleResources(proxy.openWebSockets(), 0);
        const memoryReference = fresh.lastResources();
        await fresh.close();
        schedule.push({ t: recorder.clock(), action: 'fresh-page', detail: { soakedRows: soaked?.retainedRows, loaded } });
        const page: PageReport = { ...report, ...(memoryReference ? { memoryReference } : {}) };
        return { page, cycles, shown, lastReplies, written };
      });
      const wire = recorder.transcript();
      const resources = outcome.page.resources ?? [];
      measurements.cycles = outcome.cycles;
      measurements.rowsWritten = outcome.written;
      measurements.lastRepliesShown = { panes: outcome.lastReplies, sessions: SESSIONS.length };
      measurements.series = { samples: resources.length, heapBytes: { first: resources[0]?.heapBytes, last: resources.at(-1)?.heapBytes, max: Math.max(...resources.map(sample => sample.heapBytes)) },
        retainedRows: { first: resources[0]?.retainedRows, last: resources.at(-1)?.retainedRows },
        heapPerRetainedRow: { soaked: perRow(resources.at(-1)), fresh: perRow(outcome.page.memoryReference) }, freshPage: outcome.page.memoryReference,
        extraRows: { first: resources[0]?.rows, last: resources.at(-1)?.rows, max: Math.max(...resources.map(sample => sample.rows)) }, sockets: { min: Math.min(...resources.map(sample => sample.sockets)), max: Math.max(...resources.map(sample => sample.sockets)) } };
      const delivery: InvariantResult = { invariant: 'streamed-replies-shown', checked: SESSIONS.length, status: outcome.lastReplies >= SESSIONS.length ? 'passed' : 'failed',
        violations: outcome.lastReplies >= SESSIONS.length ? [] : [{ message: `the last streamed reply is shown in ${outcome.lastReplies} of ${SESSIONS.length} panes` }] };
      const results = [memoryFlat(outcome.page), rowCountsStable(outcome.page), socketCountsStable(outcome.page), noDuplicateItemKey(wire, outcome.page), noBlankFrame(outcome.page), noSessionConnectionLabel(outcome.page), journalSequencesContiguous(wire), delivery];
      return { measurements, invariants: mergeInvariantResults([{ label: `${SESSIONS.length} streaming panes`, results }]), schedule, transcript: recorder };
    } finally { await proxy.close(); await group.close().catch(() => {}); await host.close(); }
  },
};
