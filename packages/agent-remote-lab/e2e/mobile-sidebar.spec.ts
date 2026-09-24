import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
  test(`mobile sidebar keeps discovery and navigation reachable at ${viewport.width}`, async ({ page }, info) => {
    test.skip(!info.project.use.isMobile);
    await page.setViewportSize(viewport);
    await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
    await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
    await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
    await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
    const tracking = page.getByRole('button', { name: 'Tracked sessions', exact: true });
    await expect(tracking).toBeVisible();
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
    const rail = page.getByRole('dialog', { name: 'Context', exact: true });
    const scroll = rail.locator('.lab-sidebar-content');
    async function assertPanelWidth(panel: string) {
      const bounds = await scroll.evaluate(element => {
        element.scrollLeft = 1000;
        return { width: element.clientWidth, scrollWidth: element.scrollWidth, left: element.scrollLeft };
      });
      expect(bounds.scrollWidth, `${panel} must fit its own scrollport`).toBeLessThanOrEqual(bounds.width + 1);
      expect(bounds.left, `${panel} must not scroll horizontally`).toBe(0);
    }
    const discover = rail.getByRole('region', { name: 'Discover sessions' });
    await expect(discover.locator('.lab-session-row')).toHaveCount(24);
    await expect(tracking).toBeHidden();
    await assertPanelWidth('Sessions');
    await expect(rail.getByRole('button', { name: /Controller updates/ })).toBeHidden();
    await expect(rail.getByRole('region', { name: 'Host VS Code tunnel' })).toHaveCount(0);
    await expect(rail.getByRole('searchbox', { name: 'Find an execution environment' })).toBeHidden();
    if (viewport.height > 600) await expect(discover.locator('.lab-session-row').first()).toBeInViewport();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('sessions.png') });
    const footer = rail.getByRole('button', { name: 'New session', exact: true });
    const before = await footer.boundingBox();
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(discover.locator('.lab-session-row').last()).toBeInViewport();
    expect(await footer.boundingBox()).toEqual(before);
    const scrollBox = (await scroll.boundingBox())!;
    expect(scrollBox.y + scrollBox.height).toBeLessThanOrEqual(before!.y);
    await expect(rail.getByRole('navigation', { name: 'Sidebar sections' })).toBeInViewport();
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
    await assertPanelWidth('Settings');
    const updates = rail.getByRole('button', { name: /Controller updates/ });
    await expect(updates).toBeVisible();
    await updates.click();
    await assertPanelWidth('Settings with Controller updates');
    const vscode = rail.getByRole('region', { name: 'Host VS Code tunnel' });
    await expect(vscode).toBeVisible();
    const checkbox = vscode.getByRole('checkbox');
    await checkbox.check();
    expect((await checkbox.boundingBox())!.height).toBeLessThanOrEqual(22);
    await expect(vscode.getByRole('button', { name: 'Start tunnel' })).toBeEnabled();
    await page.screenshot({ path: info.outputPath('settings.png') });
    await rail.getByRole('button', { name: 'Favorites', exact: true }).click();
    await assertPanelWidth('Favorites');
    await expect(rail.getByRole('button', { name: /Controller updates/ })).toBeHidden();
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(updates).toHaveAttribute('aria-expanded', 'true');
    await rail.getByRole('button', { name: 'Sessions', exact: true }).click();
    expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
    await rail.locator('.lab-host-disclosure > summary').click();
    await assertPanelWidth('Sessions with Host details');
    await rail.getByRole('searchbox', { name: 'Find an execution environment' }).fill('mac zsh');
    await expect(rail.getByRole('status').filter({ hasText: '1 matching Hosts' })).toBeVisible();
    await rail.locator('.lab-host-disclosure > summary').click();
    await rail.locator('.lab-rail-close').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(footer).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(rail.locator('.lab-rail-close')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(tracking).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open sessions', exact: true })).toBeFocused();
  });
}

test('manages tracking from the sidebar favorites filter without row close buttons', async ({ page }, info) => {
  if (info.project.use.isMobile) await page.setViewportSize({ width: 320, height: 740 });
  const star = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'tracked', title: 'Research notes', starredAt: 1,
    favoriteId: 'tracked', folderId: 'work', order: 0, available: true, online: true, hostName: 'Work Mac' };
  const other = { ...star, nativeSessionId: 'other', favoriteId: 'other', order: 1 };
  const orphan = { ...star, nativeSessionId: 'removed', favoriteId: 'removed' };
  let stars = [star, other];
  await page.addInitScript(({ star, orphan }) => {
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
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem(`agent-remote-tracking:${location.origin}/u/alice/`) ?? '[]').map((s: { nativeSessionId: string }) => s.nativeSessionId));
  await expect.poll(saved).toEqual(['tracked']);
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(page.locator('.lab-tracking-floating [aria-label^="Untrack "]')).toHaveCount(0);
  await expect(page.locator('.lab-tracking-floating .lab-session-row')).toHaveCount(1);
  expect((await page.locator('.lab-tracking-floating .lab-session-row').boundingBox())!.width).toBeGreaterThan(150);
  await page.getByRole('button', { name: 'Close Tracked sessions', exact: true }).click();
  if (info.project.use.isMobile) await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  const rail = page.locator('#lab-context');
  await rail.getByRole('button', { name: 'Favorites', exact: true }).click();
  const filter = rail.getByRole('button', { name: 'Filter tracked favorites', exact: true });
  const all = rail.getByRole('button', { name: 'Show all favorites', exact: true });
  await expect(all).toHaveText('2 favorites');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(filter).toHaveText('1 tracked');
  const toolbar = rail.locator('.lab-favorites-toolbar');
  expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(rail.locator('[role="treeitem"]')).toHaveCount(1);
  await expect(rail.locator('[data-favorite-id="tracked"]')).toBeVisible();
  const nav = rail.getByRole('navigation', { name: 'Sidebar sections' });
  expect(await nav.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
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

test('reorders floating tracking rows without opening them, persists order, and opens the whole row', async ({ page }, info) => {
  if (info.project.use.isMobile) await page.setViewportSize({ width: 320, height: 740 });
  const stars = ['first', 'second', 'third'].map((id, order) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id,
    title: id === 'first' ? 'A long tracked session title that should fit the panel without horizontal scrolling' : id,
    starredAt: 1, favoriteId: id, folderId: null, order, available: true, online: true }));
  await page.addInitScript(stars => {
    const key = `agent-remote-tracking:${location.origin}/u/alice/`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(stars));
  }, stars);
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 1, folders: [], stars } }));
  await page.route('**/v1/session-migrations', route => route.fulfill({ json: { migrations: [] } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: route.request().postDataJSON().nativeSessionId } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?switching=1');
  const trigger = page.getByRole('button', { name: 'Tracked sessions', exact: true });
  await trigger.click();
  const panel = page.locator('.lab-tracking-floating .lab-session-popover-panel');
  const rows = panel.locator('.lab-tracked-row > button');
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem(`agent-remote-tracking:${location.origin}/u/alice/`)!).map((s: { nativeSessionId: string }) => s.nativeSessionId));
  await expect(rows).toHaveCount(3);
  const originalUrl = page.url();
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const origin = (await rows.nth(2).boundingBox())!, target = (await rows.first().boundingBox())!;
  // Mouse sorting works anywhere on the row, including its empty trailing area.
  await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 15, target.y + 5, { steps: 8 });
  await expect(panel.locator('[data-drop="before"]')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(saved).toEqual(['third', 'first', 'second']);
  await expect(panel).toBeVisible();
  expect(page.url()).toBe(originalUrl);
  await rows.first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(saved).toEqual(['first', 'third', 'second']);
  // Escape cancels a drag without reordering or dismissing the list.
  const cancelFrom = (await rows.first().boundingBox())!, cancelTo = (await rows.last().boundingBox())!;
  await page.mouse.move(cancelFrom.x + 20, cancelFrom.y + 15); await page.mouse.down();
  await page.mouse.move(cancelTo.x + 20, cancelTo.y + cancelTo.height - 5, { steps: 8 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(saved).toEqual(['first', 'third', 'second']);
  await expect(panel).toBeVisible();
  if (info.project.name === 'chromium-mobile') {
    const touchFrom = (await rows.last().locator('.lab-tracked-grip').boundingBox())!;
    const touchTo = (await rows.first().boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchFrom.x + touchFrom.width / 2, y: touchFrom.y + touchFrom.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchTo.x + 30, y: touchTo.y + 5 }] });
    await expect(panel.locator('[data-drop="before"]')).toHaveCount(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(saved).toEqual(['second', 'first', 'third']);
    await expect(panel).toBeVisible();
    await rows.first().focus(); await page.keyboard.press('Alt+ArrowDown'); await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(saved).toEqual(['first', 'third', 'second']);
    await cdp.detach();
  }
  // The fixture replaces its URL while mounting; revisit it to mount with persisted storage.
  await page.goto('/e2e/fixtures/session-stars.html?switching=1'); await trigger.click();
  await expect(rows.nth(1)).toContainText('third');
  await expect(rows.nth(2)).toContainText('second');
  await page.screenshot({ path: info.outputPath('tracked-rows.png'), animations: 'disabled' });
  const row = (await rows.nth(1).boundingBox())!;
  if (info.project.use.isMobile) await page.touchscreen.tap(row.x + row.width - 3, row.y + row.height / 2);
  else await page.mouse.click(row.x + row.width - 3, row.y + row.height / 2);
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/session=third/);
});
