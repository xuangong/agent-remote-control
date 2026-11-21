// E13b, the device's storage across a phone's page lifecycle (gap 7 of the requirements review), driven by the browser lifecycle simulator on
// the real stack: the device store keeps a conversation whose page goes away 0, 50 or 200 ms after its first page (the M1 finding: WebKit
// aborts an IndexedDB write that a leaving page starts); a conversation whose stored copy the browser evicted opens from the journal; and the
// installed app asks to keep its storage and comes back from the home screen after the operating system ended it with a message waiting.
// `E2E_BROWSER=webkit` runs them in WebKit.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { evictStorage } from '@orchardworks/agent-e2e/lifecycle';
import { launchBrowser, openPage, openPageIn, type PageOptions } from './browser.js';
import { composerOf, send, showsText, waitForKeptConversation } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  const opened = (title: string) => ({ title, history: [{ role: 'user' as const, text: 'Start' }, { role: 'assistant' as const, text: `${title} is ready` }] });
  stack = await startStack({ providerId: 'codex', displayName: 'Codex CLI', sessions: { kept: opened('Kept'), evicted: opened('Evicted'), installed: opened('Installed') } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const phone: PageOptions = { viewport: { width: 390, height: 844 }, mobile: true };
/** A row of the conversation shows `text`; an assistant's preview elsewhere on the page does not count. */
const showsRow = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => [...document.querySelectorAll('.agent-timeline-entry')].some(row => (row.textContent ?? '').includes(needle)), text, { timeout });

/** Records, from before the first paint of every later page of `context`, how many conversation rows each of its frames shows. */
async function watchRowFrames(context: BrowserContext): Promise<{ afterFirstRows(page: Page): Promise<number[]> }> {
  await context.addInitScript(() => {
    const counts: number[] = [];
    (window as unknown as { __rowFrames: number[] }).__rowFrames = counts;
    const look = () => { const rows = document.querySelectorAll('.agent-timeline-entry').length; if (counts.at(-1) !== rows) counts.push(rows); };
    new MutationObserver(look).observe(document, { subtree: true, childList: true });
  });
  return { afterFirstRows: async page => { const counts = await page.evaluate(() => (window as unknown as { __rowFrames: number[] }).__rowFrames); return counts.slice(counts.findIndex(count => count > 0)); } };
}

it('E13b: the device store keeps a conversation whose page goes away 0, 50 and 200 ms after its first page, so it opens from the device next time', async () => {
  for (const afterMs of [0, 50, 200]) {
    const { context, page, sockets, lifecycle } = await openPage(browser, stack.sessionUrl('kept'), { ...phone, hold: true, lifecycle: true });
    await composerOf(page).waitFor();
    // The page's timers stop before the Relay's first page is let through, so no timer writes for it. The page then leaves `afterMs` of
    // real time after showing its rows, while its write may still be on its way: WebKit aborts what a leaving page has not committed.
    await lifecycle.pauseTime();
    sockets.release();
    await showsRow(page, 'Kept is ready');
    if (afterMs) await page.waitForTimeout(afterMs);
    await page.close();
    const { page: back, sockets: held } = await openPageIn(context, stack.sessionUrl('kept'), { hold: true });
    // The Relay's page is held back: a row of the conversation can only come from the device store.
    await showsRow(back, 'Kept is ready', 10_000).catch(() => { throw new Error(`The conversation left ${afterMs} ms after its first page did not open from the device store.`); });
    held.release();
    await context.close();
  }
});

it('E13b: a conversation whose stored copy the browser evicted opens from the journal, with no connection word and no frame that loses its rows', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('evicted'), phone);
  await showsText(page, 'Evicted is ready');
  await waitForKeptConversation(page, 'Evicted is ready');
  await page.close();
  await evictStorage(context, stack.origin);
  const frames = await watchRowFrames(context);
  const { page: back, sockets, words } = await openPageIn(context, stack.sessionUrl('evicted'), { hold: true });
  // Nothing is on the device: while the Relay's page is held back the conversation shows no row.
  await composerOf(back).waitFor();
  expect(await back.locator('.agent-timeline-entry').count()).toBe(0);
  sockets.release();
  await showsRow(back, 'Evicted is ready');
  expect((await frames.afterFirstRows(back)).every(count => count > 0)).toBe(true);
  expect(await words.seen()).toEqual([]);
  await context.close();
});

it('E13b: the installed app asks to keep its storage, and after the operating system ended it with a message waiting it opens from the home screen with the conversation and delivers the message once', async () => {
  const installed: PageOptions = { ...phone, lifecycle: { standalone: true } };
  const { context, page, lifecycle } = await openPage(browser, stack.sessionUrl('installed'), installed);
  await showsText(page, 'Installed is ready');
  expect(await lifecycle.persistRequests()).toBe(1);
  await waitForKeptConversation(page, 'Installed is ready');
  await stack.stopController();
  try {
    await send(page, 'Sent from the home screen');
    await page.waitForFunction(() => [...document.querySelectorAll('.agent-outgoing-message')].some(node => /Sent from the home screen[\s\S]*Waiting for E2E Host/.test(node.textContent ?? '')));
    await lifecycle.kill();
    // The home screen opens the app at its start URL, on the list of assistants: this person's one assistant says its computer is away.
    const { page: again, lifecycle: relaunched } = await openPageIn(context, stack.origin + '/', installed);
    expect(await relaunched.persistRequests()).toBe(1);
    await again.locator('[data-bot-place]', { hasText: 'E2E Host is offline' }).click();
    await showsRow(again, 'Installed is ready');
    await again.waitForFunction(() => [...document.querySelectorAll('.agent-outgoing-message')].some(node => /Sent from the home screen/.test(node.textContent ?? '')));
    await stack.startController();
    await showsText(again, 'Echo: Sent from the home screen');
    await expect.poll(() => again.locator('.agent-outgoing-message', { hasText: 'Sent from the home screen' }).count()).toBe(0);
    expect(await again.locator('.agent-message-user', { hasText: 'Sent from the home screen' }).count()).toBe(1);
    expect(stack.provider.session('installed')!.sent.filter(text => text === 'Sent from the home screen')).toHaveLength(1);
  } finally { await stack.startController().catch(() => undefined); await context.close(); }
});
