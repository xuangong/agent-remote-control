// E15c, one approval per chain and folder (bots plan 9d): the real page, Relay and Controller, with scripted sessions that ask for an
// approval. The person allows a command for a chain in a folder once; a bot of the same chain asking the same is answered at once, another
// chain is asked about, and the audit lists what was allowed and takes it back.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { hasTools as hasToolsOf, team as teamOf } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';
import { holdsText, showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, tools: true,
    turns: text => text.includes('Run the chief check.') ? [{ approval: 'Run the check', command: 'npm run check' }, { reply: 'Chief check passed.' }]
      : text.includes('Run the second tracker check.') ? [{ approval: 'Run the check', command: 'npm run check' }, { reply: 'Second tracker check passed.' }]
      : text.includes('Run the tracker check.') ? [{ approval: 'Run the check', command: 'npm run check' }, { reply: 'Tracker check passed.' }] : undefined,
    sessions: {
      chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
      tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] },
    } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

async function typeInto(page: Page, bot: string, text: string): Promise<void> {
  const composer = page.locator(`[data-testid="prompt-input"][data-placeholder^="Message ${bot}"]`);
  await composer.click();
  await page.keyboard.type(text);
  await page.waitForFunction(({ bot, text }) => {
    const input = document.querySelector(`[data-testid="prompt-input"][data-placeholder^="Message ${bot}"]`);
    const send = input?.closest('.agent-composer')?.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]');
    return input?.textContent?.includes(text) === true && send?.disabled === false;
  }, { bot, text });
  await page.keyboard.press('Enter');
}

it('E15c: allowing a command for the chain in this folder answers the same command of another bot of the chain, not another chain\'s, and the audit takes it back', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await teamOf(stack, context);
  await page.locator('[data-testid="prompt-input"][data-placeholder^="Message Tracker"]').waitFor();
  await hasToolsOf(stack, 'chief'); await hasToolsOf(stack, 'tracker');
  const cards = page.locator('.agent-tool-approval');

  // Chief asks; the person allows it for this chain in this folder.
  await typeInto(page, 'Chief', 'Run the chief check.');
  await cards.first().waitFor({ timeout: 20_000 });
  await cards.first().getByRole('button', { name: 'Allow for this chain in this folder', exact: true }).click();
  await showsText(page, 'Chief check passed.');

  // Chief hands Tracker work in the same chain; Tracker asks for the same command in the same folder and is answered without the person.
  await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Run the tracker check.' });
  await holdsText(page, 'Tracker check passed.');
  expect(await cards.count()).toBe(0);

  // The person's own input to Tracker is another chain: its approval waits for the person.
  await typeInto(page, 'Tracker', 'Run the second tracker check.');
  await cards.first().waitFor({ timeout: 20_000 });
  expect(await page.evaluate(() => document.body.textContent?.includes('Second tracker check passed.'))).toBe(false);
  expect(await cards.first().getByRole('button', { name: 'Allow for this chain in this folder', exact: true }).count()).toBe(1);
  await cards.first().getByRole('button', { name: 'Allow', exact: true }).click();
  await holdsText(page, 'Second tracker check passed.');

  // The audit lists what was allowed, how many times it applied, and revokes it.
  await page.goto(stack.origin + '/?page=settings&group=assistants');
  const rows = page.locator('.lab-bot-audit > ul > li');
  await rows.first().waitFor({ timeout: 20_000 });
  for (const toggle of await page.locator('.lab-bot-audit .lab-assistant-session-toggle').all()) await toggle.click();
  const approvals = page.locator('.lab-bot-audit-approvals');
  await expect.poll(() => approvals.count(), { timeout: 20_000 }).toBe(1);
  expect(await approvals.innerText()).toContain('command in');
  expect(await approvals.innerText()).toContain('applied 1 time');
  await approvals.getByRole('button', { name: 'Ask me again', exact: true }).click();
  await expect.poll(() => approvals.count(), { timeout: 20_000 }).toBe(0);
  await context.close();
});
