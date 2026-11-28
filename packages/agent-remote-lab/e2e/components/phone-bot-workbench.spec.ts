// Component projects: orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// The bot workbench on a phone: its work as a list (main conversation, then sub-sessions by need, what the person added, the folded
// Ended group, the ledger), a row pushing its conversation full screen, and Back returning to the list. Nothing is swiped through.
const open = async (page: Page, query = '') => { await page.goto(`/e2e/fixtures/bot-workbench.html?phone${query}`); await expect(page.locator('.lab-workbench-overview')).toBeVisible(); };
const rows = (page: Page) => page.locator('.lab-workbench-overview li > button[data-tile]');

test('lists the bot\'s work by need, with the main conversation first and the ended ones folded', async ({ page }, testInfo) => {
  await open(page, '&subs=5');
  const tiles = await rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tile')));
  expect(tiles).toEqual(['main', 'sub:s1', 'sub:s2', 'sub:s4', 'sub:s3', 'note']);
  await expect(page.locator('.lab-workbench-overview').getByRole('button', { name: /^Ended · 1/ })).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workbench-phone.png') });
});

test('pushes a conversation full screen from a row and returns to the same list with Back', async ({ page }) => {
  await open(page, '&subs=3');
  await page.locator('.lab-workbench-overview').evaluate(node => { node.scrollTop = 0; });
  await page.locator('[data-tile="sub:s2"]').click();
  await expect(page.locator('.lab-derived-tile')).toBeVisible();
  await expect(page.locator('.lab-workbench-overview')).toHaveCount(0);
  await page.getByRole('button', { name: /^‹/ }).click();
  await expect(page.locator('.lab-workbench-overview')).toBeVisible();
  await expect(page.locator('.lab-derived-tile')).toHaveCount(0);
});

test('shows the ledger as a pushed screen whose owner link opens the sub-session\'s conversation', async ({ page }) => {
  await open(page, '&subs=3');
  await page.getByRole('button', { name: 'Ledger' }).last().click();
  await expect(page.locator('.lab-workbench-ledger')).toContainText('Fix the failing build');
  await page.locator('.lab-workbench-ledger .lab-assistant-session-toggle').first().click();
  await page.getByRole('button', { name: /Open Sub-session 1/ }).first().click();
  await expect(page.locator('.lab-derived-tile')).toContainText('Sub-session 1');
});

test('switches to a staff bot\'s workbench from the list', async ({ page }) => {
  await open(page, '&subs=1');
  await page.getByRole('button', { name: 'Pebbles' }).click();
  expect(await page.evaluate(() => (window as unknown as { openedWorkbenches: string[] }).openedWorkbenches)).toEqual(['s1']);
});
