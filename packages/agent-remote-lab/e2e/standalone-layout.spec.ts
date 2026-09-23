import { expect, test } from '@playwright/test';

test('serves the edge-to-edge Home Screen configuration', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
});

test('reserves the notch once above navigation and keeps controls inside each rotated safe area', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium' || !info.project.use.isMobile, 'Uses native CSS safe-area emulation through CDP.');
  const cdp = await page.context().newCDPSession(page);
  await page.setViewportSize({ width: 402, height: 874 });
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 62, bottom: 34, left: 0, right: 0 } });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
  const navigation = page.getByRole('navigation', { name: 'Session navigation' });
  await expect(navigation).toHaveCSS('padding-top', '62px');
  await expect(navigation).toHaveCSS('position', 'sticky');
  await expect(page.locator('.lab-shell')).toHaveCSS('top', '0px');
  expect((await page.getByRole('button', { name: 'Open sessions', exact: true }).boundingBox())!.y).toBe(62);
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Header', exact: true }).check();
  const header = page.locator('.lab-app-bar');
  await expect(header).toHaveCSS('padding-top', '0px');
  const navBounds = (await navigation.boundingBox())!;
  expect((await header.boundingBox())!.y).toBeCloseTo(navBounds.y + navBounds.height, 1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  const sidebar = page.getByRole('dialog', { name: 'Context', exact: true });
  expect((await sidebar.locator('.lab-rail-close').boundingBox())!.y).toBeGreaterThanOrEqual(62);
  await sidebar.locator('.lab-rail-close').click();
  for (const portrait of [false, true, false, true]) {
    const size = portrait ? { width: 402, height: 874 } : { width: 874, height: 402 };
    const insets = portrait ? { top: 62, bottom: 34, left: 0, right: 0 } : { top: 0, bottom: 20, left: 62, right: 62 };
    await page.setViewportSize(size);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    await expect(navigation).toHaveCSS('padding-top', `${insets.top}px`);
    await expect(header).toHaveCSS('padding-top', '0px');
    const sessions = (await page.getByRole('button', { name: 'Open sessions', exact: true }).boundingBox())!;
    expect(sessions.y).toBe(insets.top);
    expect(sessions.x).toBeGreaterThanOrEqual(insets.left);
    const composer = (await page.locator('.lab-composer-dock').first().boundingBox())!;
    expect(composer.y + composer.height).toBeCloseTo(size.height, 1);
    const send = (await page.getByTestId('prompt-submit').boundingBox())!;
    expect(send.y + send.height).toBeLessThanOrEqual(size.height - insets.bottom);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('portrait-safe-area.png') });
});

// Replay the contradictory launch measurements; desktop WebKit cannot reproduce
// the native Home Screen window or its system scroll-edge effect.
test('fills the standalone launch gap and hands sizing back after native recovery', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium' || !info.project.use.isMobile, 'Uses CSS safe-area emulation through CDP.');
  await page.setViewportSize({ width: 402, height: 812 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 62, bottom: 34, left: 0, right: 0 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/27.0 Mobile Safari/604.1' });
    Object.defineProperty(screen, 'width', { configurable: true, value: 402 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 874 });
  });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
  const shell = page.locator('.lab-shell');
  const dock = page.locator('.lab-composer-dock').first();
  await expect(shell).toHaveCSS('height', '874px');
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
  const before = (await dock.boundingBox())!;
  expect(before.y + before.height).toBeCloseTo(874, 1);
  const frame = (await page.locator('.lab-composer-dock .agent-composer').first().boundingBox())!;
  expect(before.y + before.height - frame.y - frame.height).toBeCloseTo(40, 1);
  await page.setViewportSize({ width: 402, height: 874 });
  await expect.poll(() => shell.evaluate(el => el.style.getPropertyValue('--lab-viewport-height'))).toBe('');
  const after = (await dock.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 1);
  await expect(page.getByRole('navigation', { name: 'Session navigation' })).toHaveCSS('filter', 'none');
  // An independent sticky navigation layer must keep both menus usable.
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Scan to open', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Favorites', exact: true }).click();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Header', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Context', exact: true }).locator('.lab-rail-close').click();
});
