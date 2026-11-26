// E14c, the installed app starts from what the device stores. A warm start draws the stored chats and their conversation at once while a slow Relay
// has not answered, and no frame says a list is empty. A start with the Relay gone lists the stored chats, opens one read-only with its stored
// messages, and says in words, unobtrusively, that it shows saved chats. Desktop and a phone viewport; `E2E_BROWSER=webkit` runs both in WebKit.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { team } from './bot-team.js';
import { launchBrowser, openPage, openPageIn, type PageOptions } from './browser.js';
import { showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, sessions: {
    chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
    tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });
let relayStopped = false;
afterEach(async () => { if (relayStopped) { relayStopped = false; await stack.startRelay(); } });

const variants: Array<[string, PageOptions]> = [
  ['desktop 1280x800', { viewport: { width: 1280, height: 800 } }],
  ['phone 390x844', { viewport: { width: 390, height: 844 }, mobile: true }],
];
const falseEmptyWords = ['No chats yet', 'Pick someone to talk to', 'No timeline activity'];

/** Records every empty-state sentence the page ever shows, from the first frame of any page of the context. */
async function watchFalseEmpty(context: BrowserContext): Promise<void> {
  await context.addInitScript(words => {
    const seen: string[] = []; (window as unknown as { __falseEmpty: string[] }).__falseEmpty = seen;
    new MutationObserver(() => { const text = document.body?.innerText ?? ''; for (const word of words) if (text.includes(word) && !seen.includes(word)) seen.push(word); })
      .observe(document, { childList: true, subtree: true, characterData: true });
  }, falseEmptyWords);
}
const falseEmpty = (page: Page) => page.evaluate(() => (window as unknown as { __falseEmpty: string[] }).__falseEmpty);
const rows = (page: Page) => page.locator('.lab-bot-row:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));

/** A device that has opened the app once: the group with Chief and Tracker is in its roster, and Chief's conversation is stored. */
async function primedDevice(options: PageOptions) {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'), options);
  await team(stack, context);
  await page.goto(stack.origin + '/?mode=bot', { waitUntil: 'domcontentloaded' });
  await page.locator('.lab-bot-row:visible').first().waitFor();
  await page.locator('.lab-bot-row:visible', { hasText: 'Chief' }).first().click();
  await showsText(page, 'Chief is ready.');
  // The device writes the conversation and the catalog behind the page's frame; a start waits until they are down.
  await page.evaluate(() => new Promise<void>(done => setTimeout(done, 2500)));
  await page.close();
  return context;
}

describe.each(variants)('E14c at %s', (_name, view) => {
  it('E14c: a warm start shows the stored chats and conversation before a slow Relay answers, and never says a list is empty', async () => {
    const context = await primedDevice({ ...view, serviceWorkers: 'block' });
    await watchFalseEmpty(context);
    const { page } = await openPageIn(context, stack.origin + '/?mode=bot', { ...view, relayDelay: { requests: /\/(auth\/status|v1\/windows)/, ms: 4000 } });
    const started = Date.now();
    await page.locator('.lab-bot-row:visible').first().waitFor({ timeout: 3500 });
    // The stored chats are on screen well before the Relay's 4 s answer.
    expect(Date.now() - started).toBeLessThan(3500);
    expect((await rows(page)).sort()).toEqual(['Chief', 'Tracker']);
    await page.locator('.lab-bot-row:visible', { hasText: 'Chief' }).first().click();
    await showsText(page, 'Chief is ready.', 3500);
    // The Relay answers late and changes nothing that was shown.
    await page.waitForResponse(response => /\/v1\/windows$/.test(new URL(response.url()).pathname));
    expect(await falseEmpty(page)).toEqual([]);
    await context.close();
  }, 90_000);

  it('E14c: a start with the Relay gone lists the stored chats, opens one read-only with its messages, and says it shows saved chats', async () => {
    const context = await primedDevice(view);
    await watchFalseEmpty(context);
    // The first page of this context has started the app's worker, which keeps the shell for a start with no network.
    const warm = await openPageIn(context, stack.origin + '/?mode=bot', view);
    await warm.page.locator('.lab-bot-row:visible').first().waitFor();
    await warm.page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => warm.page.evaluate(async () => (await caches.keys()).some(name => name.startsWith('orchard-shell-'))), { timeout: 15_000 }).toBe(true);
    await warm.page.close();
    await stack.stopRelay(); relayStopped = true;
    try {
      const { page } = await openPageIn(context, stack.origin + '/?mode=bot', view);
      await page.locator('.lab-bot-row:visible').first().waitFor({ timeout: 10_000 });
      expect((await rows(page)).sort()).toEqual(['Chief', 'Tracker']);
      await page.locator('.lab-bot-row:visible', { hasText: 'Chief' }).first().click();
      await showsText(page, 'Chief is ready.', 10_000);
      // The page says, in words and without a dialog, that it shows what the device saved.
      await expect.poll(() => page.locator('.lab-bot-offline').textContent(), { timeout: 15_000 }).toBe('Offline. Showing saved chats.');
      expect(await falseEmpty(page)).toEqual([]);
      await page.close();
    } finally { await context.close(); }
  }, 90_000);
});
