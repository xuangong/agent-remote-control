import { expect, test, type Page } from '@playwright/test';

// The team page and the primary bot, at desktop width and on the phone. The chief's conversation carries its team page as one card, closed to
// its title and who wrote it when; opening it shows the table inside the card, and a rewrite changes the card where it stands (it stays open, no
// second card, the conversation does not move). The bot's details list its pages read only and offer Make primary, which they then replace with Clear.
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll('.agent-page-card, .agent-page-card table, .lab-assistant-section')].every(node => node.getBoundingClientRect().right <= document.documentElement.clientWidth + 1));

test('shows the team page as one card that opens to its table and is rewritten in place', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/team-page.html');
  const card = page.locator('[data-page-card]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Release 2.0 tracker');
  await expect(card).toContainText('Updated by Release tracker');
  await expect(card.locator('table')).toHaveCount(0);
  await card.getByRole('button', { name: 'Show page' }).click();
  await expect(card.locator('table')).toBeVisible();
  await expect(card.locator('tbody tr')).toHaveCount(2);
  expect(await fits(page)).toBe(true);
  const before = await card.boundingBox();
  const heading = await page.locator('.agent-timeline-entries').boundingBox();
  await page.evaluate(() => (window as unknown as { rewrite(): void }).rewrite());
  await expect(card.locator('tbody tr')).toHaveCount(3);
  await expect(page.locator('[data-page-card]')).toHaveCount(1);
  await expect(card).toHaveAttribute('data-open', 'true');
  // The card keeps its place: it grew downward, and the conversation below it moved only by that growth.
  const after = await card.boundingBox();
  expect(after!.y).toBe(before!.y);
  expect(after!.x).toBe(before!.x);
  expect((await page.locator('.agent-timeline-entries').boundingBox())!.y - heading!.y).toBeGreaterThanOrEqual(0);
  expect(await fits(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('team-page-card.png'), fullPage: true });
});

test('lists a bot\'s pages in its details, read only, and marks it primary and clears the mark', async ({ page, isMobile }, testInfo) => {
  await page.goto(`/e2e/fixtures/team-page.html?view=details${isMobile ? '&surface=sheet' : ''}`);
  const pages = page.locator('[data-pages] > li');
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  await expect(pages).toHaveCount(2);
  await expect(pages.first()).toContainText('Team page');
  await pages.first().getByRole('button').click();
  await expect(pages.first().locator('table')).toBeVisible();
  await expect(page.locator('[data-pages] textarea, [data-pages] input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Make primary' }).click();
  await expect(page.getByText('This is your primary bot.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the mark' }).click();
  await expect(page.getByRole('button', { name: 'Make primary' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { primaryMarks: boolean[] }).primaryMarks)).toEqual([true, false]);
  expect(await fits(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('team-page-details.png'), fullPage: true });
});
