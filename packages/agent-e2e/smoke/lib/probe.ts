import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { PageReport } from '../invariants/types.js';
import { observerSource, toPageRows, toPageSamples, type RawSample } from './observer.js';

/** Playwright of the Lab package, with its bundled Chromium: the checkout's headless browser, never the user's own. */
export function loadChromium(checkout: string): any {
  return createRequire(join(checkout, 'packages/agent-remote-lab/package.json'))('@playwright/test').chromium;
}

/** A Window can hold other views beside the one a run opened; a run drives its own, the primary conversation. */
export const PRIMARY = '.lab-primary-conversation';

/** `ms` is the time from the arrival of the page's document to its first row: the part the product controls. `totalMs` adds the document's own trip, which no code can shorten. */
export interface Paint { label: string; ms: number; fromDeviceStore: boolean; timedOut?: boolean; totalMs?: number }

/** One headless page opened on a session through the proxy, with the observer and the Network events that the invariants need. */
export class PageProbe {
  private readonly paints: Paint[] = [];
  private readonly rowKeys: string[][] = [];
  private readonly resources: NonNullable<PageReport['resources']> = [];
  private timelinePageAt: number | undefined;
  private constructor(readonly page: any, private readonly clockOrigin: number, private readonly cdp: any) {}

  static async create(context: any, clockOrigin: number): Promise<PageProbe> {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.addInitScript(observerSource);
    const cdp = await context.newCDPSession(page);
    const probe = new PageProbe(page, clockOrigin, cdp);
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    cdp.on('Network.webSocketFrameReceived', (event: any) => {
      if (probe.timelinePageAt === undefined && typeof event.response?.payloadData === 'string' && event.response.payloadData.includes('"timeline_page"')) probe.timelinePageAt = Date.now();
    });
    return probe;
  }

  /**
   * Opens a session URL and waits for its first rows. Records a paint: how long the first row took and whether it appeared
   * before the first timeline page crossed the wire, which is only possible from the device store.
   */
  async open(url: string, label: string, { rowsDeadlineMs = 60_000 }: { rowsDeadlineMs?: number } = {}): Promise<Paint> {
    this.timelinePageAt = undefined;
    const started = Date.now();
    let paint: Paint;
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: rowsDeadlineMs });
      await this.page.waitForFunction(() => (document.querySelector('.lab-primary-conversation') ?? document).querySelectorAll('.agent-timeline-entry').length > 0, undefined, { timeout: Math.max(1000, rowsDeadlineMs - (Date.now() - started)) });
      const firstRowAt: number = await this.page.evaluate(() => (window as any).__smoke.firstRowAt());
      const documentAt: number = await this.page.evaluate(() => performance.timeOrigin + (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseEnd);
      paint = { label, ms: Math.max(0, Math.round(firstRowAt - documentAt)), totalMs: firstRowAt - started, fromDeviceStore: this.timelinePageAt === undefined || firstRowAt < this.timelinePageAt };
    } catch {
      // A page that shows nothing in time is a result, not a harness failure.
      paint = { label, ms: rowsDeadlineMs, fromDeviceStore: false, timedOut: true };
    }
    this.paints.push(paint);
    return paint;
  }

  /**
   * Waits until the device store has a conversation on disk. A person who read a conversation and leaves has it kept (the store writes
   * when the page is hidden); a probe that closes the page at once would drop the write that is still queued.
   */
  async waitForKeptRecord(deadlineMs = 10_000): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    const kept = () => this.page.evaluate(() => new Promise<boolean>(resolve => {
      const opening = indexedDB.open('agent-remote-image-drafts');
      opening.onerror = () => resolve(false);
      opening.onsuccess = () => {
        const database = opening.result;
        if (!database.objectStoreNames.contains('sessions')) { database.close(); resolve(false); return; }
        const count = database.transaction('sessions').objectStore('sessions').count();
        count.onsuccess = () => { database.close(); resolve(count.result > 0); };
        count.onerror = () => { database.close(); resolve(false); };
      };
    })).catch(() => false);
    while (Date.now() < until) {
      if (await kept()) return true;
      await this.page.waitForTimeout(100);
    }
    return false;
  }

  /** Types the text into the composer and submits it. */
  async send(text: string): Promise<void> {
    const composer = this.page.locator(`${PRIMARY} [data-testid="prompt-input"]`);
    await composer.click();
    await this.page.keyboard.type(text);
    await this.page.locator(`${PRIMARY} [data-testid="prompt-submit"]`).click();
  }

  assistantCount(): Promise<number> { return this.page.evaluate(() => (document.querySelector('.lab-primary-conversation') ?? document).querySelectorAll('.agent-message-assistant').length); }

  /** Waits until the page shows more assistant messages than `before`, containing `needle`. */
  async waitForReplyContaining(needle: string, deadlineMs: number): Promise<boolean> {
    try {
      await this.page.waitForFunction((word: string) => [...(document.querySelector('.lab-primary-conversation') ?? document).querySelectorAll('.agent-message-assistant')].some(node => (node.textContent ?? '').includes(word)), needle, { timeout: deadlineMs });
      return true;
    } catch { return false; }
  }

  /** The rendered rows; none while the page has not loaded far enough to have an observer. */
  rows(): Promise<Array<{ key: string; kind: string; text: string }>> { return this.page.evaluate(() => (window as any).__smoke?.rows() ?? []); }
  /** Remembers the item keys the page renders now. */
  async snapshotKeys(): Promise<string[]> { const keys = (await this.rows()).map(row => row.key); this.rowKeys.push(keys); return keys; }
  setHidden(hidden: boolean): Promise<void> { return this.page.evaluate((value: boolean) => (window as any).__smoke.setHidden(value), hidden); }

  /**
   * One tick of the page's resource series: heap after a collection, rows held beyond the `expectedRows` the scenario knows it wrote
   * (timeline entries and roster rows; never below zero) and the sockets the caller counts.
   */
  async sampleResources(sockets: number, expectedRows = 0): Promise<void> {
    await this.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    const { metrics } = await this.cdp.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> };
    const rows: number = await this.page.evaluate(() => document.querySelectorAll('.agent-timeline-entry, .lab-bot-row').length);
    this.resources.push({ t: Date.now() - this.clockOrigin, heapBytes: metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? 0, rows: Math.max(0, rows - expectedRows), sockets });
  }

  async report(extra: Partial<PageReport> = {}): Promise<PageReport> {
    const raw: RawSample[] = await this.page.evaluate(() => (window as any).__smoke?.log.slice() ?? []);
    const finalRows = toPageRows(await this.rows());
    return { samples: toPageSamples(raw, this.clockOrigin), paints: [...this.paints], rowKeys: [...this.rowKeys], finalRows, ...(this.resources.length > 0 ? { resources: [...this.resources] } : {}), ...extra };
  }

  async close(): Promise<void> { await this.page.close().catch(() => {}); }
}

/** One browser context signs in once; closing it signs out so the instance does not keep the page's session. */
export async function withContext<T>(browser: any, origin: string, body: (context: any) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try { return await body(context); }
  finally {
    for (const open of context.pages()) await open.close().catch(() => {});
    await context.request.post(`${origin}/auth/logout`, { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
    await context.close().catch(() => {});
  }
}
