// Component projects: webkit-mobile-viewport
import { expect, test, type Page } from '@playwright/test';

type Insets = { top: number; bottom: number; left: number; right: number };

/**
 * Measures the shell in one page evaluation, so the tab bar cannot re-render between two reads, and lists what is not yet inside
 * the safe area. Poll it until it is empty: a rotation settles over a few frames.
 */
function settledLayoutProblems(page: Page, size: { width: number; height: number }, insets: Insets) {
  return page.evaluate(({ size, insets }) => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box && box.width > 0 && box.height > 0 ? box : undefined;
    };
    const sessions = rect('button[aria-label="Open sessions"]');
    const composer = rect('.lab-composer-dock');
    const bar = rect('.lab-tab-bar');
    const send = rect('[data-testid="prompt-submit"]');
    const problems: string[] = [];
    if (!sessions || !composer || !send) return ['the sessions button, the composer or the send button is not laid out'];
    if (sessions.y !== insets.top) problems.push(`sessions button y ${sessions.y}, expected ${insets.top}`);
    if (sessions.x < insets.left) problems.push(`sessions button x ${sessions.x} is left of the inset ${insets.left}`);
    if (bar && Math.abs(bar.bottom - size.height) >= 0.05) problems.push(`tab bar bottom ${bar.bottom}, expected ${size.height}`);
    const floor = bar ? bar.y : size.height;
    if (Math.abs(composer.bottom - floor) >= 0.05) problems.push(`composer bottom ${composer.bottom}, expected ${floor}`);
    if (send.bottom > size.height - insets.bottom) problems.push(`send button bottom ${send.bottom} is under the bottom inset`);
    return problems;
  }, { size, insets });
}

test('serves browser-owned safe areas with the non-overlay Home Screen status bar', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=contain/);
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
    // A phone's tab bar stands under the composer (and under the home indicator); a wide screen has the rail instead.
    await expect.poll(() => settledLayoutProblems(page, size, insets), { message: 'the layout settles inside the rotated safe area' }).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('portrait-safe-area.png') });
});

// Replay the contradictory launch measurements; desktop WebKit cannot reproduce
// the native Home Screen window or its system scroll-edge effect.
test('keeps composer controls inside the standalone viewport before native recovery', async ({ page, browserName }, info) => {
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
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
  const expectVisibleComposer = async () => {
    const viewportBottom = await page.evaluate(() => visualViewport!.offsetTop + visualViewport!.height);
    await expect.poll(async () => {
      const send = (await page.getByTestId('prompt-submit').boundingBox())!;
      return send.y + send.height;
    }).toBeLessThanOrEqual(viewportBottom);
    // One evaluation per poll, so the tab bar cannot re-render between the reads.
    await expect.poll(() => page.evaluate(viewportBottom => {
      const box = (selector: string) => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect && rect.width > 0 && rect.height > 0 ? rect : undefined; };
      const frame = box('.lab-composer-dock .agent-composer'), dock = box('.lab-composer-dock'), bar = box('.lab-tab-bar');
      if (!frame || !dock) return ['the composer is not laid out'];
      const problems: string[] = [];
      if (frame.y < 0) problems.push(`composer frame y ${frame.y} is above the viewport`);
      if (frame.bottom > viewportBottom - 34) problems.push(`composer frame bottom ${frame.bottom} is under the bottom inset`);
      const floor = bar ? bar.y : viewportBottom;
      if (Math.abs(dock.bottom - floor) >= 0.05) problems.push(`composer dock bottom ${dock.bottom}, expected ${floor}`);
      return problems;
    }, viewportBottom)).toEqual([]);
  };
  await expectVisibleComposer();
  const before = (await dock.boundingBox())!;
  await page.screenshot({ path: info.outputPath('standalone-launch-composer.png') });
  await page.setViewportSize({ width: 402, height: 874 });
  // The shell fills the viewport above the phone's tab bar.
  const barHeight = (await page.locator('.lab-tab-bar').boundingBox())!.height;
  await expect(shell).toHaveCSS('height', `${874 - barHeight}px`);
  await expectVisibleComposer();
  const after = (await dock.boundingBox())!;
  expect(after.y - before.y).toBeCloseTo(62, 1);
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

test('serves a standalone manifest and touch icons', async ({ page, request }) => {
  await page.goto('/');
  const manifest = await request.get('/app/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const value = await manifest.json();
  expect(value.display).toBe('standalone');
  expect(value.start_url).toBe('/');
  for (const icon of value.icons) {
    const response = await request.get(icon.src);
    expect(response.headers()['content-type']).toContain('image/png');
    expect(response.ok()).toBe(true);
  }
});
