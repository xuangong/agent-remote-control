// E6 of the target architecture: a group of sessions built in a Window, the Bot and Window modes over the same sessions, folding and waking a
// pane, and a draft that stays in the composer when the person changes mode.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { composerOf, showSidebar, showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ sessions: {
    alpha: { title: 'Alpha', history: [{ role: 'user', text: 'AAA' }, { role: 'assistant', text: 'alpha answer' }] },
    beta: { title: 'Beta', history: [{ role: 'user', text: 'BBB' }, { role: 'assistant', text: 'beta answer' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

/** Alpha open, and Beta added to the same Window from All sessions. */
async function groupOfTwo(): Promise<{ page: Page; close(): Promise<void> }> {
  const { context, page } = await openPage(browser, stack.sessionUrl('alpha'));
  await showsText(page, 'alpha answer');
  const rail = await showSidebar(page);
  await rail.getByRole('button', { name: 'New session view' }).first().click();
  await page.getByRole('button', { name: 'Choose session' }).first().click();
  await page.locator('#lab-sessions-page').getByText('Beta', { exact: true }).first().click();
  await showsText(page, 'beta answer');
  return { page, close: () => context.close() };
}

it('E6: a group is built by adding a second session to the Window', async () => {
  const { page, close } = await groupOfTwo();
  await showsText(page, 'alpha answer');
  expect(await page.locator('#lab-context').getByText('2 bots').count()).toBeGreaterThan(0);
  await close();
});

it('E6: Bot mode lists the group, opens one bot, and Window mode shows both panes again', async () => {
  const { page, close } = await groupOfTwo();
  await page.getByRole('button', { name: 'Bot mode' }).first().click();
  await page.getByRole('button', { name: /^Beta/ }).first().click();
  await showsText(page, 'beta answer');
  await page.getByRole('button', { name: 'Window mode' }).first().click();
  await showsText(page, 'alpha answer');
  await showsText(page, 'beta answer');
  await close();
});

it('E6: a folded pane gives up its rows and the other pane stays', async () => {
  const { page, close } = await groupOfTwo();
  await page.getByRole('button', { name: 'Minimize primary group: Alpha' }).first().click();
  await page.waitForFunction(() => !document.body.innerText.includes('alpha answer'));
  await showsText(page, 'beta answer');
  await close();
});

it('E6: a draft stays in the composer when the person changes mode', async () => {
  const { page, close } = await groupOfTwo();
  await composerOf(page).first().fill('A draft that is not sent');
  await page.getByRole('button', { name: 'Bot mode' }).first().click();
  await page.getByRole('button', { name: /^Alpha/ }).first().click();
  await showsText(page, 'alpha answer');
  await page.getByRole('button', { name: 'Window mode' }).first().click();
  await showsText(page, 'alpha answer');
  const texts = await page.getByRole('textbox', { name: 'Message', exact: true }).allTextContents();
  expect(texts).toContain('A draft that is not sent');
  await close();
});

it('E6: a bot put to sleep gives up its rows in Window mode, and opening it wakes it', async () => {
  const { page, close } = await groupOfTwo();
  await page.getByRole('button', { name: 'Bot mode' }).first().click();
  await page.getByRole('button', { name: /^Beta/ }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Sleep' }).click();
  await showsText(page, 'is asleep. Opening it wakes it.');
  await page.getByRole('button', { name: 'Window mode' }).first().click();
  await showsText(page, 'alpha answer');
  await page.waitForFunction(() => !document.body.innerText.includes('beta answer'));
  await page.getByRole('button', { name: 'Bot mode' }).first().click();
  await page.getByRole('button', { name: /^Beta/ }).first().click();
  await showsText(page, 'beta answer');
  await page.getByRole('button', { name: 'Window mode' }).first().click();
  await showsText(page, 'alpha answer');
  await showsText(page, 'beta answer');
  await close();
});
