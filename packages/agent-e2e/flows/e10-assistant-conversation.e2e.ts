// E10 of the I3 plan: the assistant's conversation on the real stack. A person sends a message; the live line says what the assistant is
// doing while its tool runs; it asks inline and the person allows it; the turn's work folds into one line that opens to the command; Full
// shows every step at preview level and the step opens to its output. No frame shows a per-session connection word (target T5). Desktop
// and a phone viewport; `E2E_BROWSER=webkit` runs both in WebKit.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type ScriptedStep, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn, type PageOptions } from './browser.js';
import { assistantDetails, chooseProcessMode, send, showsText, waitForEntries } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });

const PROMPT = 'Run the tests, then write notes.md';
/** The turn a prompt starts: a test run long enough to watch, an approval the person answers, and the answer. */
const turns = (text: string): ScriptedStep[] => text.includes('notes.md') ? [
  { tool: 'Bash', input: 'npm test', output: 'All 3 tests passed', ms: 2500 },
  { approval: 'Write notes.md?', command: 'write notes.md' },
  { reply: 'Wrote notes.md with three principles.' },
] : [];

const workLine = (page: Page) => page.locator('.agent-turn').last().locator('.agent-work-line > button');

const variants: Array<[string, PageOptions]> = [
  ['desktop 1280x800', { viewport: { width: 1280, height: 800 } }],
  ['phone 390x844', { viewport: { width: 390, height: 844 }, mobile: true }],
];

describe.each(variants)('E10 at %s', (_name, view) => {
  beforeAll(async () => {
    stack = await startStack({ turns, sessions: { chief: { title: 'Chief', history: [{ role: 'user', text: 'Hello Chief' }, { role: 'assistant', text: 'Hello, ready when you are.' }] } } });
  });
  afterAll(async () => { await stack?.close(); });

  it('E10: the live line, an inline approval, the one-line work summary that opens to the command, and Full, with no connection word', async () => {
    const { context, page, words } = await openPage(browser, stack.sessionUrl('chief'), view);
    try {
      await waitForEntries(page, 2);
      await send(page, PROMPT);
      // While the test command runs, one live line says so.
      const live = page.locator('.agent-turn-status [role="status"]');
      // The assistant is called by its name, never by its session's title (I3c): the name its tile shows.
      const name = await page.locator('.lab-tile-name:visible').first().innerText();
      expect(name).not.toBe('Chief');
      await expect.poll(() => live.textContent(), { timeout: 15_000 }).toBe(`${name} is running tests`);
      // The assistant asks inline, in its turn, with plain choices.
      const card = page.locator('.agent-turn').last().locator('.agent-turn-requests .agent-tool-approval');
      await card.waitFor({ timeout: 15_000 });
      await expect.poll(() => card.locator('.orchard-approval-prompt').textContent()).toBe(`${name} wants to run a command`);
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      await showsText(page, 'Wrote notes.md with three principles.');
      expect(stack.provider.session('chief')!.sent).toContain(PROMPT);
      // The answered approval stays as one line, and the turn's work as one grey line.
      await expect.poll(() => page.locator('.agent-receipt-toggle').filter({ hasText: 'Allowed once' }).count(), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(() => page.locator('.agent-turn-status').count()).toBe(0);
      await expect.poll(() => workLine(page).textContent()).toBe('Ran a command');
      expect(await workLine(page).getAttribute('aria-expanded')).toBe('false');
      // Opened, the line lists the command on one line.
      await workLine(page).click();
      const step = page.locator('.agent-work-steps .agent-tool').filter({ hasText: 'npm test' });
      await expect.poll(() => step.locator('.agent-tool-toggle').textContent()).toContain('npm test');
      expect(await step.locator('.agent-tool-preview').count()).toBe(0);
      // Full shows every step at preview level without the reader opening anything, and the step opens to its output.
      await chooseProcessMode(page, 'Full');
      await expect.poll(() => workLine(page).getAttribute('aria-expanded')).toBe('true');
      await expect.poll(() => step.locator('.agent-tool-preview').textContent()).toContain('npm test');
      await step.locator('.agent-tool-toggle').click();
      await expect.poll(() => step.locator('.agent-tool-details').textContent()).toContain('All 3 tests passed');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await words.seen()).toEqual([]);
    } finally { await context.close(); }
  });

  it('E10: Open in Bot mode, this assistant set to Process in its details for every device of the account, and Pin to a workbench, with no connection word', async () => {
    const { context, page, words } = await openPage(browser, stack.sessionUrl('chief'), view);
    try {
      await waitForEntries(page, 2);
      // From its tile, the assistant opens in Bot mode; its group gains a Bot section.
      await page.getByRole('button', { name: 'More session actions' }).first().click();
      await page.getByRole('button', { name: 'Open in Bot mode', exact: true }).first().click();
      const bot = page.locator('[data-workbench-mode="bot"]');
      await bot.locator('.lab-assistant-top-bar').waitFor();
      await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('bot');
      // It keeps the name its tile had, stored with its first edit; never its session's title.
      const botName = await bot.locator('.lab-assistant-top-bar .lab-assistant-name').innerText();
      expect(botName).not.toBe('Chief');
      // Its details: a panel beside the conversation, or a sheet from its name on a phone.
      const title = bot.locator('.lab-assistant-top-bar button.lab-assistant-title');
      if (await title.getAttribute('aria-expanded') !== 'true') await title.click();
      const assistantMode = () => assistantDetails(page).getByRole('group', { name: 'This assistant' });
      await assistantMode().getByRole('button', { name: 'Process', exact: true }).click();
      await expect.poll(() => assistantMode().getByRole('button', { name: 'Process', exact: true }).getAttribute('aria-pressed')).toBe('true');
      // The choice is the account's: it survives a reload and shows on another device.
      const address = page.url();
      await page.reload();
      await bot.locator('.lab-assistant-top-bar').waitFor();
      if (await title.getAttribute('aria-expanded') !== 'true') await title.click();
      await expect.poll(() => assistantMode().getByRole('button', { name: 'Process', exact: true }).getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true');
      const other = await browser.newContext({ viewport: view.viewport ?? { width: 1280, height: 800 }, ...(view.mobile ? { isMobile: true, hasTouch: true } : {}) });
      try {
        const second = await openPageIn(other, address, view);
        const secondTitle = second.page.locator('[data-workbench-mode="bot"] .lab-assistant-top-bar button.lab-assistant-title');
        await secondTitle.waitFor();
        if (await secondTitle.getAttribute('aria-expanded') !== 'true') await secondTitle.click();
        await expect.poll(() => assistantDetails(second.page).getByRole('group', { name: 'This assistant' }).getByRole('button', { name: 'Process', exact: true }).getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true');
        expect(await second.words.seen()).toEqual([]);
      } finally { await other.close(); }
      // Pin to a workbench shows its tile in Window mode, and Bot mode keeps the assistant for the way back.
      await assistantDetails(page).getByRole('button', { name: 'Pin to a workbench', exact: true }).click();
      await expect.poll(() => page.locator('[data-workbench-mode="window"]').getAttribute('hidden')).toBeNull();
      await page.getByRole('button', { name: /^Details of / }).first().waitFor();
      if (view.mobile) {
        // On a phone the assistant list is home: the address alone lands there, a conversation opens over it, and Back returns to it.
        await page.goto(new URL('/', page.url()).href);
        await bot.getByRole('navigation', { name: 'Chats' }).waitFor();
        await bot.locator('.lab-bot-row').filter({ hasText: botName }).first().click();
        await bot.locator('.lab-assistant-top-bar').waitFor();
        await page.goBack();
        await bot.getByRole('navigation', { name: 'Chats' }).waitFor();
      }
      expect(await words.seen()).toEqual([]);
    } finally { await context.close(); }
  });
});
