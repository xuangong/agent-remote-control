// E9 of the quiet-open plan: a message typed while a session is still opening shows as sending, is delivered once when the session is
// ready, and no frame of the page shows a per-session connection word (target T5). Run at a desktop and at a phone viewport.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn, type PageOptions } from './browser.js';
import { showsText, waitForEntries, waitForKeptConversation } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });

const input = (page: Page) => page.locator('[data-testid="prompt-input"]');

/** Types into the editor as soon as it takes text, and sends. */
async function typeAndSend(page: Page, text: string): Promise<void> {
  await input(page).waitFor({ state: 'visible' });
  await expect.poll(() => input(page).isEditable()).toBe(true);
  await input(page).click();
  await page.keyboard.type(text);
  // Return sends under a fine pointer; on a touch screen it makes a new line and the send button sends (I3b).
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await page.getByRole('button', { name: 'Send message', exact: true }).click();
  else await page.keyboard.press('Enter');
}

/** Types into the editor while the session is held back, and checks what a person sees until the session is ready. */
async function typeWhileOpening(page: Page, text: string): Promise<void> {
  await typeAndSend(page, text);
  await page.locator('[data-testid="pending-send"]', { hasText: 'Sending' }).waitFor();
  expect(stack.provider.session('quiet')!.sent).not.toContain(text);
  await page.keyboard.type(' next');
  await expect.poll(() => input(page).evaluate(node => (node as HTMLElement).innerText ?? node.textContent)).toContain('next');
  expect(await input(page).evaluate(node => node === document.activeElement || node.contains(document.activeElement))).toBe(true);
}

async function expectDeliveredOnce(page: Page, text: string): Promise<void> {
  await showsText(page, `Echo: ${text}`);
  await expect.poll(() => page.locator('[data-testid="pending-send"]').count()).toBe(0);
  expect(await page.locator('.agent-message-user', { hasText: text }).count()).toBe(1);
  expect(stack.provider.session('quiet')!.sent.filter(sent => sent === text)).toHaveLength(1);
}

const variants: Array<[string, PageOptions]> = [
  ['desktop', {}],
  ['phone 390x844', { viewport: { width: 390, height: 844 }, mobile: true }],
];

describe.each(variants)('E9 at %s', (_name, view) => {
  // Each viewport starts its own stack, so the second one does not find the first one's messages in the session.
  beforeAll(async () => {
    stack = await startStack({ stream: true, replyDelayMs: 300, sessions: { quiet: { title: 'Quiet', history: [{ role: 'user', text: 'Hello quiet' }, { role: 'assistant', text: 'Hello, how can I help?' }] } } });
  });
  afterAll(async () => { await stack?.close(); });

  it('E9: a message typed while a never-opened session opens shows as sending and is delivered once, with no connection word in any frame', async () => {
    const { context, page, sockets, words } = await openPage(browser, stack.sessionUrl('quiet'), { ...view, hold: 'agent_snapshot' });
    try {
      await typeWhileOpening(page, 'Typed while opening');
      sockets.release();
      await expectDeliveredOnce(page, 'Typed while opening');
      expect(await words.seen()).toEqual([]);
    } finally { await context.close(); }
  });

  it('E9: the same on a conversation this device has open, while the Relay\'s first page is held', async () => {
    const { context, page: first } = await openPage(browser, stack.sessionUrl('quiet'), view);
    try {
      await waitForEntries(first, 2);
      await waitForKeptConversation(first, 'Hello quiet');
      await first.close();
      const { page, sockets, words } = await openPageIn(context, stack.sessionUrl('quiet'), { ...view, hold: true });
      await waitForEntries(page, 2);
      await typeWhileOpening(page, 'Typed while reopening');
      sockets.release();
      await expectDeliveredOnce(page, 'Typed while reopening');
      expect(await words.seen()).toEqual([]);
    } finally { await context.close(); }
  });

  it('E9: a message sent at once while the Relay is slow to confirm and attach the session is delivered once, never held as Not sent', async () => {
    // Smoke M1's condition (O44): the Window's view of the session mounts while the page still confirms the session's locator and its
    // attach is still on its way. Both are waits, however long; the message is delivered once the session is ready.
    const { context, page: first } = await openPage(browser, stack.sessionUrl('quiet'), view);
    try {
      await waitForEntries(first, 2);
      await waitForKeptConversation(first, 'Hello quiet');
      await first.close();
      const { page, words } = await openPageIn(context, stack.sessionUrl('quiet'), { ...view, relayDelay: { requests: /\/v1\/(session-successions|remote\/.*attach)/, ms: 2000 } });
      await waitForEntries(page, 2);
      await typeAndSend(page, 'Sent at once to a slow Relay');
      await page.locator('[data-testid="pending-send"]', { hasText: 'Sending' }).waitFor();
      await expectDeliveredOnce(page, 'Sent at once to a slow Relay');
      expect(await page.getByText('Not sent').count()).toBe(0);
      expect(await words.seen()).toEqual([]);
    } finally { await context.close(); }
  });
});
