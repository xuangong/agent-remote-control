// E10 of the I3 plan: the assistant's conversation on the real stack. A person sends a message; the live line says what the assistant is
// doing while its tool runs; it asks inline and the person allows it; the turn's work folds into one line that opens to the command; Full
// shows every step at preview level and the step opens to its output. No frame shows a per-session connection word (target T5). Desktop
// and a phone viewport; `E2E_BROWSER=webkit` runs both in WebKit.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type ScriptedStep, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, type PageOptions } from './browser.js';
import { chooseProcessMode, send, showsText, waitForEntries } from './page.js';

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
      await expect.poll(() => live.textContent(), { timeout: 15_000 }).toBe('Chief is running tests');
      // The assistant asks inline, in its turn, with plain choices.
      const card = page.locator('.agent-turn').last().locator('.agent-turn-requests .agent-tool-approval');
      await card.waitFor({ timeout: 15_000 });
      await expect.poll(() => card.locator('.orchard-approval-prompt').textContent()).toBe('Chief wants to run a command');
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
});
