import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** One headless browser for a file of flows; every flow opens its own signed-out context, which the Relay signs in as the local user. */
export async function launchBrowser(): Promise<Browser> { return chromium.launch({ headless: true }); }

export async function openPage(browser: Browser, url: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

export const rowTexts = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.agent-timeline-entry')].map(node => (node.textContent ?? '').trim()));
