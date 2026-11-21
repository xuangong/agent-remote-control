// E6 across computers: a group of bots whose sessions live on two Hosts. Each send reaches the Host of its own bot, and the replies and
// the drafts stay with their bots. (Its own stack: the Relay limits a user's control requests per minute, which the file of E6 uses up.)
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { goTo, pairSecondHost, showSidebar, showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ sessions: { alpha: { title: 'Alpha', history: [{ role: 'user', text: 'AAA' }, { role: 'assistant', text: 'alpha answer' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const assistantOf = (page: Page, answer: string) => page.locator('.lab-session-family-pane').filter({ hasText: answer }).locator('.lab-tile-name').first().innerText();
const bot = (page: Page) => page.locator('[data-workbench-mode="bot"]');
const botRow = (page: Page, name: string) => bot(page).getByRole('button', { name, exact: true }).first();
/** The composer of the bot on screen in Bot mode; Window mode keeps its own, hidden. */
const botComposer = (page: Page) => bot(page).getByRole('textbox', { name: 'Message', exact: true }).locator('visible=true');
async function botSend(page: Page, text: string): Promise<void> {
  await botComposer(page).click();
  await page.keyboard.type(text);
  await bot(page).getByTestId('prompt-submit').locator('visible=true').click();
}

it('E6: a group holds bots of two computers; each send reaches its own computer, and replies and drafts stay apart', async () => {
  const second = await pairSecondHost(stack, { name: 'Second Host', installationId: 'e2e-e6-second', sessions: { gamma: { title: 'Gamma', history: [{ role: 'user', text: 'GGG' }, { role: 'assistant', text: 'gamma answer' }] } } });
  try {
    const { context, page } = await openPage(browser, stack.sessionUrl('alpha'));
    await showsText(page, 'alpha answer');
    const rail = await showSidebar(page);
    await rail.getByRole('button', { name: 'New session view' }).first().click();
    await page.getByRole('button', { name: 'Choose session' }).first().click();
    await page.getByLabel('Connected Host').selectOption(second.hostId);
    await page.locator('#lab-sessions-page').getByText('Gamma', { exact: true }).first().click();
    await showsText(page, 'gamma answer');
    const alpha = await assistantOf(page, 'alpha answer'), gamma = await assistantOf(page, 'gamma answer');
    await goTo(page, 'Chats');
    await botRow(page, alpha).click();
    await botSend(page, 'For the first computer');
    await showsText(page, 'Echo: For the first computer');
    await botComposer(page).fill('A draft for the first computer');
    await goTo(page, 'Chats');
    await botRow(page, gamma).click();
    await showsText(page, 'gamma answer');
    expect(await botComposer(page).textContent()).toBe('');
    await botSend(page, 'For the second computer');
    await showsText(page, 'Echo: For the second computer');
    expect(stack.provider.session('alpha')!.sent).toEqual(['For the first computer']);
    expect(second.provider.session('gamma')!.sent).toEqual(['For the second computer']);
    await goTo(page, 'Chats');
    await botRow(page, alpha).click();
    await showsText(page, 'Echo: For the first computer');
    expect(await botComposer(page).textContent()).toBe('A draft for the first computer');
    await context.close();
  } finally { await second.close(); }
});
