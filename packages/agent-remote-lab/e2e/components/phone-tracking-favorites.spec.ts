// Component projects: orchard-phone-webkit
import { expect, test } from '@playwright/test';

// Tracking from the Favorites panel of the Sessions drawer on a 320px phone: the tracked-sessions panel has no per-row close buttons, and the
// Favorites filter counts, narrows and untracks without overflowing its toolbar.
test('tracking is managed from the Favorites filter of the drawer, without row close buttons', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const star = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'tracked', title: 'Research notes', starredAt: 1,
    favoriteId: 'tracked', folderId: 'work', order: 0, available: true, online: true, hostName: 'Work Mac' };
  const other = { ...star, nativeSessionId: 'other', favoriteId: 'other', order: 1 };
  const orphan = { ...star, nativeSessionId: 'removed', favoriteId: 'removed' };
  let stars = [star, other];
  await page.addInitScript(({ star, orphan }) => {
    localStorage.setItem('agent-remote:track-view', 'true');
    localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify([star, orphan]));
  }, { star, orphan });
  await page.route('**/v1/session-migrations', route => route.fulfill({ json: { migrations: [] } }));
  await page.route('**/v1/favorites', async route => {
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (body?.type === 'remove-session') stars = stars.filter(s => s.nativeSessionId !== body.session.nativeSessionId);
    await route.fulfill({ json: { revision: 1, folders: [{ id: 'work', parentId: null, title: 'Work', order: 0 }], stars } });
  });
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: 'tracked-agent' } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
  await expect(page.locator('#lab-context')).toBeHidden();
  await expect(page.getByTestId('timeline')).toBeVisible();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem(`agent-remote-tracking:${location.origin}/u/alice/`) ?? '[]').map((s: { nativeSessionId: string }) => s.nativeSessionId));
  // A tracked identity that favorites no longer hold is dropped.
  await expect.poll(saved).toEqual(['tracked']);
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  const tracked = page.locator('.lab-launcher-track');
  await expect(tracked.locator('[aria-label^="Untrack "]')).toHaveCount(0);
  await expect(tracked.locator('.lab-session-row')).toHaveCount(1);
  expect((await tracked.locator('.lab-session-row').boundingBox())!.width).toBeGreaterThan(150);
  await page.getByRole('button', { name: 'Close Tracked sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  const rail = page.getByRole('dialog', { name: 'Context', exact: true });
  await rail.getByRole('button', { name: 'Favorites', exact: true }).click();
  const filter = rail.getByRole('button', { name: 'Filter tracked favorites', exact: true });
  const all = rail.getByRole('button', { name: 'Show all favorites', exact: true });
  await expect(all).toHaveText('2 favorites');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(filter).toHaveText('1 tracked');
  const fits = (selector: string) => rail.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1);
  expect(await fits('.lab-favorites-toolbar')).toBe(true);
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(rail.locator('[role="treeitem"]')).toHaveCount(1);
  await expect(rail.locator('[data-favorite-id="tracked"]')).toBeVisible();
  expect(await fits('nav[aria-label="Sidebar sections"]')).toBe(true);
  await page.screenshot({ path: info.outputPath('tracked-favorites.png'), animations: 'disabled' });
  await rail.getByRole('button', { name: 'Actions for Research notes', exact: true }).click();
  await page.locator('.lab-favorite-menu').getByRole('button', { name: 'Untrack', exact: true }).click();
  await expect(rail.getByText('No tracked favorites.', { exact: false })).toBeVisible();
  await expect.poll(saved).toEqual([]);
  await expect(filter).toHaveText('0 tracked');
  await all.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await rail.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(rail.locator('[data-favorite-id="tracked"]')).toBeVisible();
  await expect(rail.locator('[data-favorite-id="other"]')).toBeVisible();
  await rail.locator('[data-favorite-id="tracked"]').getByRole('button', { name: 'Actions for Research notes' }).click();
  await page.locator('.lab-favorite-menu').getByRole('button', { name: 'Track', exact: true }).click();
  await filter.click();
  await rail.getByRole('button', { name: 'Actions for Research notes', exact: true }).click();
  await page.locator('.lab-favorite-menu').getByRole('button', { name: 'Remove favorite', exact: true }).click();
  await expect.poll(saved).toEqual([]);
  await expect(filter).toHaveText('0 tracked');
  await all.click();
  await expect(rail.locator('[data-favorite-id="other"]')).toBeVisible();
  await expect(rail.locator('[data-favorite-id="tracked"]')).toHaveCount(0);
});
