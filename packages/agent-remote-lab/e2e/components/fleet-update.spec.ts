// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// Settings > Computers on a fake update service: Update all (n), its confirmation, and each card's own progress, failure and retry. The
// cards keep their places while the states change.
declare global { interface Window { fleet: { requests: string[]; restart(): void; releaseStatus(): void; back(ids: string[]): void } } }

const cardTops = (page: Page) => page.locator('.lab-host-card').evaluateAll(cards => { const list = cards[0]!.closest('.lab-host-overview')!.getBoundingClientRect().top; return cards.map(item => Math.round(item.getBoundingClientRect().top - list)); });
const cardHeights = (page: Page) => page.locator('.lab-host-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().height)));
const card = (page: Page, name: string) => page.locator('.lab-host-card', { hasText: name });

test('Update all updates every eligible computer at once and each card shows its own progress', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/fleet-update.html');
  const all = page.getByRole('button', { name: 'Update all (3)' });
  await expect(all).toBeVisible();
  await expect(card(page, 'Current mini')).toContainText('Controller 0.2.0 · up to date');
  await expect(card(page, 'Current mini').getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  // The figures of every online computer have arrived, so what is measured next is the settled list.
  await expect(page.locator('.lab-host-sessions:not([data-pending])')).toHaveCount(5);
  const tops = await cardTops(page), heights = await cardHeights(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('update-all-button.png') });

  await all.click();
  const confirm = page.getByRole('group', { name: 'Confirm updating computers' });
  await expect(confirm).toContainText('Update 3 computers to 0.2.0?');
  await expect(confirm.locator('[data-list=update] li')).toHaveText(['Studio Mac0.1.0 to 0.2.0', 'Design studio0.1.0 to 0.2.0', 'Desk PC0.1.0 to 0.2.0']);
  await expect(confirm.locator('[data-list=skip]')).toContainText('Offline laptopOffline');
  await expect(confirm.locator('[data-list=skip]')).toContainText('Shared server');
  await expect(confirm.locator('[data-list=skip]')).toContainText('Current miniAlready up to date');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('update-all-confirmation.png') });
  await confirm.getByRole('button', { name: 'Confirm update' }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fleet.requests)).toEqual(['mac', 'studio', 'desk']);

  // One failed request stays on its card with a retry; the other computer carries on.
  await expect(card(page, 'Design studio')).toContainText('Update failed');
  await expect(card(page, 'Design studio').getByRole('button', { name: 'Retry update' })).toBeVisible();
  await expect(card(page, 'Studio Mac')).toContainText('Downloading and installing…');
  await expect(card(page, 'Desk PC')).toContainText('Downloading and installing…');
  // Only the computer whose request failed is still left to update.
  await expect(page.getByRole('button', { name: 'Update all (1)' })).toBeVisible();
  expect(await cardTops(page), 'cards stay where they were').toEqual(tops);
  expect(await cardHeights(page)).toEqual(heights);
  await page.screenshot({ path: testInfo.outputPath('update-progress.png') });

  await page.evaluate(() => window.fleet.restart());
  await expect(card(page, 'Studio Mac')).toContainText('Reconnecting…', { timeout: 10_000 });
  expect(await cardTops(page)).toEqual(tops);
  await page.evaluate(() => window.fleet.back(['mac']));
  await expect(card(page, 'Studio Mac')).toContainText('Updated to 0.2.0');
  await expect(card(page, 'Design studio')).toContainText('Update failed');
  // Desk PC never comes back on the new version: after the patience its card says so instead of waiting for ever.
  await expect(card(page, 'Desk PC')).toContainText('Reconnecting…');
  await expect(card(page, 'Desk PC')).toContainText('Came back on 0.1.0, not 0.2.0', { timeout: 12_000 });
  await expect(card(page, 'Desk PC').getByRole('button', { name: 'Retry update' })).toBeVisible();
  await expect(card(page, 'Offline laptop')).not.toContainText('Updated');
  expect(await cardTops(page)).toEqual(tops);
  expect(await cardHeights(page)).toEqual(heights);

  await card(page, 'Design studio').getByRole('button', { name: 'Retry update' }).click();
  await card(page, 'Design studio').getByRole('button', { name: 'Confirm update' }).click();
  await expect.poll(() => page.evaluate(() => window.fleet.requests)).toEqual(['mac', 'studio', 'desk', 'studio']);
});

test('a card shows quiet placeholder rows until its Host reports, and the figures fill them in place', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/fleet-update.html?holdStatus');
  const mac = card(page, 'Studio Mac');
  await expect(mac.locator('.lab-host-meter[data-pending]')).toHaveCount(3);
  await expect(mac.locator('.lab-host-meter[data-pending]').first()).toContainText('CPU');
  await expect(mac.locator('.lab-host-meter[data-pending]').nth(1)).toContainText('Memory');
  await expect(card(page, 'Offline laptop').locator('[data-pending]')).toHaveCount(0);
  await expect(card(page, 'Shared server').locator('.lab-host-meter[data-pending]')).toHaveCount(0);
  const rows = () => mac.locator('.lab-host-meter').evaluateAll(items => items.map(item => { const box = item.getBoundingClientRect(); return [Math.round(box.top), Math.round(box.height)]; }));
  const before = await rows(), tops = await cardTops(page), heights = await cardHeights(page);
  expect(before).toHaveLength(3);
  await page.screenshot({ path: testInfo.outputPath('placeholder-rows.png') });
  await page.evaluate(() => window.fleet.releaseStatus());
  await expect(mac.locator('.lab-host-meter[role=meter]')).toHaveCount(3);
  await expect(mac.locator('[data-pending]')).toHaveCount(0);
  expect(await rows(), 'the figures take the placeholder rows\' places').toEqual(before);
  // The computer shared with the reader shows its sessions only once read, so the cards after it may move; the owned computers keep their places.
  expect((await cardTops(page)).slice(0, 5)).toEqual(tops.slice(0, 5));
  const settled = await cardHeights(page);
  for (const index of [0, 1, 2, 3, 5]) expect(settled[index]).toBe(heights[index]);
});
