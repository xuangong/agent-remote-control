// E2 of the target architecture: a sent message is pending, then delivered; the reply streams in; a reload shows the same conversation;
// a message sent while the Controller is away is queued and delivered once it returns, exactly once.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, rowTexts } from './browser.js';
import { send, showsText, waitForEntries } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ stream: true, replyDelayMs: 700, sessions: { welcome: { title: 'Welcome', history: [{ role: 'user', text: 'Hello there' }, { role: 'assistant', text: 'Hello, how can I help?' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const userRows = (page: import('@playwright/test').Page, text: string) => page.locator('.agent-message-user', { hasText: text });

it('E2: a message shows as pending until the Controller takes it, then as one delivered row', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  const release = stack.provider.hold();
  try {
    await send(page, 'Hold this one');
    await page.waitForFunction(() => [...document.querySelectorAll('.agent-outgoing-message')].some(node => /Hold this one.*Sending/.test(node.textContent ?? '')));
  } finally { release(); }
  await expect.poll(() => page.locator('.agent-outgoing-message').count()).toBe(0);
  await showsText(page, 'Echo: Hold this one');
  expect(await userRows(page, 'Hold this one').count()).toBe(1);
  expect(stack.provider.session('welcome')!.sent.filter(text => text === 'Hold this one')).toHaveLength(1);
  await context.close();
});

it('E2: the reply streams into one row that the page shows in pieces', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  await send(page, 'Stream please');
  const full = 'Echo: Stream please';
  const first = full.slice(0, Math.ceil(full.length / 2));
  await page.waitForFunction(({ first, full }) => {
    const last = [...document.querySelectorAll('.agent-message-assistant')].at(-1)?.textContent ?? '';
    return last.includes(first) && !last.includes(full);
  }, { first, full });
  await showsText(page, full);
  expect(await page.locator('.agent-message-assistant', { hasText: full }).count()).toBe(1);
  await context.close();
});

it('E2: a reload shows the same conversation', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  await send(page, 'Before reload');
  await showsText(page, 'Echo: Before reload');
  const before = await rowTexts(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(count => document.querySelectorAll('.agent-timeline-entry').length >= count, before.length);
  expect(await rowTexts(page)).toEqual(before);
  await context.close();
});

it('E2: a message sent while the Controller is away is queued, then delivered once', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  await stack.stopController();
  await send(page, 'Sent while away');
  await page.waitForFunction(() => [...document.querySelectorAll('.agent-outgoing-message')].some(node => /Sent while away.*Waiting for E2E Host/.test(node.textContent ?? '')));
  expect(stack.provider.session('welcome')!.sent).not.toContain('Sent while away');
  await stack.startController();
  await showsText(page, 'Echo: Sent while away');
  await expect.poll(() => page.locator('.agent-outgoing-message').count()).toBe(0);
  expect(await userRows(page, 'Sent while away').count()).toBe(1);
  expect(stack.provider.session('welcome')!.sent.filter(text => text === 'Sent while away')).toHaveLength(1);
  await context.close();
});

// WebKit's offline emulation does not cut an open WebSocket, so the device never loses its connection there.
it.skipIf(process.env.E2E_BROWSER === 'webkit')('E2: a message typed while the device is offline waits, then is sent once when the device is back', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  // A phone wakes without a network: the page is shown again before its connections notice.
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await send(page, 'Typed offline');
  await page.waitForFunction(() => [...document.querySelectorAll('.agent-outgoing-message')].some(node => /Typed offline[\s\S]*Sending/.test(node.textContent ?? '')));
  expect(stack.provider.session('welcome')!.sent).not.toContain('Typed offline');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await showsText(page, 'Echo: Typed offline');
  await expect.poll(() => page.locator('.agent-outgoing-message').count()).toBe(0);
  expect(await userRows(page, 'Typed offline').count()).toBe(1);
  expect(stack.provider.session('welcome')!.sent.filter(text => text === 'Typed offline')).toHaveLength(1);
  await context.close();
});
