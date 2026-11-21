import { expect, test } from '@playwright/test';
import { showNewSession } from '../session-navigation';
import { openSessionsPage } from '../all-sessions';

// The desktop sidebar opens the session panels as pages; a phone keeps them in the assistant list and its own screens.
test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop sidebar pages');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?sidebar');
});

test('keeps discovery, creation and management easy to reach while retaining form drafts', async ({ page }, info) => {
  const rail = page.locator('#lab-sessions-page');
  await openSessionsPage(page, 'All sessions');
  const discover = rail.getByRole('region', { name: 'Discover sessions' });
  await expect(discover.locator('.lab-session-row').first()).toBeVisible();
  await expect(rail.getByTestId('session-create')).toBeHidden();
  const search = rail.getByRole('searchbox', { name: 'Search loaded sessions' });
  await search.fill('no-matching-session-xyz');
  await expect(discover).toContainText('No matching loaded sessions.');
  await search.fill('');
  await expect(discover.locator('.lab-session-row').first()).toBeVisible();
  await showNewSession(page);
  await expect(rail.getByTestId('session-create')).toBeVisible();
  await expect(discover).toBeHidden();
  await rail.getByLabel('Working directory', { exact: true }).fill('/tmp/sidebar-draft');
  await openSessionsPage(page, 'All sessions');
  await showNewSession(page);
  await expect(rail.getByLabel('Working directory', { exact: true })).toHaveValue('/tmp/sidebar-draft');
  await rail.getByRole('button', { name: 'Browse…' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a workspace folder' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail.getByTestId('session-create')).toBeVisible();
  await openSessionsPage(page, 'All sessions');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('sidebar.png') });
});

test('keeps long session lists in one scroll area and reveals each panel from its beginning', async ({ page }, info) => {
  const rail = await openSessionsPage(page);
  await expect(rail.locator('.lab-session-row')).toHaveCount(24);
  const scroll = rail.locator('.lab-sessions-page-body');
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(400);
  await showNewSession(page);
  await expect(rail.getByTestId('provider-select')).toBeInViewport();
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
  await openSessionsPage(page);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await openSessionsPage(page, 'Favorites');
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
  await openSessionsPage(page);
  const list = rail.locator('.lab-session-list');
  expect(await list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('sidebar-long-sessions.png') });
});
