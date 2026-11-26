// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// Settings > Computers on a fake update service: Update all (n), its confirmation, and each card's own progress, failure and retry. The
// cards keep their places while the states change.
declare global { interface Window { fleet: { requests: string[]; restart(): void; back(): void } } }

const cardTops = (page: Page) => page.locator('.lab-host-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top + scrollY)));
const cardHeights = (page: Page) => page.locator('.lab-host-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().height)));
const card = (page: Page, name: string) => page.locator('.lab-host-card', { hasText: name });

test('Update all updates every eligible computer at once and each card shows its own progress', async ({ page }, testInfo) => {
  await page.clock.install();
  await page.goto('/e2e/fixtures/fleet-update.html');
  const all = page.getByRole('button', { name: 'Update all (2)' });
  await expect(all).toBeVisible();
  await expect(card(page, 'Current mini')).toContainText('Controller 0.2.0 · up to date');
  await expect(card(page, 'Current mini').getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  const tops = await cardTops(page), heights = await cardHeights(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('update-all-button.png') });

  await all.click();
  const confirm = page.getByRole('group', { name: 'Confirm updating computers' });
  await expect(confirm).toContainText('Update 2 computers to 0.2.0?');
  await expect(confirm.locator('[data-list=update] li')).toHaveText(['Studio Mac0.1.0 to 0.2.0', 'Design studio0.1.0 to 0.2.0'].map(text => text));
  await expect(confirm.locator('[data-list=skip]')).toContainText('Offline laptopOffline');
  await expect(confirm.locator('[data-list=skip]')).toContainText('Shared server');
  await expect(confirm.locator('[data-list=skip]')).toContainText('Current miniAlready up to date');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('update-all-confirmation.png'), fullPage: true });
  await confirm.getByRole('button', { name: 'Confirm update' }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fleet.requests)).toEqual(['mac', 'studio']);

  // One failed request stays on its card with a retry; the other computer carries on.
  await expect(card(page, 'Design studio')).toContainText('Update failed');
  await expect(card(page, 'Design studio').getByRole('button', { name: 'Retry update' })).toBeVisible();
  await expect(card(page, 'Studio Mac')).toContainText('Downloading and installing…');
  await expect(page.getByRole('button', { name: /Update all/ })).toHaveCount(0);
  expect(await cardTops(page), 'cards stay where they were').toEqual(tops);
  expect(await cardHeights(page)).toEqual(heights);
  await page.screenshot({ path: testInfo.outputPath('update-progress.png'), fullPage: true });

  await page.evaluate(() => window.fleet.restart());
  await page.clock.runFor(3_100);
  await expect(card(page, 'Studio Mac')).toContainText('Reconnecting…');
  expect(await cardTops(page)).toEqual(tops);
  await page.evaluate(() => window.fleet.back());
  await expect(card(page, 'Studio Mac')).toContainText('Updated to 0.2.0');
  await expect(card(page, 'Design studio')).toContainText('Update failed');
  await expect(card(page, 'Offline laptop')).not.toContainText('Updated');
  expect(await cardTops(page)).toEqual(tops);
  expect(await cardHeights(page)).toEqual(heights);

  await card(page, 'Design studio').getByRole('button', { name: 'Retry update' }).click();
  await card(page, 'Design studio').getByRole('button', { name: 'Confirm update' }).click();
  await expect.poll(() => page.evaluate(() => window.fleet.requests)).toEqual(['mac', 'studio', 'studio']);
});
