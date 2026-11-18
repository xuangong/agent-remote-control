import { randomUUID } from 'node:crypto';
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

export async function openPage(browser: Browser, url: string, viewport = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await resetWindows(context, new URL(url).origin);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

export const rowTexts = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.agent-timeline-entry')].map(node => (node.textContent ?? '').trim()));
