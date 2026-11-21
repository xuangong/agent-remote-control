import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { PageReport, ResourceSample } from '../invariants/types.js';
import { observerSource, toPageRows, toPageSamples, type RawSample } from './observer.js';

/** Playwright of the Lab package, with its bundled Chromium: the checkout's headless browser, never the user's own. */
export function loadChromium(checkout: string): any {
  return createRequire(join(checkout, 'packages/agent-remote-lab/package.json'))('@playwright/test').chromium;
}

/**
 * The session a link opens, named as the command line names it (`<hostId>/<providerId>/<nativeSessionId>`); none for a link to a
 * Window, whose sessions the run created and reads together.
 */
export function linkedSession(url: string): string | undefined {
  const query = new URL(url).searchParams;
  const host = query.get('host'), provider = query.get('provider'), session = query.get('session');
  return host && provider && session ? `${host}/${provider}/${session}` : undefined;
}

/**
 * The conversation of the session at `address`, wherever the page shows it. A Window holds other views beside the one a run
 * opened (several primary groups side by side, docks, another session's composer), and a conversation names its native session
 * (`<providerId>/<nativeSessionId>`): before the Window has loaded, the one painted from the device store does not know its Host.
 */
export function sessionPane(address: string): string {
  const [, provider, ...native] = address.split('/');
  return `[data-native-session=${JSON.stringify(`${provider}/${native.join('/')}`)}]`;
}

/**
 * Whether the device store keeps a record of `session` (`<hostId>/<providerId>/<nativeSessionId>`), from the keys of its
 * `sessions` store; any record at all when the page opened a Window. A Window shows several sessions, and a record of another
 * one says nothing about the session a revisit will paint.
 */
export function keptRecordOf(keys: readonly string[], session: string | undefined): boolean {
  if (!session) return keys.length > 0;
  const [, provider, ...native] = session.split('/');
  // A record's key is the device store's `deviceKey(relayUrl, [hostId, providerId, nativeSessionId])`.
  const identity = `${JSON.stringify(provider)},${JSON.stringify(native.join('/'))}]`;
  return keys.some(key => key.includes(identity));
}

/** `ms` is the time from the arrival of the page's document to its first row: the part the product controls. `totalMs` adds the document's own trip, which no code can shorten. */
export interface Paint { label: string; ms: number; fromDeviceStore: boolean; timedOut?: boolean; totalMs?: number }

/**
 * How much of each turn's work a conversation shows (the I3 process display). Concise, the default, folds a turn's tool calls into
 * one work line, so a scenario that waits for a tool-call row, or reads the rows of tools that are still running, opens its pages
 * with Full.
 */
export type ProcessDisplay = 'concise' | 'process' | 'full';
/** This device's default process display, as Settings > Assistants stores it (agent-remote-lab `hooks/useProcessMode.ts`). */
const PROCESS_DISPLAY_KEY = 'agent-remote:process-mode';

/** One headless page opened on a session through the proxy, with the observer and the Network events that the invariants need. */
export class PageProbe {
  private readonly paints: Paint[] = [];
  private readonly rowKeys: string[][] = [];
  private readonly resources: NonNullable<PageReport['resources']> = [];
  private timelinePageAt: number | undefined;
  /** The conversation this page reads and drives: the session its link opened. None when it opened a Window. */
  private pane: string | undefined;
  /** The session its link opened, as the command line names it. */
  private session: string | undefined;
  private constructor(readonly page: any, private readonly clockOrigin: number, private readonly cdp: any, private readonly process: ProcessDisplay | undefined) {}

  /** `process`: the display the scenario reads, chosen as this device's default before the page's own scripts run; none keeps the page's own. */
  static async create(context: any, clockOrigin: number, { process }: { process?: ProcessDisplay } = {}): Promise<PageProbe> {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.addInitScript(observerSource);
    if (process) await page.addInitScript(([key, mode]: [string, string]) => { try { localStorage.setItem(key, mode); } catch { /* A frame with no storage of its own shows no conversation. */ } }, [PROCESS_DISPLAY_KEY, process]);
    const cdp = await context.newCDPSession(page);
    const probe = new PageProbe(page, clockOrigin, cdp, process);
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    cdp.on('Network.webSocketFrameReceived', (event: any) => {
      if (probe.timelinePageAt === undefined && typeof event.response?.payloadData === 'string' && event.response.payloadData.includes('"timeline_page"')) probe.timelinePageAt = Date.now();
    });
    return probe;
  }

  /**
   * Opens a session URL (or a Window's) and waits for the first rows of its conversation. Records a paint: how long the first row
   * took and whether it appeared before the first timeline page crossed the wire, which is only possible from the device store.
   */
  async open(url: string, label: string, { rowsDeadlineMs = 60_000 }: { rowsDeadlineMs?: number } = {}): Promise<Paint> {
    this.timelinePageAt = undefined;
    const session = linkedSession(url);
    this.session = session;
    this.pane = session ? sessionPane(session) : undefined;
    // The observer reads this conversation from the page's first frame, so it is named before the page's own scripts run.
    await this.page.addInitScript((scope: string | null) => { (window as any).__smokeScope = scope; }, this.pane ?? null);
    const started = Date.now();
    let paint: Paint;
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: rowsDeadlineMs });
      await this.page.waitForFunction(() => (window as any).__smoke.read().entries > 0, undefined, { timeout: Math.max(1000, rowsDeadlineMs - (Date.now() - started)) });
      const firstRowAt: number = await this.page.evaluate(() => (window as any).__smoke.firstRowAt());
      const documentAt: number = await this.page.evaluate(() => performance.timeOrigin + (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseEnd);
      paint = { label, ms: Math.max(0, Math.round(firstRowAt - documentAt)), totalMs: firstRowAt - started, fromDeviceStore: this.timelinePageAt === undefined || firstRowAt < this.timelinePageAt };
    } catch {
      // A page that shows nothing in time is a result, not a harness failure.
      paint = { label, ms: rowsDeadlineMs, fromDeviceStore: false, timedOut: true };
    }
    this.paints.push(paint);
    if (!paint.timedOut) await this.expectProcessDisplay();
    return paint;
  }

  /**
   * The conversation shows the process display the scenario chose. An assistant with a display of its own overrides the device's
   * default; the run stops then, instead of leaving the invariants that read every row unexercised.
   */
  private async expectProcessDisplay(): Promise<void> {
    if (!this.process || !this.pane) return;
    const shown = (): Promise<string> => this.page.evaluate((pane: string) => document.querySelector(pane)?.querySelector('[data-process-mode]')?.getAttribute('data-process-mode') ?? 'none', this.pane);
    const until = Date.now() + 10_000;
    for (let display = await shown(); display !== this.process; display = await shown()) {
      if (Date.now() > until) throw new Error(`The conversation shows the ${display} process display, not ${this.process}: its assistant keeps a display of its own.`);
      await this.page.waitForTimeout(100);
    }
  }

  /**
   * Waits until the device store has a conversation on disk. A person who read a conversation and leaves has it kept (the store writes
   * when the page is hidden); a probe that closes the page at once would drop the write that is still queued.
   */
  async waitForKeptRecord(deadlineMs = 10_000): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    const session = this.session;
    const kept = () => this.page.evaluate(() => new Promise<string[]>(resolve => {
      const opening = indexedDB.open('agent-remote-image-drafts');
      opening.onerror = () => resolve([]);
      opening.onsuccess = () => {
        const database = opening.result;
        if (!database.objectStoreNames.contains('sessions')) { database.close(); resolve([]); return; }
        const keys = database.transaction('sessions').objectStore('sessions').getAllKeys();
        keys.onsuccess = () => { database.close(); resolve(keys.result.map(String)); };
        keys.onerror = () => { database.close(); resolve([]); };
      };
    })).catch(() => [] as string[]);
    while (Date.now() < until) {
      if (keptRecordOf(await kept(), session)) return true;
      await this.page.waitForTimeout(100);
    }
    return false;
  }

  /** The message input of the conversation this page opened (a Playwright locator). */
  composer(): any { return this.page.locator(`${this.ownPane()} [data-testid="prompt-input"]`); }

  /** Types the text into the composer and submits it. */
  async send(text: string): Promise<void> {
    await this.composer().click();
    await this.page.keyboard.type(text);
    await this.page.locator(`${this.ownPane()} [data-testid="prompt-submit"]`).click();
  }

  assistantCount(): Promise<number> { return this.page.evaluate(() => (window as any).__smoke.root().querySelectorAll('.agent-message-assistant').length); }

  /** The texts of the person's messages the conversation holds, oldest first, read from the document whether or not a row is scrolled into view. */
  userTexts(): Promise<string[]> {
    return this.page.evaluate(() => [...(window as any).__smoke.root().querySelectorAll('.agent-timeline-entry .agent-message-user')]
      .map((node: Element) => (node.textContent ?? '').trim()));
  }

  /** The session's activity as the conversation's title carries it (`idle`, `running`, `waiting`, …); none while it shows no title. */
  sessionStatus(): Promise<string | undefined> {
    return this.page.evaluate((pane: string) => document.querySelector(pane)?.querySelector('.agent-session-title[data-session-status]')?.getAttribute('data-session-status') ?? undefined, this.ownPane());
  }

  /**
   * The session's facts as its assistant's details list them under Status: provider, runtime, each setting by its label, usage. The
   * details cover the conversation, so they are opened for the read and closed again.
   */
  async sessionFacts(): Promise<Record<string, string>> {
    const toggle = this.page.locator(`${this.ownPane()} .lab-tile-who`);
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const details = this.page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
    try {
      await details.locator('.agent-session-settings-list button', { hasText: 'Status' }).click({ timeout: 10_000 });
      // The facts, then the usage, each a list of their own.
      await details.locator('dl.agent-session-facts').first().waitFor({ timeout: 10_000 });
      return Object.fromEntries(await details.locator('dl.agent-session-facts dt').evaluateAll((terms: Element[]) =>
        terms.map(term => [term.textContent?.trim() ?? '', term.nextElementSibling?.textContent?.trim() ?? ''])));
    } finally {
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    }
  }

  /** Waits until the conversation shows an assistant message containing `needle`. */
  waitForReplyContaining(needle: string, deadlineMs: number): Promise<boolean> { return this.waitForShown('.agent-message-assistant', needle, deadlineMs); }

  /** Waits until the conversation shows a row containing `text`. */
  waitForText(text: string, deadlineMs: number): Promise<boolean> { return this.waitForShown('.agent-timeline-entry', text, deadlineMs); }

  private async waitForShown(selector: string, needle: string, deadlineMs: number): Promise<boolean> {
    try {
      await this.page.waitForFunction(({ selector, needle }: { selector: string; needle: string }) => [...(window as any).__smoke.root().querySelectorAll(selector)]
        .some((node: Element) => (node.textContent ?? '').includes(needle)), { selector, needle }, { timeout: deadlineMs });
      return true;
    } catch { return false; }
  }

  private ownPane(): string {
    if (!this.pane) throw new Error('This page opened a Window, not a session: it has no conversation of its own to drive.');
    return this.pane;
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
    const retainedRows: number = await this.page.evaluate(() => document.querySelectorAll('.agent-timeline-entry').length);
    this.resources.push({ t: Date.now() - this.clockOrigin, heapBytes: metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? 0, rows: Math.max(0, rows - expectedRows), retainedRows, sockets });
  }

  /** The latest resource sample, if any. */
  lastResources(): ResourceSample | undefined { return this.resources.at(-1); }

  /**
   * Scrolls every conversation to its top until the page renders `rows` conversation rows, so older history loads page by page. Returns the
   * rows rendered when it stopped: at the target, after eight rounds without growth, or at the deadline.
   */
  async loadOlderUntil(rows: number, deadlineMs: number): Promise<number> {
    const until = Date.now() + deadlineMs;
    let shown = 0, idle = 0;
    while (Date.now() < until && idle < 8) {
      const now: number = await this.page.evaluate(() => {
        const scrollers = new Set<Element>();
        for (const entry of document.querySelectorAll('.agent-timeline-entry')) {
          let node = entry.parentElement;
          while (node && !(node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
          if (node) scrollers.add(node);
        }
        for (const scroller of scrollers) { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll')); }
        return document.querySelectorAll('.agent-timeline-entry').length;
      });
      if (now >= rows) return now;
      idle = now > shown ? 0 : idle + 1;
      shown = now;
      await this.page.waitForTimeout(500);
    }
    return shown;
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
