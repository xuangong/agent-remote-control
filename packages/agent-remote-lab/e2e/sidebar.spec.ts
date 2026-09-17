import { expect, test } from '@playwright/test';
import { showNewSession } from './session-navigation';
import { toggleViewPanel } from './view-options';

test('resizes the desktop sidebar, retains its width, and supports keyboard reset', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const handle = page.getByRole('separator', { name: 'Sidebar width' });
  const rail = page.locator('#lab-context');
  await expect(handle).toHaveAttribute('aria-valuenow', '320');
  const bounds = await handle.boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 150);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 140, bounds!.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '460');
  expect((await rail.boundingBox())!.width).toBe(460);
  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', '460');
  await handle.focus(); await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '450');
  await page.keyboard.press('Home'); await expect(handle).toHaveAttribute('aria-valuenow', '260');
  await page.keyboard.press('End'); await expect(handle).toHaveAttribute('aria-valuenow', '560');
  await page.setViewportSize({ width: 1181, height: 800 });
  await toggleViewPanel(page, 'Replica Inspector');
  await expect(handle).toHaveAttribute('aria-valuenow', '381');
  expect((await page.locator('.lab-main-stage').boundingBox())!.width).toBeGreaterThanOrEqual(479);
  await toggleViewPanel(page, 'Replica Inspector');
  await expect(handle).toHaveAttribute('aria-valuenow', '560');
  await page.setViewportSize({ width: 1180, height: 800 });
  await expect(handle).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(handle).toHaveAttribute('aria-valuenow', '560');
  const resetBounds = await handle.boundingBox();
  await page.mouse.dblclick(resetBounds!.x + 4, resetBounds!.y + 150);
  await expect(handle).toHaveAttribute('aria-valuenow', '320');
  await toggleViewPanel(page, 'Sidebar'); await expect(handle).toHaveCount(0);
  await toggleViewPanel(page, 'Sidebar'); await expect(handle).toBeVisible();
});

test('keeps discovery, creation and management easy to reach while retaining form drafts', async ({ page }, info) => {
  await page.goto('/');
  const rail = page.locator('#lab-context');
  const desktop = info.project.name === 'chromium-desktop';
  const discover = rail.getByRole('region', { name: 'Discover sessions' });
  await expect(discover.locator('.lab-session-row').first()).toBeVisible();
  await expect(rail.getByTestId('session-create')).toBeHidden();
  await expect(rail.getByRole('button', { name: 'Pair Agent Host' })).toBeHidden();
  const search = rail.getByRole('searchbox');
  await search.fill('no-matching-session-xyz');
  await expect(discover).toContainText('No matching loaded sessions.');
  await search.fill('');
  await expect(discover.locator('.lab-session-row').first()).toBeVisible();
  await showNewSession(page);
  await expect(rail.getByTestId('session-create')).toBeVisible();
  await expect(discover).toBeHidden();
  await rail.getByLabel('Working directory', { exact: true }).fill('/tmp/sidebar-draft');
  await rail.getByRole('button', { name: desktop ? 'Sidebar settings' : 'Settings', exact: true }).click();
  await expect(rail.getByRole('button', { name: 'Pair Agent Host' })).toBeVisible();
  await expect(rail.getByTestId('session-create')).toBeHidden();
  if (desktop) await rail.getByRole('button', { name: 'Sessions', exact: true }).click();
  else await rail.getByRole('button', { name: 'All sessions', exact: true }).click();
  await showNewSession(page);
  await expect(rail.getByLabel('Working directory', { exact: true })).toHaveValue('/tmp/sidebar-draft');
  await rail.getByRole('button', { name: 'Browse…' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a workspace folder' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail.getByTestId('session-create')).toBeVisible();
  if (desktop) await rail.getByRole('button', { name: 'Sessions', exact: true }).click();
  else await rail.getByRole('button', { name: 'All sessions', exact: true }).click();
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
  const rail = page.locator('#lab-context');
  await expect(rail.locator('.lab-session-row')).toHaveCount(25);
  const scroll = rail.locator('.lab-sidebar-content');
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(400);
  await showNewSession(page);
  await expect(rail.getByTestId('provider-select')).toBeInViewport();
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
  await rail.getByRole('button', { name: 'Sessions', exact: true }).click();
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await rail.getByRole('button', { name: 'Sidebar settings', exact: true }).click();
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
  await rail.getByRole('button', { name: 'Sessions', exact: true }).click();
  const list = rail.locator('.lab-session-list');
  expect(await list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('sidebar-long-sessions.png') });
});
