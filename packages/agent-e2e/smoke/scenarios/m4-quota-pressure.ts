import { restartInstance } from '../../faults/instance-process.mjs';
import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { QUOTA_PROFILES } from '../../faults/quota.mjs';
import { journalSequencesContiguous, liveOnlyItemsSurvive, noBlankFrame, noDuplicateItemKey, noRefusedRowHole, quotaRefusalsReported, refusedWindowNotResent, trimReported, type InvariantResult } from '../invariants/index.js';
import { PageProbe, withContext } from '../lib/probe.js';
import { startScriptedHost } from '../lib/scripted-host.js';
import { heavyHistory, toolCall, TOOL_OUTPUT_CHARS } from '../lib/scripted-rows.js';
import { mergeInvariantResults, type ScheduleStep } from '../report.js';
import type { RunContext, Scenario } from '../scenario.js';
import { TranscriptRecorder } from '../transcript.js';
import { setTimeout as delay } from 'node:timers/promises';

/** The Host's uplink crosses its own proxy; its sockets are numbered from here so they never meet a page's in the transcript. */
const UPLINK_CONNECTION_BASE = 1000;
const SESSION_LIMITS = { ...QUOTA_PROFILES.tinySession, liveOnlyItems: 4 };
const HOST_LIMITS = QUOTA_PROFILES.tinyHost;

/**
 * M4: the Relay runs with tiny journal limits and a scripted Host publishes sessions whose tool outputs add up to several MiB.
 * What the Relay's journal does with a window it cannot hold is to refuse it whole and say so (`journal_refused`), leaving the session to
 * be served by its Controller; it never keeps part of it. So the page must show no hole and a trimmed tail must say there is older history,
 * the Relay must answer every window it was given, the Controller must not send a refused window again unchanged on the same connection
 * (it backs off until the window changes), and tool calls that are still running (they exist only live) must stay on the page.
 * Condition one limits one session; condition two limits the Host, whose sessions each fit but not together.
 */
export const quotaPressure: Scenario = {
  id: 'M4',
  title: 'Quota pressure',
  quick: true,
  journals: true,
  async run(context) {
    const foreign = await context.pool.foreignActiveSessions();
    if (foreign.length > 0) throw new Error(`Sessions this run did not create are active (${foreign.length}); restarting the instance would interrupt them.`);
    const recorder = new TranscriptRecorder();
    const schedule: ScheduleStep[] = [];
    const measurements: Record<string, unknown> = {};
    try {
      const session = await sessionQuota(context, recorder, schedule, measurements);
      const host = await hostQuota(context, recorder, schedule, measurements);
      return { measurements, invariants: mergeInvariantResults([...session, ...host]), schedule, transcript: recorder };
    } finally {
      // The next scenario runs against the production limits.
      await restartInstance(context.instance, { checkout: context.checkout }).catch(error => context.log(`M4: restoring the default limits failed: ${(error as Error).message}`));
    }
  },
};

/** The instance restarted with `limits`, and a scripted Host on it whose uplink the recorder watches. */
async function withLimits<T>(context: RunContext, recorder: TranscriptRecorder, schedule: ScheduleStep[], limits: object, hostName: string, sessions: Parameters<typeof startScriptedHost>[1]['sessions'],
  body: (host: Awaited<ReturnType<typeof startScriptedHost>>, proxy: { origin: string }) => Promise<T>): Promise<{ value: T; restart: unknown }> {
  schedule.push({ t: recorder.clock(), action: 'restart-with-limits', detail: { limits } });
  const restart = await restartInstance(context.instance, { checkout: context.checkout, journalLimits: limits });
  const uplink = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: message => recorder.tap({ ...message, connection: message.connection + UPLINK_CONNECTION_BASE }) });
  const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: recorder.tap, onSocket: recorder.socket });
  const host = await startScriptedHost(context.instance, { name: hostName, installationId: `smoke-${hostName.replace(/\W+/g, '-').toLowerCase()}-${context.seed}`, uplinkVia: uplink.origin, sessions });
  try { return { value: await body(host, proxy), restart }; }
  finally { await proxy.close(); await host.close(); await uplink.close(); }
}

async function sessionQuota(context: RunContext, recorder: TranscriptRecorder, schedule: ScheduleStep[], measurements: Record<string, unknown>) {
  const calls = context.random.int(40, 60);
  const churn = context.random.int(8, 14);
  const sessions = { heavy: { title: 'Heavy tool outputs', history: heavyHistory('scripted', 'heavy', { calls, answer: 'M4-HISTORY-END' }) } };
  const first = recorder.transcript().length;
  const { value, restart } = await withLimits(context, recorder, schedule, SESSION_LIMITS, 'Smoke M4 session Host', sessions, async (host, proxy) => withContext(context.browser, proxy.origin, async browserContext => {
    // The scenario reads tool calls, the running ones included, as rows of their own: the Full process display shows every step of a turn.
    const probe = await PageProbe.create(browserContext, recorder.origin, { process: 'full' });
    await probe.open(host.sessionUrl('heavy').replace(context.instance.origin, proxy.origin), 'open heavy', { rowsDeadlineMs: 90_000 });
    const historyShown = await probe.waitForText('M4-HISTORY-END', 60_000);
    const live = await (async () => { for (let at = 0; at < 100; at += 1) { const open = host.provider.session('heavy'); if (open) return open; await delay(100); } throw new Error('The scripted Host never opened the session.'); })();
    // Three tool calls that run and never finish: the items that exist only live.
    const liveCommands = ['live-tool-1', 'live-tool-2', 'live-tool-3'];
    for (const [at, command] of liveCommands.entries()) live.push(toolCall('scripted', `heavy:live${at + 1}`, { command, running: true }));
    schedule.push({ t: recorder.clock(), action: 'running-tool-calls', detail: { count: liveCommands.length } });
    await probe.waitForText('live-tool-3', 30_000);
    const liveKeys = (await probe.rows()).filter(row => liveCommands.some(command => row.text.includes(command))).map(row => row.key);
    // More finished output while they run: each 64 KiB output pushes the journal against its limit.
    for (let at = 0; at < churn; at += 1) { live.push(toolCall('scripted', `heavy:churn${at + 1}`, { command: `churn-${at + 1}` })); await delay(150); }
    schedule.push({ t: recorder.clock(), action: 'churn-outputs', detail: { count: churn, bytes: churn * TOOL_OUTPUT_CHARS } });
    const churnShown = await probe.waitForText(`churn-${churn}`, 60_000);
    await probe.page.waitForTimeout(2000);
    await probe.snapshotKeys();
    const page = await probe.report();
    // A second page opens the session fresh: it is served whatever the Relay will serve after the pressure.
    const secondFrom = recorder.transcript().at(-1)!.n;
    const second = await PageProbe.create(browserContext, recorder.origin, { process: 'full' });
    await second.open(host.sessionUrl('heavy').replace(context.instance.origin, proxy.origin), 'reopen heavy', { rowsDeadlineMs: 90_000 });
    await second.page.waitForTimeout(2000);
    await second.snapshotKeys();
    const secondPage = await second.report();
    await second.close(); await probe.close();
    return { page, secondPage, secondFrom, liveKeys, historyShown, churnShown };
  }));
  const wire = recorder.transcript().slice(first);
  const reopened = wire.filter(entry => entry.n > value.secondFrom);
  const publishes = wire.filter(entry => 'message' in entry && entry.message.type === 'journal_publish');
  measurements.sessionQuota = { limits: SESSION_LIMITS, restart, historyCalls: calls, historyBytes: calls * TOOL_OUTPUT_CHARS, historyShown: value.historyShown, churnShown: value.churnShown, liveKeysShown: value.liveKeys.length,
    rows: { first: value.page.finalRows.length, reopened: value.secondPage.finalRows.length }, publishes: publishes.length,
    refusals: wire.filter(entry => 'message' in entry && entry.message.type === 'journal_refused').length,
    tailPageBytes: wire.flatMap(entry => 'message' in entry && entry.direction === 'relay->browser' && entry.message.type === 'timeline_page' && entry.message.payload?.direction === 'tail' ? [JSON.stringify(entry.message.payload).length] : []) };
  const results: Array<{ label: string; results: InvariantResult[] }> = [
    { label: 'one session over its limit', results: [quotaRefusalsReported(wire, { sessionBytes: SESSION_LIMITS.sessionBytes }), refusedWindowNotResent(wire), trimReported(wire), noRefusedRowHole(wire), journalSequencesContiguous(wire), noDuplicateItemKey(wire, value.page), noBlankFrame(value.page), liveOnlyItemsSurvive(value.page, value.liveKeys)] },
    { label: 'fresh open after the pressure', results: [trimReported(reopened), noRefusedRowHole(reopened), noDuplicateItemKey(reopened, value.secondPage), liveOnlyItemsSurvive(value.secondPage, value.liveKeys)] },
  ];
  return results;
}

async function hostQuota(context: RunContext, recorder: TranscriptRecorder, schedule: ScheduleStep[], measurements: Record<string, unknown>) {
  const count = 4;
  const callsEach = Math.floor(HOST_LIMITS.sessionBytes * 0.7 / TOOL_OUTPUT_CHARS);
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, at) => [`bulk${at + 1}`, { title: `Bulk ${at + 1}`, history: heavyHistory('scripted', `bulk${at + 1}`, { calls: callsEach, answer: `M4-BULK-END-${at + 1}` }) }]));
  const first = recorder.transcript().length;
  const { value, restart } = await withLimits(context, recorder, schedule, HOST_LIMITS, 'Smoke M4 Host quota Host', sessions, async (host, proxy) => withContext(context.browser, proxy.origin, async browserContext => {
    const pages: Array<{ id: string; shown: boolean; keys: number; page: Awaited<ReturnType<PageProbe['report']>>; from: number }> = [];
    for (let at = 1; at <= count; at += 1) {
      const probe = await PageProbe.create(browserContext, recorder.origin, { process: 'full' });
      const from = recorder.transcript().at(-1)?.n ?? 0;
      await probe.open(host.sessionUrl(`bulk${at}`).replace(context.instance.origin, proxy.origin), `open bulk${at}`, { rowsDeadlineMs: 90_000 });
      const shown = await probe.waitForText(`M4-BULK-END-${at}`, 60_000);
      await probe.page.waitForTimeout(1500);
      await probe.snapshotKeys();
      pages.push({ id: `bulk${at}`, shown, keys: (await probe.rows()).length, page: await probe.report(), from });
      await probe.close();
    }
    return pages;
  }));
  const wire = recorder.transcript().slice(first);
  const answers = wire.flatMap(entry => 'message' in entry && entry.direction === 'relay->browser' && ['journal_ack', 'journal_refused'].includes(entry.message.type) ? [entry.message.type] : []);
  measurements.hostQuota = { limits: HOST_LIMITS, restart, sessions: count, historyBytesEach: callsEach * TOOL_OUTPUT_CHARS, shown: value.map(item => ({ id: item.id, shown: item.shown, rows: item.keys })), refusals: answers.filter(type => type === 'journal_refused').length };
  return value.map(item => ({ label: `${item.id} under the Host's quota`, results: [noRefusedRowHole(wire.filter(entry => entry.n > item.from)), trimReported(wire.filter(entry => entry.n > item.from)), noDuplicateItemKey(wire.filter(entry => entry.n > item.from), item.page), noBlankFrame(item.page)] }))
    .concat([{ label: 'the Host quota', results: [quotaRefusalsReported(wire), refusedWindowNotResent(wire)] }]);
}
