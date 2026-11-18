// E3 and E4 of the target architecture (the main ones): the page recovers when the Controller or the Relay restarts, and rows a
// terminal writes while the page is open appear in it.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, rowTexts } from './browser.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ sessions: { 'work': { title: 'Work', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Started' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const showsText = (page: Page, text: string) => page.waitForFunction(needle => document.body.innerText.includes(needle), text, { timeout: 25_000 });
async function send(page: Page, text: string) {
  await page.locator('[data-testid="prompt-input"]').click();
  await page.keyboard.type(text);
  await page.locator('[data-testid="prompt-submit"]').click();
}

it('E3: the page recovers after the Controller stops and starts again, and a send is answered', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  await stack.stopController();
  await stack.startController();
  await send(page, 'after controller restart');
  await showsText(page, 'Echo: after controller restart');
  await context.close();
});

it('E3: the page recovers after the Relay restarts and keeps its rows', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  const before = await rowTexts(page);
  await stack.restartRelay();
  await showsText(page, 'Started');
  await send(page, 'after relay restart');
  await showsText(page, 'Echo: after relay restart');
  expect((await rowTexts(page)).slice(0, before.length)).toEqual(before);
  await context.close();
});

it('E4: a row written by a terminal while the page is open appears without a send', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  stack.provider.session('work')!.write('assistant', 'Written from the terminal');
  await showsText(page, 'Written from the terminal');
  await context.close();
});
