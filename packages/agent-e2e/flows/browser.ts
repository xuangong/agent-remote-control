import { randomUUID } from 'node:crypto';
import { watchSockets } from './page.js';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** One headless browser for a file of flows; every flow opens its own signed-out context, which the Relay signs in as the local user. */
export async function launchBrowser(): Promise<Browser> { return chromium.launch({ headless: true }); }

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
  /** Keep the Relay's timeline page back until `sockets.release()`, so the page shows only what it has on the device. */
  hold?: boolean;
}

/** A page on `url` in `context`, which already has its Window. Its WebSockets pass through a route that a flow can cut (`sockets.drop()`), wait on (`sockets.recoveredFrom`) or hold back (`hold`). */
export async function openPageIn(context: BrowserContext, url: string, options: PageOptions = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const sockets = await watchSockets(page, options.hold);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, sockets };
}

/** A fresh context, signed in as the local user with a Window that holds nothing, and a page on `url`. */
export async function openPage(browser: Browser, url: string, options: PageOptions = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  await resetWindows(context, new URL(url).origin);
  return { context, ...await openPageIn(context, url, options) };
}

export const rowTexts = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.agent-timeline-entry')].map(node => (node.textContent ?? '').trim()));
