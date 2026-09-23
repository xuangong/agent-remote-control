import { expect, test } from '@playwright/test';

test.beforeEach(async ({}, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Mobile keyboard layout.');
});

for (const recovery of ['delayed-viewport', 'window-first'] as const) {
  test(`keeps the conversation and draft above the keyboard after foreground recovery (${recovery})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
      const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('A draft kept while switching apps');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.evaluate((recovery) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      // Model late, silent native geometry updates after standalone restoration.
      window.setTimeout(() => {
        if (recovery === 'delayed-viewport') {
          Object.assign(window.visualViewport!, { height: 400, offsetTop: 20 });
        } else {
          Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
          window.dispatchEvent(new Event('resize'));
        }
      }, 1100);
    }, recovery);
    const bottom = recovery === 'delayed-viewport' ? 420 : 400;
    await expect.poll(async () => {
      const bounds = (await page.getByTestId('prompt-submit').boundingBox())!;
      return bounds.y + bounds.height;
    }).toBeLessThanOrEqual(bottom);
    await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'true');
    const timeline = (await page.getByTestId('timeline').boundingBox())!;
    const composer = (await page.locator('.lab-composer-dock').boundingBox())!;
    expect(timeline.y + timeline.height).toBeLessThanOrEqual(composer.y + 1);
    expect(composer.y + composer.height).toBeLessThanOrEqual(bottom);
    expect(composer.y).toBeGreaterThan(0);
    await expect(input).toHaveValue('A draft kept while switching apps');
    await expect(input).toBeFocused();
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'false');
    await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBe(844);
    await expect(input).toHaveValue('A draft kept while switching apps');
  });
}

for (const first of ['window', 'visualViewport'] as const) {
  test(`rotates to portrait without a second conversation resize (${first} first)`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { width: 844, height: 390, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('A draft kept through rotation');
    await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBe(390);
    const rotateVisualViewport = () => page.evaluate(() => {
      Object.assign(window.visualViewport!, { width: 390, height: 844 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    if (first === 'visualViewport') {
      await rotateVisualViewport();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect((await page.locator('.lab-shell').boundingBox())!.height).toBe(390);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    // Allow the resize observer and viewport hook to run, but keep the native
    // visual viewport stale until after measuring the intermediate layout.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const shell = page.locator('.lab-shell');
    expect((await shell.boundingBox())!.height).toBe(844);
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
    const before = (await page.getByTestId('prompt-submit').boundingBox())!;
    if (first === 'window') await rotateVisualViewport();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = (await page.getByTestId('prompt-submit').boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    expect(after.y + after.height).toBeLessThanOrEqual(844);
    await expect(input).toHaveValue('A draft kept through rotation');
  });
}
