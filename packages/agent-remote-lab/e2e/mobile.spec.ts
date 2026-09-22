import { expect, test, type Page } from '@playwright/test';
import { toggleViewPanel } from './view-options';

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile', 'Touch layout acceptance.');
});

async function openSession(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByTestId('session-create').click();
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
}

test('keeps status readable and composer actions in one row on a small phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openSession(page);
  await expect(page.locator('.lab-app-bar')).toBeHidden();
  await toggleViewPanel(page, 'Header');
  await expect(page.getByTestId('connection-summary').getByText('Ready', { exact: true })).toBeVisible();
  const commands = (await page.getByRole('button', { name: 'Open chat commands' }).boundingBox())!;
  const send = (await page.getByTestId('prompt-submit').boundingBox())!;
  expect(send.y).toBe(commands.y);
  expect(send.x + send.width).toBeLessThanOrEqual(320);
  expect(send.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('session-model-button').tap();
  await expect(page.getByRole('region', { name: 'Model settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close session controls' }).tap();
  await page.getByTestId('prompt-input').fill('A phone message');
  await page.getByTestId('prompt-submit').tap();
  await expect(page.locator('.agent-message-assistant').last()).toContainText('A phone message');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath('phone-chat.png') });
});

test('uses one chat viewport in landscape and returns to the retained source draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openSession(page);
  const historyLength = await page.evaluate(() => history.length);
  const primary = page.locator('.lab-primary-conversation');
  await primary.getByTestId('prompt-input').fill('/side');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.getByTestId('prompt-input')).toBeEnabled();
  await expect(primary).toBeHidden();
  expect((await side.boundingBox())!.width).toBe(844);
  await expect(page.getByRole('combobox', { name: 'Side path' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 0 });
  await expect(primary).toBeVisible();
  await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 1 });
  await expect(side).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  const input = side.getByTestId('prompt-input');
  await input.fill('Side draft on phone');
  const send = (await side.getByTestId('prompt-submit').boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(390);
  await side.getByRole('button', { name: 'Close side conversation' }).tap();
  await expect(primary).toBeVisible();
  await primary.getByTestId('prompt-input').fill('Source draft on phone');
  await primary.getByRole('navigation', { name: 'Forked sessions' }).getByRole('button').tap();
  await expect(side.getByTestId('prompt-input')).toHaveValue('Side draft on phone');
  await page.screenshot({ path: testInfo.outputPath('landscape-side.png') });
  await side.getByRole('button', { name: 'Close side conversation' }).tap();
  await expect(primary.getByTestId('prompt-input')).toHaveValue('Source draft on phone');
});

test('keeps the composer and command menu inside a contracted visual viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await openSession(page);
  await page.getByTestId('prompt-input').fill('/');
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 400, offsetTop: 20 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const bounds = (await page.getByTestId('prompt-submit').boundingBox())!;
    return bounds.y + bounds.height;
  }).toBeLessThanOrEqual(420);
  const menu = (await page.getByRole('listbox', { name: 'Native commands' }).boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(20);
  await page.screenshot({ path: testInfo.outputPath('contracted-viewport.png') });
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 200, offsetTop: 40, scale: 2 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  expect((await page.locator('.lab-shell').boundingBox())!.height).toBe(400);
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 844, offsetTop: 0, scale: 1 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBe(844);
  await expect(page.getByTestId('prompt-input')).toHaveValue('/');
});

test('keeps drawer dismissal reachable after scrolling and preserves the chat draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSession(page);
  await page.getByTestId('prompt-input').fill('Retain my phone draft');
  await page.getByRole('button', { name: 'Open sessions', exact: true }).tap();
  const drawer = page.getByRole('dialog', { name: 'Context', exact: true });
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox())!.width).toBe(390);
  await expect(drawer.getByTestId('session-create')).toBeHidden();
  await expect(drawer.getByRole('button', { name: 'Pair Agent Host', exact: true })).toBeHidden();
  await expect(drawer.getByRole('searchbox')).toBeVisible();
  await drawer.getByRole('searchbox').fill('no-matching-session-xyz');
  await expect(drawer.locator('.lab-session-row')).toHaveCount(0);
  await expect(drawer.getByText('No matching loaded sessions.')).toBeVisible();
  await drawer.getByRole('searchbox').fill('');
  await expect(drawer.locator('.lab-session-row').first()).toBeVisible();
  await drawer.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const close = drawer.getByRole('button', { name: 'Close Context', exact: true });
  const bounds = (await close.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThan(80);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath('phone-drawer.png') });
  await close.tap();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('prompt-input')).toHaveValue('Retain my phone draft');
});


test('recovers a draft after reload and returns through discovery', async ({ page }) => {
  await openSession(page);
  const historyLength = await page.evaluate(() => history.length);
  const sessionUrl = page.url();
  await page.getByTestId('prompt-input').fill('Recover after an accidental leave');
  await page.reload();
  await expect(page.getByTestId('prompt-input')).toHaveValue('Recover after an accidental leave');
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.getByRole('button', { name: 'Open sessions' }).tap();
  await page.getByRole('button', { name: 'New session', exact: true }).tap();
  await page.getByTestId('session-create').click();
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
  await expect(page.getByTestId('prompt-input')).toHaveValue('');
  expect(page.url()).not.toBe(sessionUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await page.getByRole('button', { name: 'Open sessions' }).tap();
  const discovery = page.getByRole('region', { name: 'Discover sessions', exact: true });
  await discovery.getByRole('button', { name: 'Refresh', exact: true }).click();
  const identity = JSON.stringify(['local', 'recorded', new URL(sessionUrl).searchParams.get('session')]);
  await discovery.locator(`[data-session-key=${JSON.stringify(identity)}] > .lab-session-branch > .lab-session-row`).click();
  await expect(page.getByTestId('prompt-input')).toHaveValue('Recover after an accidental leave');
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


test('restores the reading anchor after reload instead of jumping to latest', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await openSession(page);
  const timeline = page.getByTestId('timeline');
  await timeline.focus();
  await timeline.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }));
    element.scrollTop = 120;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(120);
  const before = await timeline.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const entry = [...element.querySelectorAll<HTMLElement>('[data-entry-key]')].find((item) => item.getBoundingClientRect().bottom > top)!;
    return { key: entry.dataset.entryKey, offset: entry.getBoundingClientRect().top - top };
  });
  await page.reload();
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  await expect.poll(() => timeline.evaluate((element, key) => {
    const entry = [...element.querySelectorAll<HTMLElement>('[data-entry-key]')].find((item) => item.dataset.entryKey === key);
    return entry ? entry.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
  }, before.key)).toBeCloseTo(before.offset, 0);
});

for (const width of [320, 390]) {
  test(`keeps Settings and pairing controls within a ${width}px phone`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 740 });
    await openSession(page);
    await page.route('**/v1/remote/hosts', route => route.fulfill({ json: { hosts: [{
      id: 'phone-host', name: 'DevelopmentWorkstationWithAnUnbrokenName0123456789abcdef0123456789',
      online: true, managed: true, access: 'owner', credentialRotation: true,
      providers: [{ providerId: 'codex', displayName: 'Codex' }],
    }] } }));
    await page.getByRole('button', { name: 'Open sessions', exact: true }).tap();
    const drawer = page.getByRole('dialog', { name: 'Context', exact: true });
    await drawer.getByRole('button', { name: 'Settings', exact: true }).tap();
    await drawer.getByRole('button', { name: 'Retry Hosts', exact: true }).tap();
    await expect(drawer.locator('#remote-host option')).toContainText(['Select a Host', 'DevelopmentWorkstation']);
    await drawer.getByRole('combobox', { name: 'Connected Host' }).selectOption('phone-host');
    await drawer.getByRole('button', { name: 'Rotate credential', exact: true }).tap();
    await page.route('**/v1/remote/pairings', route => route.fulfill({ json: {
      key: 'arc_test_' + 'x'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(),
      serverUrl: 'https://agents.example.test', command: 'AGENT_HOST_REMOTE_KEY=arc_test_' + 'x'.repeat(64) + ' agent-remote-controller start',
    } }));
    await drawer.getByRole('button', { name: 'Pair Agent Host', exact: true }).tap();
    await drawer.getByRole('button', { name: 'Generate pairing key', exact: true }).tap();
    await expect(drawer.getByRole('textbox', { name: 'Agent Host configuration' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('settings-pairing.png') });
    expect(await drawer.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const controls = await drawer.locator('button:visible, select:visible, textarea:visible').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right };
    }));
    for (const bounds of controls) { expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); }
  });
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Open sessions', exact: true }).tap();
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  return page.getByRole('region', { name: 'Controller settings', exact: true });
}

test('enters and exits browser fullscreen while preserving the current conversation', async ({ page }, testInfo) => {
  await openSession(page);
  await page.getByTestId('prompt-input').fill('Keep this fullscreen draft');
  const settings = await openSettings(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-display-settings.png') });
  await settings.getByRole('button', { name: 'Enter full screen', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  await expect(settings.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Context', exact: true }).tap();
  await expect(page.getByTestId('prompt-input')).toHaveValue('Keep this fullscreen draft');
  await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBe(await page.evaluate(() => visualViewport!.height));
  await openSettings(page);
  await settings.getByRole('button', { name: 'Exit full screen', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(settings.getByRole('button', { name: 'Enter full screen', exact: true })).toBeVisible();
});

test('explains unsupported fullscreen and keeps Settings usable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true }); });
  await openSession(page);
  const settings = await openSettings(page);
  await expect(settings.getByRole('button', { name: 'Enter full screen' })).toHaveCount(0);
  await expect(settings).toContainText('This browser does not support page full screen.');
  await settings.getByText('Open without the address bar', { exact: true }).tap();
  await expect(settings.getByText(/On iPhone/)).toBeVisible();
  await expect(settings).toContainText('Add to Home Screen');
});

test('reports fullscreen rejection without claiming success or losing the draft', async ({ page }) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = async () => { throw new Error('Denied'); };
  });
  await openSession(page);
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Enter full screen', exact: true }).tap();
  await expect(settings.getByRole('alert')).toContainText('Full screen could not be changed');
  await expect(settings.getByRole('button', { name: 'Enter full screen', exact: true })).toBeEnabled();
});


test('recognizes a Home Screen launch without offering redundant fullscreen controls', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
  await openSession(page);
  const settings = await openSettings(page);
  await expect(settings).toContainText('Opened from your Home Screen');
  await expect(settings.getByRole('button', { name: 'Enter full screen' })).toHaveCount(0);
  await expect(settings.getByText('Open without the address bar')).toHaveCount(0);
});


for (const resizesWindow of [false, true]) test(`removes the home-indicator inset above the keyboard and restores it after dismissal (${resizesWindow ? 'resized window' : 'visual viewport only'})`, async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
  await page.addInitScript(resizesWindow => {
    if (resizesWindow) Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  }, resizesWindow);
  await openSession(page);
  const pane = page.locator('.lab-primary-conversation');
  const shell = page.locator('.lab-shell');
  const dock = pane.locator('.lab-composer-dock');
  const input = pane.getByTestId('prompt-input');
  const gap = () => dock.locator('.agent-composer').evaluate(composer => {
    const bounds = composer.getBoundingClientRect();
    return visualViewport!.offsetTop + visualViewport!.height - bounds.bottom;
  });
  await input.fill('Keep my draft');
  await expect(dock).toHaveCSS('padding-bottom', '40px');
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
  for (const bounds of [{ height: 400, offsetTop: 20 }, { height: 340, offsetTop: 80 }]) {
    await page.evaluate(({ bounds, resizesWindow }) => {
      Object.assign(window.visualViewport!, bounds);
      if (resizesWindow) {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: bounds.height });
        Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: bounds.height });
        window.dispatchEvent(new Event('resize'));
      }
      window.visualViewport!.dispatchEvent(new Event('resize'));
    }, { bounds, resizesWindow });
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'true');
    await expect.poll(gap).toBeLessThanOrEqual(8);
    await expect.poll(gap).toBeGreaterThanOrEqual(4);
  }
  await page.screenshot({ path: testInfo.outputPath('keyboard-composer-spacing.png') });
  await pane.getByRole('button', { name: 'Hide message input', exact: true }).click();
  const show = pane.getByRole('button', { name: 'Show message input', exact: true });
  await expect.poll(async () => {
    const bounds = (await show.boundingBox())!;
    return 420 - bounds.y - bounds.height;
  }).toBeLessThanOrEqual(1);
  await show.click();
  await expect(input).toHaveValue('Keep my draft');
  await page.evaluate(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 844 });
    Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
  await expect(dock).toHaveCSS('padding-bottom', '40px');
  await expect(input).toHaveValue('Keep my draft');
  await input.focus();
  await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
  await expect(dock).toHaveCSS('padding-bottom', '40px');
  // A rotation must not reuse the taller portrait reference as a keyboard.
  for (const size of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.evaluate(({ height }) => {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
      Object.assign(window.visualViewport!, { height, offsetTop: 0 });
      window.dispatchEvent(new Event('orientationchange'));
      window.visualViewport!.dispatchEvent(new Event('resize'));
    }, size);
    await expect(shell).toHaveCSS('--lab-viewport-height', `${size.height}px`);
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
    await expect(dock).toHaveCSS('padding-bottom', '40px');
  }
  await cdp.detach();
});
