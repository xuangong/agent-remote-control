// Component projects: webkit-mobile-viewport, orchard-phone-webkit
import { expect, test, type Locator, type Page } from '@playwright/test';

// A chief's temporary bots (bots design 10), on the real details of the chief with the page's task directory: each bot is a row in the
// chief's tasks, and the person stops it, takes it as done, or keeps it as a standing bot, by pointer or keyboard, at any width without
// the page scrolling sideways. Send, Queue and Interrupt in a temporary bot's own conversation are the generic composer's: the Interrupt
// button is checked by composer-capsule.spec.ts and assistant-inventory.spec.ts, and a message written while the turn runs is queued in
// assistant-inventory.spec.ts. Nothing here is specific to a temporary bot's composer.
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

test('stops a temporary bot, takes another as done and keeps a third as a standing bot, and each row follows', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/temporary-bots.html');
  await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Working' })).toBeVisible();
  await expect(page.getByText('Release tracker').filter({ visible: true }).first()).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('temporary-bots.png'), fullPage: true });

  // Stop, by pointer: the row moves to Done as stopped, and its actions are gone.
  const logs = await expand(page, 'Log reader');
  await expect(logs.getByRole('button', { name: 'Mark done', exact: true })).toBeVisible();
  await expect(logs.getByRole('button', { name: 'Keep as a bot', exact: true })).toBeVisible();
  await logs.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Done' }).locator('li').filter({ hasText: 'Log reader' }).locator('small')).toContainText('Stopped');
  await expect(row(page, 'Log reader').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

  // Mark done, by keyboard: Space presses the focused button.
  const tests = await expand(page, 'Test runner');
  await tests.getByRole('button', { name: 'Mark done', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('region', { name: 'Done' }).locator('li').filter({ hasText: 'Test runner' })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Done' }).locator('li').filter({ hasText: 'Test runner' }).locator('small')).not.toContainText('Stopped');
  await expand(page, 'Test runner');
  await expect(page.getByRole('region', { name: 'Done' }).getByText('Taken as done.')).toBeVisible();

  // Keep as a bot, by keyboard: Enter on the focused button; the bot leaves the tasks and joins the chief's bots.
  const notes = await expand(page, 'Release notes writer');
  await expect(notes.getByText('Which branch has the notes?')).toBeVisible();
  await notes.getByRole('button', { name: 'Keep as a bot', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.lab-assistant-bots li').filter({ hasText: 'Release notes writer' })).toHaveCount(1);
  await expect(page.locator('.lab-assistant-tasks li').filter({ hasText: 'Release notes writer' })).toHaveCount(0);

  expect(await taskActions(page)).toEqual([['t_logs', 'cancel_task'], ['t_tests', 'mark_task_done'], ['t_notes', 'keep_task']]);
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('temporary-bots-acted.png'), fullPage: true });
});

test('a finished bot can still be kept, and a stopped one offers nothing more', async ({ page }) => {
  await page.goto('/e2e/fixtures/temporary-bots.html');
  const tests = await expand(page, 'Test runner');
  await tests.getByRole('button', { name: 'Mark done', exact: true }).click();
  const done = await expand(page, 'Test runner');
  await expect(done.getByRole('button', { name: 'Keep as a bot', exact: true })).toBeVisible();
  await expect(done.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(done.getByRole('button', { name: 'Mark done', exact: true })).toHaveCount(0);
  await done.getByRole('button', { name: 'Keep as a bot', exact: true }).click();
  expect(await taskActions(page)).toEqual([['t_tests', 'mark_task_done'], ['t_tests', 'keep_task']]);
  expect(await fitsWidth(page)).toBe(true);
});
