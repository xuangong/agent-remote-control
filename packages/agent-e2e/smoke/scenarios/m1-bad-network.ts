import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { firstPaintFromDeviceStore, journalSequencesContiguous, messagesSettleOnce, noDuplicateItemKey, noSessionConnectionLabel, type InvariantResult } from '../invariants/index.js';
import { PageProbe, withContext } from '../lib/probe.js';
import type { Provider } from '../lib/sessions.js';
import { mergeInvariantResults, type ScheduleStep } from '../report.js';
import type { Scenario } from '../scenario.js';
import { TranscriptRecorder } from '../transcript.js';

interface Condition { provider: Provider; rttMs: number; lossRate: number }

const label = (condition: Condition) => `${condition.provider} ${condition.rttMs} ms ${Math.round(condition.lossRate * 100)}% loss`;

/**
 * M1: the page opens a session twice (so the second open has a device store to paint from) and sends a real message while the
 * proxy delays, jitters and drops traffic. `--condition claude:1500:0.1` (repeatable) replaces the default conditions. The first rows of the revisit must come from the device store, and the message,
 * sent at once while the session opens, must leave the page and settle exactly once.
 */
export const badNetwork: Scenario = {
  id: 'M1',
  title: 'Bad network: latency, jitter and loss',
  quick: true,
  async run(context) {
    const chosen = process.argv.flatMap((arg, at) => arg === '--condition' ? [process.argv[at + 1] ?? ''] : []);
    const conditions: Condition[] = chosen.length > 0 ? chosen.map(text => { const [provider, rttMs, lossRate] = text.split(':'); return { provider: provider as Provider, rttMs: Number(rttMs), lossRate: Number(lossRate) }; }) : context.quick
      ? [{ provider: 'claude', rttMs: 300, lossRate: 0.02 }, { provider: 'codex', rttMs: 300, lossRate: 0.02 }]
      : [...[50, 300, 1500].flatMap(rttMs => [0.02, 0.1].map(lossRate => ({ provider: 'claude' as const, rttMs, lossRate }))), { provider: 'codex', rttMs: 300, lossRate: 0.02 }];
    const schedule: ScheduleStep[] = [];
    const results: Array<{ label: string; results: InvariantResult[] }> = [];
    const measurements: Record<string, unknown> = { conditions: [] as unknown[] };
    const recorder = new TranscriptRecorder();
    for (const condition of conditions) {
      const name = label(condition);
      context.log(`M1: ${name}`);
      const address = await context.sessionWithHistory(condition.provider);
      const url = await context.pool.link(address);
      const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: condition.rttMs, jitterMs: Math.round(condition.rttMs * 0.2), lossRate: condition.lossRate,
        seed: context.seed, tap: recorder.tap, onSocket: recorder.socket });
      const conditionStart = recorder.clock();
      schedule.push({ t: conditionStart, action: 'proxy-start', detail: { ...condition } });
      try {
        const viaProxy = url.replace(context.instance.origin, proxy.origin);
        const word = `ZEPHYR${context.random.int(100, 999)}`;
        const condition_ = await withContext(context.browser, proxy.origin, async browserContext => {
          const first = await PageProbe.create(browserContext, recorder.origin);
          const firstOpen = await first.open(viaProxy, `first open, ${name}`, { rowsDeadlineMs: 90_000 });
          const kept = firstOpen.timedOut || await first.waitForKeptRecord();
          await first.close();
          if (!kept) context.log(`M1: ${name}: the first open left no record on the device`);
          const probe = await PageProbe.create(browserContext, recorder.origin);
          const revisit = firstOpen.timedOut ? firstOpen : await probe.open(viaProxy, `revisit, ${name}`, { rowsDeadlineMs: 90_000 });
          const ready = !revisit.timedOut && await probe.page.waitForFunction(() => (window as any).__smoke.read().composer === 'enabled', undefined, { timeout: 90_000 }).then(() => true, () => false);
          if (!ready) {
            // The person meant to send the message: a composer that never took it fails message-settles-once, as a held one does.
            recorder.mark('turn-sent', { condition: name, word, composer: revisit.timedOut ? 'no rows' : 'never enabled' });
            const page = await probe.report();
            await probe.close();
            return { revisit, replied: false, page: { ...page, paints: [...page.paints, ...(revisit.timedOut ? [revisit] : [])] } };
          }
          recorder.mark('turn-sent', { condition: name, word });
          schedule.push({ t: recorder.clock(), action: 'send', detail: { word } });
          await probe.send(`Reply with the single word ${word} and nothing else.`);
          const replied = await probe.waitForReplyContaining(word, 150_000 + condition.rttMs * 40);
          await probe.page.waitForTimeout(2000);
          await probe.snapshotKeys();
          const page = await probe.report();
          await probe.close();
          return { revisit, replied, page };
        });
        const transcript = recorder.transcript();
        const forCondition = transcript.filter(entry => entry.t >= conditionStart);
        const verdicts = [
          firstPaintFromDeviceStore({ ...condition_.page, paints: condition_.page.paints.filter(paint => /^revisit/.test(paint.label) || paint.timedOut) }),
          // The condition is over: its message has left the page and settled, whether or not the model replied in time.
          messagesSettleOnce(forCondition),
          noDuplicateItemKey(forCondition, condition_.page),
          journalSequencesContiguous(forCondition),
          noSessionConnectionLabel(condition_.page),
        ];
        results.push({ label: name, results: verdicts });
        context.log(`M1: ${name}: first rows on revisit ${condition_.revisit.ms} ms, replied ${condition_.replied}`);
        (measurements.conditions as unknown[]).push({ name, revisit: condition_.revisit, replied: condition_.replied, retransmits: proxy.counts.retransmits, webSocketsCrossed: proxy.counts.webSocketsCrossed });
        if (!condition_.revisit.timedOut && proxy.counts.webSocketsCrossed === 0) throw new Error(`No WebSocket crossed the proxy for ${name}; these would not be network results.`);
      } finally { await proxy.close(); }
    }
    return { measurements, invariants: mergeInvariantResults(results), schedule, transcript: recorder };
  },
};
