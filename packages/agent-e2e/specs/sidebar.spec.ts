import { expect, test } from '@playwright/test';
import { showNewSession } from './session-navigation';
import { openSessionsPage } from './all-sessions';

test('keeps discovery, creation and management easy to reach while retaining form drafts', async ({ page }, info) => {
  await page.goto('/');
  const desktop = info.project.name === 'chromium-desktop';
  // Desktop opens the session panels as pages from the sidebar; compact layouts keep them in the Context drawer's tabs.
  const rail = desktop ? page.locator('#lab-sessions-page') : page.locator('#lab-context');
  const show = async (entry: 'Sessions') => {
    if (desktop) await openSessionsPage(page, 'All sessions');
    else await rail.getByRole('button', { name: entry, exact: true }).click();
  };
  if (desktop) await show('Sessions');
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
  // Settings is its own page now (the rail's Settings); the sessions panels keep their drafts.
  await show('Sessions');
  await showNewSession(page);
  await expect(rail.getByLabel('Working directory', { exact: true })).toHaveValue('/tmp/sidebar-draft');
  await rail.getByRole('button', { name: 'Browse…' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a workspace folder' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail.getByTestId('session-create')).toBeVisible();
  await show('Sessions');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: info.outputPath('sidebar.png') });
});

test('keeps long session lists in one scroll area and reveals each panel from its beginning', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop');
  const titles = ['Workspace folder picker and permissions', 'Investigate Controller heartbeat recovery', 'Review the preview tunnel and image resources', 'Improve sidebar navigation and long session titles'];
  await page.route('**/v1/remote/catalog?*', route => route.fulfill({ json: {
    revision: 'sidebar-list', hasMore: false,
    items: Array.from({ length: 25 }, (_, index) => ({
      providerId: 'recorded', nativeSessionId: `sidebar-${index}`, title: `${titles[index % titles.length]} ${index + 1}`,
      workspace: `/Users/developer/projects/${index % 2 ? 'agent-remote-control' : 'workspace-preview'}`,
      state: index === 1 ? 'running' : index === 2 ? 'waiting' : 'idle',
      createdAt: '2026-09-17T06:00:00Z', updatedAt: '2026-09-17T06:00:00Z',
    })),
  } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // The long list is on the All sessions page, which scrolls as one area below its toolbar.
  const rail = await openSessionsPage(page);
  await expect(rail.locator('.lab-session-row')).toHaveCount(25);
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
