import { randomUUID } from 'node:crypto';
import { watchSockets, watchWords } from './page.js';
import { chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** One headless browser for a file of flows; every flow opens its own signed-out context, which the Relay signs in as the local user. `E2E_BROWSER=webkit` runs the flows in WebKit. */
export async function launchBrowser(): Promise<Browser> { return (process.env.E2E_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true }); }

/**
 * Deletes every Window of the signed-in local user. The Relay keeps Windows per user, not per browser, so a flow that opened a session
 * earlier would otherwise leave its view in the Window of the next flow; each flow starts from a Window that holds nothing.
 */
export async function resetWindows(context: BrowserContext, origin: string): Promise<void> {
  const status = await (await context.request.get(origin + '/auth/status')).json() as { basePath: string };
  const base = origin + status.basePath + 'v1/windows';
  const { windows } = await (await context.request.get(base)).json() as { windows: Array<{ id: string; revision: number }> };
  for (const window of windows) {
    const response = await context.request.delete(`${base}/${encodeURIComponent(window.id)}`, {
      headers: { origin }, data: { operationId: randomUUID(), issuedAt: Date.now(), baseRevision: window.revision, operation: { type: 'delete' } },
    });
    if (!response.ok()) throw new Error(`Could not delete the Window ${window.id} (${response.status()}).`);
  }
}

export interface PageOptions {
  viewport?: { width: number; height: number };
  /** Emulate a phone: touch input and the mobile viewport behaviour. */
  mobile?: boolean;
  /**
   * Keep Relay frames back until `sockets.release()`. `true` holds from the first timeline page, so the page shows only what it has on the
   * device; `'agent_snapshot'` holds from the session's first snapshot, so a session this device never opened has no state yet.
   */
  hold?: boolean | 'agent_snapshot';
  /**
   * Answers the Relay's HTTP requests whose path matches `requests` `ms` late, as a slow Relay or network does: the page opens through
   * the waits this makes, such as an attach still on its way or a session locator the page has not confirmed yet.
   */
  relayDelay?: { requests: RegExp; ms: number };
}

/** A page on `url` in `context`, which already has its Window. Its WebSockets pass through a route that a flow can cut (`sockets.drop()`), wait on (`sockets.recoveredFrom`) or hold back (`hold`). */
export async function openPageIn(context: BrowserContext, url: string, options: PageOptions = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const delay = options.relayDelay;
  if (delay) await page.route(url => delay.requests.test(url.pathname), async route => { await new Promise(resolve => setTimeout(resolve, delay.ms)); await route.continue(); });
  const sockets = await watchSockets(page, options.hold);
  const words = await watchWords(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, sockets, words };
}

/** A fresh context, signed in as the local user with a Window that holds nothing, and a page on `url`. */
export async function openPage(browser: Browser, url: string, options: PageOptions = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 }, ...(options.mobile ? { isMobile: true, hasTouch: true } : {}) });
  await resetWindows(context, new URL(url).origin);
  return { context, ...await openPageIn(context, url, options) };
}

export const rowTexts = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.agent-timeline-entry')].map(node => (node.textContent ?? '').trim()));
