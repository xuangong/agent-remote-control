// Component projects: webkit-mobile-viewport, orchard-phone-webkit
import { expect, test, type Locator, type Page } from '@playwright/test';

// A bot's sub-sessions (bots design 10), on the real details of the bot with the page's directory: each is a row grouped by what it
// needs (needs you, working, idle, ended), the person opens it or stops it, by pointer or keyboard, at any width without the page
// scrolling sideways. There is no Keep and no Mark done. Send, Queue and Interrupt in a sub-session's own conversation are the generic
// composer's, checked by composer-capsule.spec.ts and assistant-inventory.spec.ts.
const taskActions = (page: Page) => page.evaluate(() => (window as unknown as { taskActions: unknown[] }).taskActions);
const fitsWidth = (page: Page) => page.evaluate(() => {
  const inside = (box: DOMRect, outer: DOMRect) => box.width > 0 && box.left >= outer.left - 1 && box.right <= outer.right + 1;
  const dialog = document.querySelector('dialog[open]')?.getBoundingClientRect();
  const outer = dialog ?? new DOMRect(0, 0, innerWidth, innerHeight);
  return document.documentElement.scrollWidth <= innerWidth
    && [...document.querySelectorAll('.lab-assistant-tasks li')].every(row => inside(row.getBoundingClientRect(), outer)
      && [...row.querySelectorAll('small, button, .lab-assistant-session-title')].every(part => inside(part.getBoundingClientRect(), row.getBoundingClientRect())));
});
const row = (page: Page, title: string): Locator => page.locator('.lab-assistant-tasks li').filter({ has: page.locator('.lab-assistant-session-title', { hasText: title }) }).filter({ visible: true });
async function expand(page: Page, title: string): Promise<Locator> {
  const bot = row(page, title);
  await bot.locator('.lab-assistant-session-toggle').click();
  return bot;
}

test('groups sub-sessions by what they need, shows a step, the last work and the idle time, and stops one by keyboard', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/sub-sessions.html');
  for (const name of ['Needs you', 'Working', 'Idle', 'Ended']) await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  await expect(page.getByText('Release tracker').filter({ visible: true }).first()).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sub-sessions.png'), fullPage: true });

  const logs = await expand(page, 'Log reader');
  await expect(logs.getByText('Now: Reading the build logs')).toBeVisible();
  const tests = await expand(page, 'Test runner');
  await expect(tests.locator('small')).toContainText('Idle for');
  await expect(tests.getByText('All green.')).toBeVisible();
  // The old ways to end a bot are gone: no Keep, no Mark done.
  await expect(page.getByRole('button', { name: 'Keep as a bot' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark done' })).toHaveCount(0);

  // Stop, by keyboard: Enter on the focused button; the row moves to Ended and its action is gone.
  await logs.getByRole('button', { name: 'Stop', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Ended' }).locator('li').filter({ hasText: 'Log reader' })).toHaveCount(1);
  await expect(row(page, 'Log reader').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  expect(await taskActions(page)).toEqual([['t_logs', 'stop_sub_session']]);
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sub-sessions-stopped.png'), fullPage: true });
});

test('an ended sub-session offers nothing more, and a waiting one shows what it waits for', async ({ page }) => {
  await page.goto('/e2e/fixtures/sub-sessions.html');
  const old = await expand(page, 'Changelog check');
  await expect(old.getByText('The runner was offline.')).toBeVisible();
  await expect(old.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const notes = await expand(page, 'Release notes writer');
  await expect(notes.getByText('Run npm run notes?')).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
