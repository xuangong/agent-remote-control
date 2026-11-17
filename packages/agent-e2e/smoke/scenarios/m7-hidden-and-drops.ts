import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { catchUpCostsOneTailRequest, draftAndPositionKept, halfOpenSocketRecovers, journalSequencesContiguous, noBlankFrame, noDuplicateItemKey, noStaleLabel, type InvariantResult } from '../invariants/index.js';
import { PageProbe, withContext } from '../lib/probe.js';
import { mergeInvariantResults, type ScheduleStep } from '../report.js';
import type { Scenario } from '../scenario.js';
import { TranscriptRecorder } from '../transcript.js';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * M7: the page is hidden and offline while the session gets new messages, then returns. It must catch up with one tail request,
 * clear its reconnecting label, and keep the draft in the composer and the reader's place in the timeline.
 */
export const hiddenAndDrops: Scenario = {
  id: 'M7',
  title: 'Hidden page and network drops',
  quick: true,
  async run(context) {
    const offlineSeconds = context.quick ? [10] : [10, 60, 300];
    const recorder = new TranscriptRecorder();
    const schedule: ScheduleStep[] = [];
    const conditions: Array<{ label: string; results: InvariantResult[] }> = [];
    const measurements: Record<string, unknown> = { drops: [] as unknown[] };
    const address = await context.sessionWithLongHistory('claude');
    const url = await context.pool.link(address);
    const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: recorder.tap, onSocket: recorder.socket });
    try {
      await withContext(context.browser, proxy.origin, async browserContext => {
        const probe = await PageProbe.create(browserContext, recorder.origin);
        await probe.open(url.replace(context.instance.origin, proxy.origin), 'open');
        await probe.page.waitForFunction(() => (window as any).__smoke.read().composer === 'enabled', undefined, { timeout: 60_000 });
        for (const seconds of offlineSeconds) {
          const word = `MERIDIAN${context.random.int(100, 999)}`;
          const first = recorder.transcript().at(-1)?.n ?? 0;
          // The reader must really be in the middle of a long timeline, or the position check would pass without meaning anything.
          let scrolledTo = 0;
          for (let attempt = 0; attempt < 5 && scrolledTo === 0; attempt += 1) {
            await probe.page.waitForTimeout(1000);
            scrolledTo = await probe.page.evaluate(() => (window as any).__smoke.scrollToMiddle());
          }
          if (scrolledTo === 0) throw new Error(`The timeline did not scroll: ${JSON.stringify(await probe.page.evaluate(() => (window as any).__smoke.scrollerSize()))}`);
          await probe.page.waitForTimeout(500);
          await probe.page.locator('[data-testid="prompt-input"]').click();
          await probe.page.keyboard.type(`draft kept ${seconds}`);
          const before = await probe.page.evaluate(() => ({ composer: (window as any).__smoke.composer(), anchor: (window as any).__smoke.anchor() }));
          recorder.mark('page-hidden'); await probe.setHidden(true);
          recorder.mark('offline'); proxy.setOffline(true);
          schedule.push({ t: recorder.clock(), action: 'hidden-and-offline', detail: { seconds } });
          // The session keeps working while the page is away: a new message arrives through the command line.
          await context.pool.send(address, `Reply with the single word ${word} and nothing else.`);
          await delay(seconds * 1000);
          proxy.setOffline(false); recorder.mark('online');
          await probe.setHidden(false); recorder.mark('page-visible');
          schedule.push({ t: recorder.clock(), action: 'visible-and-online', detail: { seconds } });
          const caughtUp = await probe.waitForReplyContaining(word, 90_000);
          await probe.page.waitForTimeout(3000);
          const after = await probe.page.evaluate(() => ({ composer: (window as any).__smoke.composer(), anchor: (window as any).__smoke.anchor() }));
          await probe.snapshotKeys();
          const page = await probe.report({ composer: before.composer && after.composer ? { before: before.composer, after: after.composer } : undefined, anchor: { before: before.anchor, after: after.anchor } });
          const wire = recorder.transcript().filter(entry => entry.n > first);
          conditions.push({ label: `offline ${seconds} s`, results: [catchUpCostsOneTailRequest(wire), noStaleLabel(wire, page), draftAndPositionKept(page), noBlankFrame(page), noDuplicateItemKey(wire, page), journalSequencesContiguous(wire)] });
          (measurements.drops as unknown[]).push({ seconds, scrolledTo, caughtUp, socketsOpenedAfterReturn: wire.filter(entry => 'marker' in entry && entry.marker === 'socket-open').length });
          await probe.page.locator('[data-testid="prompt-input"]').click();
          await probe.page.keyboard.press('Meta+a').catch(() => {});
          await probe.page.keyboard.press('Backspace');
        }
        // A half-open socket: nothing closes, nothing arrives. The page must notice by itself and reconnect.
        {
          const word = `HALFOPEN${context.random.int(100, 999)}`;
          const first = recorder.transcript().at(-1)?.n ?? 0;
          const affected = proxy.halfOpenWebSockets();
          recorder.mark('fault', { kind: 'half-open', sockets: affected });
          schedule.push({ t: recorder.clock(), action: 'half-open', detail: { sockets: affected } });
          await context.pool.send(address, `Reply with the single word ${word} and nothing else.`);
          const caughtUp = await probe.waitForReplyContaining(word, 120_000);
          await probe.page.waitForTimeout(3000);
          await probe.snapshotKeys();
          const page = await probe.report();
          const wire = recorder.transcript().filter(entry => entry.n > first);
          conditions.push({ label: 'half-open sockets', results: [halfOpenSocketRecovers(wire, 90_000), noStaleLabel(wire, page), noBlankFrame(page), noDuplicateItemKey(wire, page), journalSequencesContiguous(wire)] });
          const faultAt = wire.find(entry => 'marker' in entry && entry.marker === 'fault')?.t;
          const replacedAt = wire.find(entry => 'message' in entry && entry.direction === 'relay->browser' && entry.message.type === 'negotiated' && faultAt !== undefined && entry.t > faultAt)?.t;
          (measurements.drops as unknown[]).push({ halfOpen: true, sockets: affected, caughtUp, sessionServedAgainAfterMs: faultAt !== undefined && replacedAt !== undefined ? Math.round(replacedAt - faultAt) : null });
        }
        await probe.close();
      });
    } finally { await proxy.close(); }
    return { measurements, invariants: mergeInvariantResults(conditions), schedule, transcript: recorder };
  },
};
