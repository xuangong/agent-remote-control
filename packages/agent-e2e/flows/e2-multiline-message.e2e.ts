// E2 (multi-line): a message written over several lines keeps its blank line and line break from the editor, through the Relay and the Controller, to the
// delivered row.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { showsText, waitForEntries } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ stream: true, replyDelayMs: 700, sessions: { welcome: { title: 'Welcome', history: [{ role: 'user', text: 'Hello there' }, { role: 'assistant', text: 'Hello, how can I help?' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E2: a multi-line message keeps its blank line and line break from the editor to the delivered row, and focus returns to an empty editor', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  const input = page.locator('[data-testid="prompt-input"]');
  await input.click();
  await page.keyboard.type('Help me improve this.');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Keep the **shared components**,');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('and show the protocol.');
  await page.locator('[data-testid="prompt-submit"]').click();
  await showsText(page, 'Echo: Help me improve this.');
  const sent = 'Help me improve this.\n\nKeep the **shared components**,\nand show the protocol.';
  expect(stack.provider.session('welcome')!.sent).toContain(sent);
  const row = page.locator('.agent-message-user', { hasText: 'Help me improve this.' });
  expect(await row.count()).toBe(1);
  expect(await row.locator('p').evaluateAll(nodes => nodes.map(node => node.textContent))).toEqual(['Help me improve this.', 'Keep the shared components,\nand show the protocol.']);
  expect(await row.locator('p br').count()).toBe(1);
  expect(await row.locator('p strong').textContent()).toBe('shared components');
  expect(await input.textContent()).toBe('');
  expect(await input.evaluate(node => node === document.activeElement)).toBe(true);
  await context.close();
});
