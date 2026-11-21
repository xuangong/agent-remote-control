// E6 of the target architecture: a group of sessions built in a Window, the Bot and Window modes over the same sessions, folding and waking a
// pane, and a draft that stays in the composer when the person changes mode.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn } from './browser.js';
import { composerOf, goTo, showSidebar, showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ sessions: {
    alpha: { title: 'Alpha', history: [{ role: 'user', text: 'AAA' }, { role: 'assistant', text: 'alpha answer' }] },
    beta: { title: 'Beta', history: [{ role: 'user', text: 'BBB' }, { role: 'assistant', text: 'beta answer' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

/** The name the assistant of a conversation is called by: its tile's in Window mode, which its row in Bot mode shows too. */
const assistantOf = (page: Page, answer: string) => page.locator('.lab-session-family-pane').filter({ hasText: answer }).locator('.lab-tile-name').first().innerText();
const botRow = (page: Page, name: string) => page.locator('[data-workbench-mode="bot"]').getByRole('button', { name, exact: true }).first();

/** Alpha open, and Beta added to the same Window from All sessions. */
async function groupOfTwo(): Promise<{ context: BrowserContext; page: Page; close(): Promise<void> }> {
  const { context, page } = await openPage(browser, stack.sessionUrl('alpha'));
  await showsText(page, 'alpha answer');
  const rail = await showSidebar(page);
  await rail.getByRole('button', { name: 'New session view' }).first().click();
  await page.getByRole('button', { name: 'Choose session' }).first().click();
  await page.locator('#lab-sessions-page').getByText('Beta', { exact: true }).first().click();
  await showsText(page, 'beta answer');
  return { context, page, close: () => context.close() };
}

it('E6: a group is built by adding a second session to the Window', async () => {
  const { page, close } = await groupOfTwo();
  await showsText(page, 'alpha answer');
  expect(await page.locator('#lab-context').getByText('2 bots').count()).toBeGreaterThan(0);
  await close();
});

it('E6: Bot mode lists the group, opens one bot, and Window mode shows both panes again', async () => {
  const { page, close } = await groupOfTwo();
  const beta = await assistantOf(page, 'beta answer');
  await goTo(page, 'Chats');
  await botRow(page, beta).click();
  await showsText(page, 'beta answer');
  await goTo(page, 'Windows');
  await showsText(page, 'alpha answer');
  await showsText(page, 'beta answer');
  await close();
});

it('E6: a folded pane gives up its rows and the other pane stays, on a second page of the same Window too', async () => {
  const { context, page, close } = await groupOfTwo();
  // A second page on the Window's address shows the same group, and the fold made on the first reaches it.
  const { page: other } = await openPageIn(context, page.url());
  await showsText(other, 'alpha answer');
  await showsText(other, 'beta answer');
  await page.getByRole('button', { name: 'Minimize primary group: Alpha' }).first().click();
  await page.waitForFunction(() => !document.body.innerText.includes('alpha answer'));
  await showsText(page, 'beta answer');
  await other.waitForFunction(() => !document.body.innerText.includes('alpha answer'));
  await showsText(other, 'beta answer');
  await close();
});

it('E6: a draft stays in the composer when the person changes mode', async () => {
  const { page, close } = await groupOfTwo();
  await composerOf(page).first().fill('A draft that is not sent');
  const alpha = await assistantOf(page, 'alpha answer');
  await goTo(page, 'Chats');
  await botRow(page, alpha).click();
  await showsText(page, 'alpha answer');
  await goTo(page, 'Windows');
  await showsText(page, 'alpha answer');
  const texts = await page.getByRole('textbox', { name: 'Message', exact: true }).allTextContents();
  expect(texts).toContain('A draft that is not sent');
  await close();
});

it('E6: a bot put to sleep gives up its rows in Window mode, and opening it wakes it', async () => {
  const { page, close } = await groupOfTwo();
  const beta = await assistantOf(page, 'beta answer');
  await goTo(page, 'Chats');
  // Sleep is in the bot's card menu, in its details beside the conversation (I3c).
  await botRow(page, beta).click();
  const title = page.locator('[data-workbench-mode="bot"] .lab-assistant-top-bar button.lab-assistant-title');
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click();
  await page.locator('.lab-assistant-details .lab-assistant-card-actions').getByRole('button', { name: /^More actions for / }).click();
  await page.getByRole('menuitem', { name: 'Sleep', exact: true }).click();
  await showsText(page, 'is asleep. Opening it wakes it.');
  await goTo(page, 'Windows');
  await showsText(page, 'alpha answer');
  await page.waitForFunction(() => !document.body.innerText.includes('beta answer'));
  await goTo(page, 'Chats');
  await botRow(page, beta).click();
  await showsText(page, 'beta answer');
  await goTo(page, 'Windows');
  await showsText(page, 'alpha answer');
  await showsText(page, 'beta answer');
  await close();
});
