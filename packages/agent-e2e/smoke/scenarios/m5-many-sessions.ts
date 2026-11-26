import { planManySessions } from '../../faults/many-sessions.mjs';
import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { memoryFlat, noDuplicateItemKey, subscriptionsWithinBudget, unchangedRowsNotRerendered } from '../invariants/index.js';
import { positiveInteger } from '../lib/arguments.js';
import { createBotGroup } from '../lib/bot-group.js';
import { PageProbe, withContext } from '../lib/probe.js';
import { startScriptedHost } from '../lib/scripted-host.js';
import { mergeInvariantResults } from '../report.js';
import type { Scenario } from '../scenario.js';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * The live subscriptions one device keeps in Bot mode: the selected bot, the four most recently used (`LIVE_RECENT` of the Workbench) and one
 * conversation that is still inside its grace period. It is the budget the Workbench documents, not a number taken from a run.
 */
const LIVE_SUBSCRIPTION_BUDGET = 6;
const SAMPLE_EVERY_MS = 2000;

/**
 * M5: a scripted Host publishes `--sessions` sessions (200) and a group of 50 of them is made bots of one group. The page opens the group in
 * Bot mode while a seeded plan opens, folds, sleeps and wakes bots and writes to the other sessions (directory churn). The page must keep few
 * live subscriptions, leave the rows of bots that did not change as the same elements, and not grow its heap.
 */
export const manySessions: Scenario = {
  id: 'M5',
  title: 'Many sessions',
  quick: false,
  journals: true,
  async run(context) {
    const sessionCount = positiveInteger('--sessions', 200);
    const groupSize = Math.min(50, sessionCount);
    const actions = positiveInteger('--actions', 300);
    const plan = planManySessions({ seed: context.seed, sessionCount, groupSize, actions, spacingMs: 300 });
    const recorder = context.evidence.recorder;
    const schedule = context.evidence.schedule;
    const measurements: Record<string, unknown> = Object.assign(context.evidence.measurements, { sessions: sessionCount, groupSize, actions });
    const titleOf = (id: string) => `Bot ${id}`;
    const host = await startScriptedHost(context.instance, { name: 'Smoke M5 Host', installationId: `smoke-m5-${context.seed}`,
      sessions: Object.fromEntries(plan.sessions.map(session => [session.id, { title: titleOf(session.id), history: [{ role: 'user' as const, text: `Question for ${session.id}` }, { role: 'assistant' as const, text: `Answer from ${session.id}` }] }])) });
    const grouped = plan.group;
    const group = await createBotGroup(context.instance.origin, { id: `smoke-m5-${context.seed}`, title: 'Smoke M5 group', hostId: host.hostId, providerId: host.provider.providerId, sessions: grouped.map(id => ({ nativeSessionId: id, title: titleOf(id) })) });
    const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: recorder.tap, onSocket: recorder.socket });
    try {
      const page = await withContext(context.browser, proxy.origin, async browserContext => {
        const probe = await PageProbe.create(browserContext, recorder.origin);
        const url = new URL(host.sessionUrl(grouped[0]!).replace(context.instance.origin, proxy.origin));
        url.search = `?mode=bot&section=${encodeURIComponent(group.id)}&bot=${encodeURIComponent(group.viewOf(grouped[0]!))}`;
        context.evidence.step('opening the group page');
        await probe.open(url.toString(), 'open group', { rowsDeadlineMs: 90_000 });
        await probe.page.waitForSelector('.lab-bot-row', { timeout: 60_000 });
        const rosterRows = await probe.page.locator('.lab-bot-row').count();
        measurements.rosterRows = rosterRows;
        // The bots the plan never touches keep their rows; those are the rows that must stay the same elements.
        const touched = new Set(plan.plan.map(step => step.session));
        const untouched = grouped.filter(id => !touched.has(id)).map(titleOf);
        measurements.untouchedBots = untouched.length;
        const marked = await probe.page.evaluate(({ labels }: { labels: string[] }) => (window as any).__smoke.markLabelled('.lab-bot-row', labels), { labels: untouched });
        measurements.rowsMarked = marked;
        await probe.sampleResources(proxy.openWebSockets());
        const state = new Map<string, 'open' | 'folded' | 'asleep'>();
        const started = Date.now();
        let nextSample = started + SAMPLE_EVERY_MS;
        const applied: Record<string, number> = { open: 0, fold: 0, sleep: 0, wake: 0, churn: 0 };
        for (const [index, step] of plan.plan.entries()) {
          context.evidence.step(`applying action ${index + 1} of ${plan.plan.length}: ${step.action}`);
          const wait = started + step.at - Date.now();
          if (wait > 0) await delay(wait);
          const inGroup = grouped.includes(step.session);
          if (!inGroup) {
            // A session outside the group changes in the directory: a new row in its native history.
            host.provider.terminalWrite(step.session, { role: 'assistant', text: `Churn ${step.at}` });
            applied.churn! += 1;
          } else if (step.action === 'open' || step.action === 'wake') {
            if (state.get(step.session) === 'asleep') { await group.edit({ type: 'bot.update', viewId: group.viewOf(step.session), details: {} }); }
            if (state.get(step.session) === 'folded') await group.edit({ type: 'view.collapse', viewId: group.viewOf(step.session), collapsed: false });
            await probe.page.locator('.lab-bot-row', { hasText: titleOf(step.session) }).first().click({ timeout: 10_000 }).catch(() => {});
            state.set(step.session, 'open'); applied[step.action]! += 1;
          } else if (step.action === 'fold') {
            await group.edit({ type: 'view.collapse', viewId: group.viewOf(step.session), collapsed: true }); state.set(step.session, 'folded'); applied.fold! += 1;
          } else {
            await group.edit({ type: 'bot.update', viewId: group.viewOf(step.session), details: { asleep: true } }); state.set(step.session, 'asleep'); applied.sleep! += 1;
          }
          if (Date.now() >= nextSample) { await probe.sampleResources(proxy.openWebSockets()); nextSample = Date.now() + SAMPLE_EVERY_MS; }
        }
        schedule.push({ t: recorder.clock(), action: 'plan-applied', detail: { ...applied, seed: context.seed } });
        measurements.applied = applied;
        await probe.page.waitForTimeout(3000);
        await probe.sampleResources(proxy.openWebSockets());
        await probe.snapshotKeys();
        const survivors = await probe.page.evaluate(() => (window as any).__smoke.survivors());
        const report = await probe.report({ survivors });
        await probe.close();
        return report;
      });
      const wire = recorder.transcript();
      const subscribes = wire.filter(entry => 'message' in entry && entry.direction === 'browser->relay' && entry.message.type === 'subscribe').length;
      const peak = (() => { let live = 0, most = 0; const open = new Set<string>(); for (const entry of wire) { if (!('message' in entry) || entry.subscriptionId === undefined) continue; const key = `${entry.connection}:${entry.subscriptionId}`; if (entry.direction === 'browser->relay' && entry.message.type === 'subscribe') open.add(key); else if (entry.message.type === 'closed' || entry.message.type === 'unsubscribe') open.delete(key); live = open.size; most = Math.max(most, live); } return most; })();
      const heap = (page.resources ?? []).map(sample => sample.heapBytes);
      measurements.subscriptions = { subscribes, peakLive: peak, budget: LIVE_SUBSCRIPTION_BUDGET };
      measurements.heapBytes = { first: heap[0], last: heap.at(-1), max: Math.max(...heap), samples: heap.length };
      measurements.survivors = page.survivors;
      const results = [subscriptionsWithinBudget(wire, LIVE_SUBSCRIPTION_BUDGET), unchangedRowsNotRerendered(page), memoryFlat(page), noDuplicateItemKey(wire, page)];
      return { measurements, invariants: mergeInvariantResults([{ label: `${sessionCount} sessions, group of ${groupSize}`, results }]), schedule, transcript: recorder };
    } finally {
      await proxy.close();
      await group.close().catch(error => context.log(`M5: the group could not be deleted: ${(error as Error).message}`));
      await host.close();
    }
  },
};
