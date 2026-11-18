// E1 and E2 of the target architecture: read a paired Host's session, send, and see the reply; a reload shows the same rows.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, rowTexts } from './browser.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ sessions: { 'welcome': { title: 'Welcome', history: [{ role: 'user', text: 'Hello there' }, { role: 'assistant', text: 'Hello, how can I help?' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E1: a paired Controller shows its session with the rows of its history', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await page.waitForFunction(() => document.querySelectorAll('.agent-timeline-entry').length >= 2);
  expect(await rowTexts(page)).toEqual([expect.stringContaining('Hello there'), expect.stringContaining('Hello, how can I help?')]);
  await context.close();
});

it('E2: a sent message is answered, and a reload shows the same conversation', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await page.waitForFunction(() => document.querySelectorAll('.agent-timeline-entry').length >= 2);
  await page.locator('[data-testid="prompt-input"]').click();
  await page.keyboard.type('Please echo this');
  await page.locator('[data-testid="prompt-submit"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.agent-message-assistant')].some(node => (node.textContent ?? '').includes('Echo: Please echo this')));
  expect(stack.provider.session('welcome')!.sent).toEqual(['Please echo this']);
  const before = await rowTexts(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(count => document.querySelectorAll('.agent-timeline-entry').length >= count, before.length);
  expect(await rowTexts(page)).toEqual(before);
  await context.close();
});
