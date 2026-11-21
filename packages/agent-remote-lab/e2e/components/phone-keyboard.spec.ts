// Component projects: orchard-phone-chromium, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// The phone's keyboard and screen geometry on the real Window-mode Workbench (the session-stars fixture mounts the whole App on a stubbed
// transport). A phone browser reports the keyboard through the visual viewport; the page has no keyboard to open, so each test replaces
// `visualViewport` by an object it drives, as the decision of the hooks (`useVisualViewport`, `useComposerKeyboardDismiss`) is unit
// tested and what a real browser decides is the layout those decisions produce.
const fixture = '/e2e/fixtures/session-stars.html?switching&control';

async function openConversation(page: Page, size = { width: 390, height: 844 }, standalone = false) {
  await page.setViewportSize(size);
  await page.addInitScript(({ size, standalone }) => {
    if (standalone) Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    const viewport = Object.assign(new EventTarget(), { width: size.width, height: size.height, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  }, { size, standalone });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto(fixture);
  const input = page.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  return input;
}

/** The keyboard takes the lower part of the screen: the visual viewport shrinks and the browser pans it down. */
const raiseKeyboard = (page: Page, bounds: { height: number; offsetTop: number }, resizeWindow = false) => page.evaluate(({ bounds, resizeWindow }) => {
  Object.assign(window.visualViewport!, bounds);
  if (resizeWindow) {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: bounds.height });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: bounds.height });
    window.dispatchEvent(new Event('resize'));
  }
  window.visualViewport!.dispatchEvent(new Event('resize'));
}, { bounds, resizeWindow });

const lowerKeyboard = (page: Page, height = 844) => page.evaluate(height => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
  Object.assign(window.visualViewport!, { height, offsetTop: 0 });
  window.visualViewport!.dispatchEvent(new Event('resize'));
}, height);

const draftOf = (page: Page) => page.getByTestId('prompt-input').evaluate(element => element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText.replace(/\n$/, ''));

for (const resizeWindow of [false, true]) {
  test(`with the keyboard up the conversation and the composer fit the visible area, and the tab bar returns when it closes (${resizeWindow ? 'resized window' : 'visual viewport only'})`, async ({ page }, info) => {
    const input = await openConversation(page, { width: 390, height: 844 }, resizeWindow);
    const shell = page.locator('.lab-shell');
    const tabs = page.locator('.lab-tab-bar');
    await input.fill('Keep my draft');
    await input.focus();
    const resting = (await shell.boundingBox())!;
    await expect(tabs).toBeVisible();
    for (const bounds of [{ height: 400, offsetTop: 20 }, { height: 340, offsetTop: 80 }]) {
      await raiseKeyboard(page, bounds, resizeWindow);
      await expect(shell).toHaveAttribute('data-viewport-occluded', 'true');
      await expect.poll(async () => (await shell.boundingBox())!.height).toBe(bounds.height);
      const area = { top: bounds.offsetTop, bottom: bounds.offsetTop + bounds.height };
      const capsule = (await page.locator('.lab-composer-dock .agent-composer').first().boundingBox())!;
      // The capsule rests just above the keyboard: its gap is the dock's own padding, not the home-indicator inset.
      expect(area.bottom - (capsule.y + capsule.height)).toBeGreaterThanOrEqual(4);
      expect(area.bottom - (capsule.y + capsule.height)).toBeLessThanOrEqual(8);
      const timeline = (await page.getByTestId('timeline').boundingBox())!;
      expect(timeline.y + timeline.height).toBeLessThanOrEqual(capsule.y + 1);
      expect(timeline.y).toBeGreaterThanOrEqual(area.top);
      // The tab bar steps aside, so the keyboard never has it above its keys.
      await expect(tabs).toBeHidden();
      await expect(input).toBeFocused();
      expect(await draftOf(page)).toBe('Keep my draft');
    }
    await page.screenshot({ path: info.outputPath('keyboard-up.png') });
    await lowerKeyboard(page);
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
    // Unoccluded, the shell follows the browser's own viewport units and carries no pixel override.
    await expect(shell).not.toHaveAttribute('style', /--lab-viewport-height/);
    await expect(tabs).toBeVisible();
    await expect.poll(async () => (await shell.boundingBox())!.height).toBeCloseTo(resting.height, 1);
    expect(await draftOf(page)).toBe('Keep my draft');
  });
}

test('the home-indicator inset stays with the tab bar and is gone from the composer above the keyboard', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'Safe-area insets are emulated through Chromium CDP.');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
  const input = await openConversation(page);
  const tabs = page.locator('.lab-tab-bar');
  const shell = page.locator('.lab-shell');
  // The tab bar sits on the home indicator, so the composer above it needs none.
  const tabsBox = (await tabs.boundingBox())!;
  expect(tabsBox.y + tabsBox.height).toBe(844);
  expect(tabsBox.height).toBeGreaterThanOrEqual(44 + 34);
  await expect(page.locator('.lab-composer-dock')).toHaveCSS('padding-bottom', '6px');
  await input.focus();
  await raiseKeyboard(page, { height: 400, offsetTop: 20 });
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'true');
  await expect(page.locator('.lab-composer-dock')).toHaveCSS('padding-bottom', '6px');
  await lowerKeyboard(page);
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
  await expect(tabs).toBeVisible();
  const restored = (await tabs.boundingBox())!;
  expect(restored.y + restored.height).toBe(844);
  expect(restored.height).toBe(tabsBox.height);
  await cdp.detach();
});

for (const first of ['window', 'visualViewport'] as const) {
  test(`rotating with the keyboard up keeps its bounds until both the window and the visual viewport follow (${first} first)`, async ({ page }) => {
    const input = await openConversation(page, { width: 844, height: 390 });
    await input.fill('Keep the keyboard and draft while rotating');
    await input.focus();
    const shell = page.locator('.lab-shell');
    const capsule = page.locator('.lab-composer-dock .agent-composer').first();
    await raiseKeyboard(page, { height: 200, offsetTop: 0 });
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'true');
    const rotateViewport = () => page.evaluate(() => {
      Object.assign(window.visualViewport!, { width: 390, height: 500 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    const settle = () => page.evaluate(() => { window.dispatchEvent(new Event('orientationchange')); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    if (first === 'window') await page.setViewportSize({ width: 390, height: 844 }); else await rotateViewport();
    await settle();
    // One side of the rotation has arrived: the stale portrait height is not a keyboard, and the landscape one is not a screen.
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'true');
    expect((await shell.boundingBox())!.height).toBe(200);
    if (first === 'window') await rotateViewport(); else await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await shell.boundingBox())!.height).toBe(500);
    const box = (await capsule.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(500);
    await expect(input).toBeFocused();
    expect(await draftOf(page)).toBe('Keep the keyboard and draft while rotating');
  });
}

test('rotating a screen without a keyboard follows each size, whether or not a field has focus and however late the viewport reports it', async ({ page }) => {
  // The viewport hook samples again 120 ms to 2.5 s after each event; the page's clock runs those samples out before each look.
  await page.clock.install();
  const settle = () => page.clock.runFor(3000);
  const input = await openConversation(page, { width: 844, height: 390 }, true);
  await input.fill('Keep this draft and its position');
  const shell = page.locator('.lab-shell');
  for (const focused of [false, true]) {
    if (focused) await input.focus(); else await input.blur();
    await settle();
    for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.evaluate(({ width, height }) => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
        Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
        Object.assign(window.visualViewport!, { width, height });
        window.dispatchEvent(new Event('orientationchange'));
        window.visualViewport!.dispatchEvent(new Event('resize'));
      }, size);
      await settle();
      await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
      // A phone's tab bar stands under the shell; a landscape screen is wide enough for the rail instead.
      await expect.poll(() => page.evaluate(() => {
        const bar = document.querySelector('.lab-tab-bar')?.getBoundingClientRect();
        return Math.round(document.querySelector('.lab-shell')!.getBoundingClientRect().height + (bar && bar.height > 0 ? bar.height : 0));
      })).toBe(size.height);
    }
    // Late, fractional samples after the rotation settle change nothing.
    const sample = () => page.evaluate(() => { const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect(); return { shell: rect('.lab-shell').height, composer: rect('.lab-composer-dock').top, timeline: rect('[data-testid="timeline"]').height }; });
    await settle();
    const settled = await sample();
    for (const [height, offsetTop] of [[842.5, 1.5], [841, 3], [844, 0]]) {
      await page.evaluate(({ height, offsetTop }) => {
        Object.assign(window.visualViewport!, { height, offsetTop });
        window.visualViewport!.dispatchEvent(new Event('resize'));
        window.visualViewport!.dispatchEvent(new Event('scroll'));
      }, { height, offsetTop });
      await settle();
      expect(await sample()).toEqual(settled);
    }
  }
});
