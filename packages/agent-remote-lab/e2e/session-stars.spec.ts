import { expect, test } from '@playwright/test';

test('moves the tracking button without opening it and keeps the menu inside the viewport', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 740 });
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html');
  const button = page.getByRole('button', { name: 'Tracked sessions', exact: true });
  const initial = (await button.boundingBox())!;
  const viewport = page.viewportSize()!;
  if (testInfo.project.name.includes('mobile')) {
    const input = await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 45, y: viewport.height - 50 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await input.detach();
  } else {
    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    await page.mouse.down();
    await page.mouse.move(45, viewport.height - 50, { steps: 12 });
    await page.mouse.up();
  }
  const moved = (await button.boundingBox())!;
  expect(moved.y).toBeGreaterThan(initial.y + 100);
  expect(moved.x).toBeLessThan(60);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  const panel = page.locator('.lab-tracking-floating section');
  await expect(panel).toBeVisible();
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: testInfo.outputPath('tracking-moved.png') });
  await page.goto('/e2e/fixtures/session-stars.html');
  const restored = (await button.boundingBox())!;
  expect(Math.abs(restored.x - moved.x)).toBeLessThan(2);
  expect(Math.abs(restored.y - moved.y)).toBeLessThan(2);
  await page.setViewportSize({ width: 280, height: 400 });
  await expect.poll(async () => {
    const box = (await button.boundingBox())!;
    const bottom = await page.evaluate(() => visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight);
    return box.y + box.height <= bottom;
  }).toBe(true);
  await button.focus();
  const before = (await button.boundingBox())!;
  await button.press('ArrowUp');
  expect((await button.boundingBox())!.y).toBeLessThan(before.y);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('shares sidebar and title favorites while retaining only local activity tracking', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let stars: Record<string, unknown>[] = [{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks', starredAt: 1, available: true, online: true, hostName: 'Work Mac' }];
  await page.route('**/v1/stars', route => {
    const method = route.request().method();
    if (method === 'POST') stars = [...stars, { ...route.request().postDataJSON(), starredAt: 1, available: true, online: true, hostName: 'Work Mac' }];
    if (method === 'DELETE') stars = stars.filter(item => item.nativeSessionId !== route.request().postDataJSON().nativeSessionId);
    return route.fulfill({ json: { stars } });
  });
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: 'agent-1' } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/e2e/fixtures/session-stars.html');
  await expect(page.getByRole('region', { name: 'Opened sessions' })).toHaveCount(0);
  await expect(page.locator('.lab-primary-conversation .lab-conversation-status')).toHaveText('Working');
  await page.getByTestId('prompt-input').fill('Keep my draft');
  const title = page.getByRole('button', { name: 'Favorites', exact: true });
  if (mobile) await title.click();
  await page.getByRole('button', { name: 'Star Research notes', exact: true }).last().click();
  const favorites = mobile ? page.locator('.lab-title-favorites section') : page.locator('#lab-context [aria-label="Favorites"]');
  await expect(favorites.getByText('Research notes', { exact: true })).toBeVisible();
  await favorites.getByRole('button', { name: 'Track Research notes', exact: true }).click();
  if (mobile) { await page.getByRole('button', { name: 'Close Favorites', exact: true }).click(); await expect(title).toBeFocused(); }
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(page.locator('.lab-tracking-floating section')).not.toContainText('Research notes');
  await expect(page.locator('.lab-tracking-count')).toHaveText('0');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  if (mobile) await title.click();
  await favorites.getByRole('button', { name: 'Track Build checks', exact: true }).click();
  if (mobile) await page.getByRole('button', { name: 'Close Favorites', exact: true }).click();
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(page.locator('.lab-tracking-floating section')).toContainText('Ready');
  await expect(page.locator('.lab-tracking-count')).toHaveText('1');
  await expect(page.getByTestId('prompt-input')).toHaveValue('Keep my draft');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-activity', { detail: 'waiting' })));
  await expect(page.getByLabel('1 session status changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(page.locator('.lab-tracking-floating section')).toContainText('Waiting');
  await expect(page.getByLabel('1 session status changes', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('tracking.png') });
  await page.goto('/e2e/fixtures/session-stars.html');
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(page.locator('.lab-tracking-floating section')).toContainText('Build checks');
  await page.locator('.lab-tracking-floating section').getByRole('button', { name: 'Untrack Build checks', exact: true }).click();
  await expect(page.locator('.lab-tracking-floating section')).toContainText('current session');
  expect(stars).toHaveLength(2);
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  if (mobile) await title.click();
  await favorites.getByRole('button', { name: 'Unstar Research notes', exact: true }).last().click();
  await expect(favorites.locator('.lab-favorite-list')).not.toContainText('Research notes');
  expect(stars).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('favorites.png') });
});


test('uses consistent status colors for mobile titles and grouped tracking counts', async ({ page }, testInfo) => {
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: route.request().postDataJSON().nativeSessionId } }));
  await page.addInitScript(() => {
    const sessions = ['working-session', 'pending-session', 'idle-one', 'idle-two', 'recorded-session'].map(nativeSessionId => ({
      hostId: 'host', providerId: 'recorded', nativeSessionId, title: nativeSessionId, starredAt: 1,
    }));
    localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify(sessions));
  });
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.setViewportSize({ width: 320, height: 740 });
  for (const status of ['running', 'waiting', 'idle']) {
    await page.goto(`/e2e/fixtures/session-stars.html?status=${status}`);
    const counts = page.locator('.lab-tracking-counts');
    await expect(counts.locator('[data-session-status="idle"]')).toHaveText('4');
    for (const [agentId, activity] of [['working-session', 'running'], ['pending-session', 'waiting']]) {
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture-activity', { detail })), { agentId, status: activity });
    }
    await expect(counts.locator('.lab-tracking-count')).toHaveText(['1', '1', '2']);
    const colors: Record<string, string> = {};
    for (const activity of ['running', 'waiting', 'idle']) {
      colors[activity] = await counts.locator(`[data-session-status="${activity}"]`).evaluate(el => getComputedStyle(el).color);
    }
    expect(colors.running).toBe('rgb(35, 112, 73)');
    expect(colors.waiting).toBe('oklch(0.52 0.108 87)');
    expect(colors.idle).toBe('oklch(0.243 0.024 248.8)');
    if (mobile) {
      const title = page.locator('.lab-favorites-title');
      await expect(title).toHaveCSS('color', colors[status]!);
      const trigger = page.getByRole('button', { name: 'Favorites', exact: true });
      await trigger.hover();
      await expect(title).toHaveCSS('color', colors[status]!);
      await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(trigger).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await trigger.click();
      await expect(page.locator('.lab-title-favorites section')).toBeVisible();
      await page.getByRole('button', { name: 'Close Favorites', exact: true }).click();
      await expect(trigger).toBeFocused();
    }
    await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
    const panel = page.locator('.lab-tracking-floating section');
    for (const [title, activity] of [['working-session', 'running'], ['pending-session', 'waiting'], ['idle-one', 'idle'], ['idle-two', 'idle']] as const) {
      await expect(panel.locator('strong', { hasText: title })).toHaveCSS('color', colors[activity]!);
    }
    await expect(panel).not.toContainText('recorded-session');
    await page.screenshot({ path: testInfo.outputPath(`status-colors-${status}.png`) });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-activity', { detail: { agentId: 'working-session', status: 'idle' } })));
    await expect(counts.locator('[data-session-status="running"]')).toHaveCount(0);
    await expect(counts.locator('[data-session-status="idle"]')).toHaveText('3');
  }
});
