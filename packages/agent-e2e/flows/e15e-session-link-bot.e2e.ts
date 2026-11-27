// E15e, a session a coding agent already wrote becomes a bot through a link made in its directory (`session link --here --bot`).
// The command line picks the session by the directory it runs in; the page asks once before it changes anything, says so when a terminal
// still holds the session, and then shows the bot with the conversation the session already had.
import type { Browser } from '@playwright/test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeEach(async () => {
  stack = await startStack({ tools: true, sessions: {
    reuse: { title: 'Reuse test', history: [{ role: 'user', text: 'Keep the notes.' }, { role: 'assistant', text: 'The notes are kept.' }] },
  } });
  browser = await launchBrowser();
});
afterEach(async () => { await browser?.close(); await stack?.close(); });

const link = async (...options: string[]) => {
  const made = await stack.sessionCommand(['link', '--here', '--provider', stack.provider.providerId, ...options]);
  expect(made.code).toBe(0);
  return made.output.url as string;
};

it('E15e: the link made in the session’s directory asks once, then shows the bot with the conversation the session already had', async () => {
  const url = await link('--bot', 'Reused');
  expect(new URL(url).searchParams.get('as')).toBe('bot');
  const { context, page } = await openPage(browser, url);
  const dialog = page.getByRole('dialog', { name: 'Make a session a bot' });
  await dialog.getByRole('heading', { name: 'Make Reused a bot?' }).waitFor();
  // Nothing opened the session before the answer, and the address no longer names it.
  expect(stack.provider.session('reuse')).toBeUndefined();
  expect(new URL(page.url()).searchParams.has('as')).toBe(false);
  await dialog.getByRole('button', { name: 'Make bot' }).click();
  await showsText(page, 'The notes are kept.');
  expect(new URL(page.url()).searchParams.get('mode')).toBe('bot');
  expect(stack.provider.session('reuse')).toBeDefined();
  await dialog.waitFor({ state: 'hidden' });
  // A reload does not ask again, and the bot is still there with its history.
  await page.reload();
  await showsText(page, 'The notes are kept.');
  expect(await page.getByRole('dialog', { name: 'Make a session a bot' }).count()).toBe(0);
  await context.close();
});

it('E15e: a terminal that still holds the session is named, and taking it over makes the bot', async () => {
  await stack.provider.terminalTakes('reuse');
  const { context, page } = await openPage(browser, await link('--bot'));
  const dialog = page.getByRole('dialog', { name: 'Make a session a bot' });
  // Without a name the bot starts with the session's own title.
  await dialog.getByRole('heading', { name: /^Make .* a bot\?$/ }).waitFor();
  await dialog.getByRole('button', { name: 'Make bot' }).click();
  await dialog.getByRole('heading', { name: 'A terminal still has this session' }).waitFor();
  expect(await dialog.getByText('command line in a terminal still has this session open').count()).toBe(1);
  await dialog.getByRole('button', { name: 'Take over here' }).click();
  await showsText(page, 'The notes are kept.');
  expect(new URL(page.url()).searchParams.get('mode')).toBe('bot');
  await context.close();
});

it('E15e: cancelling the question opens nothing', async () => {
  const { context, page } = await openPage(browser, await link('--bot', 'Reused'));
  const dialog = page.getByRole('dialog', { name: 'Make a session a bot' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  expect(stack.provider.session('reuse')).toBeUndefined();
  expect(await page.evaluate(() => document.body.innerText.includes('The notes are kept.'))).toBe(false);
  await context.close();
});
