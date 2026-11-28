// E21, the goal of a session: the real page, Relay and Controller, with a scripted provider that has a `/goal` command as Claude Code and Codex do.
// The person sets a goal in the composer, the session's CLI checks it, and the pinned line follows each report; Pause, Resume and Clear goal send
// the adapter's own commands; a reload shows the goal again from what the session reports, and it is gone after Clear goal.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { goalButton, goalLine, send, waitForEntries } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ goals: true, sessions: { welcome: { title: 'Welcome', history: [{ role: 'user', text: 'Hello there' }, { role: 'assistant', text: 'Hello, how can I help?' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const goalOf = async () => (await stack.provider.session('welcome')!.runtimeInfo()).goal;

it('E21: a goal set in the composer is pinned above the conversation and follows the CLI\'s checks, Pause, Resume and a reload, until Clear goal', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  expect(await goalLine(page).count()).toBe(0);
  await send(page, '/goal all tests pass');
  await expect.poll(() => goalLine(page).textContent(), { timeout: 30_000 }).toContain('all tests pass');
  expect(await goalLine(page).textContent()).toContain('Working toward it');
  // The command is the CLI's: the person's words are no message to the model.
  expect(stack.provider.session('welcome')!.sent).toEqual([]);
  expect((await goalOf())?.objective).toBe('all tests pass');
  // The CLI checks the condition and finds it not met.
  stack.provider.goal('welcome', { iterations: 2, lastReason: 'two tests fail' });
  await expect.poll(() => goalLine(page).textContent(), { timeout: 30_000 }).toContain('2 checks');
  expect(await goalLine(page).getAttribute('title')).toContain('Last check: two tests fail');
  expect(await page.locator('.agent-timeline-entry').count()).toBe(2);
  await goalButton(page, 'Pause').click();
  await expect.poll(() => goalLine(page).textContent(), { timeout: 30_000 }).toContain('Paused');
  expect((await goalOf())?.status).toBe('paused');
  await goalButton(page, 'Resume').click();
  await expect.poll(() => goalLine(page).textContent(), { timeout: 30_000 }).toContain('Working toward it');
  // A page opened later reads the goal the session reports.
  await page.reload();
  await expect.poll(() => goalLine(page).textContent(), { timeout: 45_000 }).toContain('2 checks');
  await goalButton(page, 'Clear goal').click();
  await expect.poll(() => goalLine(page).count(), { timeout: 30_000 }).toBe(0);
  expect(await goalOf()).toBeUndefined();
  await page.reload();
  await waitForEntries(page, 2);
  // The device's copy may paint the goal for a moment before the session's report replaces it.
  await expect.poll(() => goalLine(page).count(), { timeout: 30_000 }).toBe(0);
  await context.close();
}, 120_000);

it('E21: a goal the CLI finishes shows as done with no action', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('welcome'));
  await waitForEntries(page, 2);
  await send(page, '/goal ship the release');
  await expect.poll(() => goalLine(page).textContent(), { timeout: 30_000 }).toContain('ship the release');
  stack.provider.goal('welcome', { status: 'complete', iterations: 3 });
  await expect.poll(() => goalLine(page).textContent(), { timeout: 30_000 }).toContain('Done');
  expect(await goalLine(page).locator('button').count()).toBe(0);
  stack.provider.goal('welcome', null);
  await expect.poll(() => goalLine(page).count(), { timeout: 30_000 }).toBe(0);
  await context.close();
}, 90_000);
