import { expect, test, type Page } from '@playwright/test';

// The board in a bot's details (bots plan 8g), at desktop width in the panel and on the phone as the sheet: the plan note and the item tree
// come first, finished items fold under Done, an item opens the bot doing it and expands into its staff bot's board (read only), the person
// edits an item in place by keyboard or pointer, and a stale edit says what it replaced, never making the page scroll sideways.
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll('.lab-board li, .lab-board-plan, .lab-board-form, .lab-board-notice')].every(node => node.getBoundingClientRect().right <= document.documentElement.clientWidth + 1));
const open = async (page: Page, isMobile: boolean) => {
  await page.goto(`/e2e/fixtures/board-details.html${isMobile ? '?surface=sheet' : ''}`);
  const board = page.locator('.lab-board');
  await expect(board).toBeVisible();
  return board;
};
const writes = (page: Page) => page.evaluate(() => (window as unknown as { boardWrites: unknown[] }).boardWrites);

test('shows the board first: the plan note and the tree of open items, and the finished ones folded under Done', async ({ page, isMobile }, testInfo) => {
  const board = await open(page, isMobile);
  const section = page.locator('.lab-assistant-section').first();
  await expect(section.getByRole('heading', { name: 'Board' })).toBeVisible();
  await expect(board.locator('[data-board-plan]')).toContainText('Cut the 2.0 release');
  const titles = await board.locator(':scope > ul.lab-board-items .lab-board-title').allTextContents();
  expect(titles).toEqual(['Release 2.0 end to end, with the changelog and the announcement text for the customers', 'Write the release notes', 'Run the regression suite']);
  await expect(board.locator('[data-board-item="1"]').first()).toContainText('Assigned to Release tracker');
  await expect(board.locator('[data-board-item="1"]').first()).toContainText('Latest report: Build is red on main');
  await expect(board.locator('[data-board-item="1"]').first()).toContainText('branch: release/2.0-with-a-long-branch-name');
  await expect(board.locator('[data-board-item="4"]')).toBeHidden();
  await board.locator('details.lab-board-done > summary').click();
  await expect(board.locator('[data-board-item="4"]')).toBeVisible();
  await expect(board.locator('[data-board-item="4"]')).toContainText('Result: Deployed.');
  expect(await fits(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('board.png'), fullPage: true });
});

test('opens the bot doing an item, and expands an item of a staff bot into its board without a way to edit it', async ({ page, isMobile }, testInfo) => {
  const board = await open(page, isMobile);
  const first = board.locator('[data-board-item="1"]').first();
  await first.locator('.lab-assistant-session-toggle').first().click();
  await first.getByRole('button', { name: 'Open Release tracker' }).first().click();
  expect(await page.evaluate(() => (window as unknown as { openedBots: string[] }).openedBots)).toEqual(['b_' + '2'.repeat(32)]);
  const staff = first.locator('[data-staff-board]');
  await expect(staff).toContainText('Board of Release tracker (read only)');
  await expect(staff).toContainText('Poll the build every minute');
  await expect(staff.getByRole('button', { name: /Edit|Cancel item/ })).toHaveCount(0);
  expect(await fits(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('board-staff.png'), fullPage: true });
});

test('edits an item by keyboard, and says what a stale edit replaced', async ({ page, isMobile }, testInfo) => {
  const board = await open(page, isMobile);
  const item = board.locator('[data-board-item="2"]');
  const toggle = item.locator('.lab-assistant-session-toggle').first();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await item.getByRole('button', { name: 'Edit item' }).focus();
  await page.keyboard.press('Enter');
  const form = item.locator('form');
  await form.getByLabel('Title').fill('Write the release notes and the upgrade guide');
  await form.getByLabel('Status').selectOption('working');
  await form.getByLabel('Assigned to').selectOption({ label: 'Regression run' });
  expect(await fits(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('board-edit.png'), fullPage: true });
  await form.getByRole('button', { name: 'Save item' }).click();
  expect(await writes(page)).toEqual([{ items: [{ key: 2, version: 1, title: 'Write the release notes and the upgrade guide', status: 'working', assignee: 'b_' + '3'.repeat(32) }] }]);
  await expect(board.locator('[role="status"]')).toHaveText('Your edit replaced the status: it was “Waiting” (set by Release tracker).');
  await expect(board.locator('[data-board-item="2"] .lab-board-title')).toHaveText('Write the release notes and the upgrade guide');
  await expect(board.locator('[data-board-item="2"] form')).toHaveCount(0);
  expect(await fits(page)).toBe(true);
});

test('edits the plan note with a why, and cancels an item', async ({ page, isMobile }) => {
  const board = await open(page, isMobile);
  await board.getByRole('button', { name: 'Edit plan' }).click();
  const form = board.locator('[data-board-plan] form');
  await form.getByLabel('Plan note').fill('Ship the notes first.');
  await expect(form.getByRole('button', { name: 'Save plan' })).toBeDisabled();
  await form.getByLabel('Why change it').fill('The notes block the release.');
  expect(await fits(page)).toBe(true);
  await form.getByRole('button', { name: 'Save plan' }).click();
  await expect(board.locator('[data-board-plan]')).toContainText('Ship the notes first.');
  expect(await writes(page)).toEqual([{ plan: { text: 'Ship the notes first.', why: 'The notes block the release.', version: 2 } }]);
  const third = board.locator('[data-board-item="3"]');
  await third.locator('.lab-assistant-session-toggle').first().click();
  await third.getByRole('button', { name: 'Cancel item' }).first().click();
  expect((await writes(page)).at(-1)).toEqual({ items: [{ key: 3, version: 1, status: 'cancelled' }] });
  await expect(board.locator('details.lab-board-done > summary')).toHaveText('Done (3)');
});

test('adds an item with an assignee, a brief and a parent from the details, and it shows in the tree', async ({ page, isMobile }, testInfo) => {
  const board = await open(page, isMobile);
  await board.getByRole('button', { name: 'New item' }).click();
  const form = board.locator('[data-board-new]');
  await form.getByLabel('Title').fill('Check the release checklist');
  await form.getByLabel('Assigned to').selectOption({ label: 'Regression run' });
  await form.getByLabel('Brief').fill('Tick every box before the cut.');
  await form.getByLabel('Under item').selectOption({ label: 'Write the release notes' });
  expect(await fits(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('board-new.png'), fullPage: true });
  await form.getByRole('button', { name: 'Add item' }).click();
  expect(await writes(page)).toEqual([{ items: [{ title: 'Check the release checklist', assignee: 'b_' + '3'.repeat(32), brief: 'Tick every box before the cut.', parent: 2 }] }]);
  await expect(board.locator('[data-board-item="2"] [data-board-item]').filter({ hasText: 'Check the release checklist' })).toHaveCount(1);
  await expect(board.locator('[data-board-new]')).toHaveCount(0);
  expect(await fits(page)).toBe(true);
});
