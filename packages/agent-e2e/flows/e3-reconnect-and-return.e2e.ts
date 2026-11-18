// E3 of the target architecture: the page and the Host come back after a socket drop, a Controller restart and a Relay restart; a reload
// paints from the device store before any frame arrives and then catches up; a journal replacement keeps the reader's place (the S4
// reading-anchor finding); older history loads when the reader reaches the top (the Codex older-history finding).
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn, rowTexts } from './browser.js';
import { numberedHistory, rowOffset, send, showsText, timelineScroll, waitForEntries, waitForKeptConversation } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({
    providerId: 'codex', displayName: 'Codex CLI',
    sessions: {
      work: { title: 'Work', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Started' }] },
      long: { title: 'Long', history: numberedHistory(40) },
      replaced: { title: 'Replaced', history: numberedHistory(60, ' ' + 'padding '.repeat(40)) },
      older: { title: 'Older', history: numberedHistory(300, ' ' + 'padding '.repeat(60)) },
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E3: the page recovers from a dropped connection and a send is answered', async () => {
  const { context, page, sockets } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  expect(await sockets.drop()).toBeGreaterThan(0);
  await send(page, 'after the drop');
  await showsText(page, 'Echo: after the drop');
  await context.close();
});

it('E3: the page recovers after the Controller and then the Relay restart, and keeps its rows', async () => {
  const { context, page, sockets } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  const before = await rowTexts(page);
  await stack.stopController();
  await stack.startController();
  await send(page, 'after controller restart');
  await showsText(page, 'Echo: after controller restart');
  await sockets.recoveredFrom(() => stack.restartRelay());
  await send(page, 'after relay restart');
  await showsText(page, 'Echo: after relay restart');
  expect((await rowTexts(page)).slice(0, before.length)).toEqual(before);
  await context.close();
});

it('E3: a reload paints the conversation from the device store before any frame arrives, then catches up', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Started');
  await waitForKeptConversation(page, 'Started');
  await page.close();
  stack.provider.session('work')!.write('assistant', 'Written while the page was away');
  const { page: returning, sockets } = await openPageIn(context, stack.sessionUrl('work'), { hold: true });
  // The Relay's timeline page is held back, so everything the page shows came from the device.
  await showsText(returning, 'Started');
  expect(await returning.evaluate(() => document.body.innerText.includes('Written while the page was away'))).toBe(false);
  sockets.release();
  await showsText(returning, 'Written while the page was away');
  await context.close();
});

it('E3: older history of a long Codex conversation loads when the reader wheels to the top', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('older'));
  await waitForEntries(page, 10);
  await page.waitForFunction(() => document.body.innerText.includes('Row 300 '));
  const loaded = async () => (await rowTexts(page)).length;
  const initial = await loaded();
  expect(initial).toBeLessThan(300);
  expect((await rowTexts(page)).some(text => text.includes('Row 1 padding'))).toBe(false);
  // The first rows are older than the window the Relay serves. Only a wheel at the top asks for them.
  await timelineScroll(page).hover();
  await expect.poll(async () => {
    await page.mouse.wheel(0, -6000);
    return (await rowTexts(page)).some(text => text.includes('Row 1 padding'));
  }, { timeout: 25_000, interval: 300 }).toBe(true);
  expect(await loaded()).toBeGreaterThan(initial);
  await context.close();
});

it('E3: the reader keeps their line when a row arrives and when the connection drops and returns', async () => {
  const { context, page, sockets } = await openPage(browser, stack.sessionUrl('replaced'));
  await page.waitForFunction(() => document.body.innerText.includes('Row 60 '));
  await timelineScroll(page).hover();
  // Read upwards until Row 30 is in view, and take it as the place to keep.
  await expect.poll(async () => { await page.mouse.wheel(0, -250); const offset = await rowOffset(page, 'Row 30 padding'); return offset !== undefined && offset > 100 && offset < 500; }, { timeout: 20_000, interval: 100 }).toBe(true);
  await page.waitForTimeout(300);
  const before = (await rowOffset(page, 'Row 30 padding'))!;
  const running = stack.provider.session('replaced');
  expect(running).toBeDefined();
  running!.write('assistant', 'Row 61 arrived while reading');
  await page.waitForFunction(() => document.body.innerText.includes('Row 61 arrived while reading'));
  expect(Math.abs((await rowOffset(page, 'Row 30 padding'))! - before)).toBeLessThanOrEqual(2);
  await sockets.recoveredFrom(async () => { await sockets.drop(); });
  running!.write('assistant', 'Row 62 arrived after the drop');
  await page.waitForFunction(() => document.body.innerText.includes('Row 62 arrived after the drop'));
  expect(Math.abs((await rowOffset(page, 'Row 30 padding'))! - before)).toBeLessThanOrEqual(2);
  await context.close();
});
