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
    await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBeCloseTo(844, 1);
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
    await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBeCloseTo(390, 1);
    const rotateVisualViewport = () => page.evaluate(() => {
      Object.assign(window.visualViewport!, { width: 390, height: 844 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    if (first === 'visualViewport') {
      await rotateVisualViewport();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect((await page.locator('.lab-shell').boundingBox())!.height).toBeCloseTo(390, 1);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    // Allow the resize observer and viewport hook to run, but keep the native
    // visual viewport stale until after measuring the intermediate layout.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const shell = page.locator('.lab-shell');
    expect((await shell.boundingBox())!.height).toBeCloseTo(844, 1);
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

for (const focused of [false, true]) {
  test(`keeps settled portrait content stable through late viewport samples (focused=${focused})`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
      const viewport = Object.assign(new EventTarget(), { width: 844, height: 390, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('Keep this draft and its position');
    if (!focused) await input.blur();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { width: 390, height: 844 });
      window.dispatchEvent(new Event('orientationchange'));
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBeCloseTo(844, 1);
    const samples = await page.evaluate(async () => {
      const result: Array<{ top: number; height: number; composerTop: number; timelineHeight: number }> = [];
      const sample = () => {
        const shell = document.querySelector('.lab-shell')!.getBoundingClientRect();
        const composer = document.querySelector('.lab-composer-dock')!.getBoundingClientRect();
        const timeline = document.querySelector('[data-testid="timeline"]')!.getBoundingClientRect();
        result.push({ top: shell.top, height: shell.height, composerTop: composer.top, timelineHeight: timeline.height });
      };
      sample();
      // Native viewport measurements can settle after the CSS viewport has rotated.
      // No keyboard is present, including when an editor retains focus.
      for (const [height, offsetTop] of [[842.5, 1.5], [841, 3], [844, 0]]) {
        Object.assign(window.visualViewport!, { height, offsetTop });
        window.visualViewport!.dispatchEvent(new Event('resize'));
        window.visualViewport!.dispatchEvent(new Event('scroll'));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        sample();
      }
      return result;
    });
    expect(samples.slice(1)).toEqual(samples.slice(1).map(() => samples[0]));
    await expect(input).toHaveValue('Keep this draft and its position');
  });
}

for (const first of ['window', 'visualViewport'] as const) {
  test(`preserves keyboard bounds and bottom inset throughout rotation (${first} first)`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { width: 844, height: 390, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await page.goto('/');
    // Mobile browser emulation has no hardware safe area. Supply the inherited
    // inset and let the production keyboard selector suppress it normally.
    await page.addStyleTag({ content: ':root { --lab-composer-bottom-inset: 34px; }' });
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('Keep the keyboard and draft while rotating');
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 200 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    const shell = page.locator('.lab-shell');
    const composer = page.locator('.lab-composer-dock');
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'true');
    const padding = await composer.evaluate(el => getComputedStyle(el).paddingBottom);
    const rotateViewport = () => page.evaluate(() => {
      Object.assign(window.visualViewport!, { width: 390, height: 500 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    if (first === 'window') await page.setViewportSize({ width: 390, height: 844 });
    else await rotateViewport();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('orientationchange'));
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'true');
    expect((await shell.boundingBox())!.height).toBe(200);
    expect(await composer.evaluate(el => getComputedStyle(el).paddingBottom)).toBe(padding);
    if (first === 'window') await rotateViewport();
    else await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await shell.boundingBox())!.height).toBe(500);
    expect(await composer.evaluate(el => getComputedStyle(el).paddingBottom)).toBe(padding);
    const button = (await page.getByTestId('prompt-submit').boundingBox())!;
    expect(button.y + button.height).toBeLessThanOrEqual(500);
    await expect(input).toHaveValue('Keep the keyboard and draft while rotating');
    await expect(input).toBeFocused();
  });
}

for (const reading of [false, true]) {
  test(`positions reflowed long content before the first portrait animation frame (reading=${reading})`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/e2e/fixtures/markdown-reading.html?cached=1');
    const timeline = page.getByTestId('timeline');
    const paragraph = page.locator('.agent-markdown p').filter({ hasText: /^Paragraph 10\./ });
    await expect(paragraph).toBeAttached();
    await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(1);
    if (reading) {
      await timeline.dispatchEvent('wheel', { deltaY: -1 });
      await paragraph.evaluate(node => {
        const viewport = node.closest('.lab-timeline-scroll')!;
        viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4;
        viewport.dispatchEvent(new Event('scroll'));
      });
      await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
    }
    // Record the first frame, rather than polling until the later observer catches up.
    await page.evaluate((reading) => {
      const viewport = document.querySelector('[data-testid="timeline"]')!;
      const paragraph = Array.from(viewport.querySelectorAll('.agent-markdown p')).find(el => el.textContent?.startsWith('Paragraph 10.'))!;
      const readingOffset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      window.addEventListener('resize', () => requestAnimationFrame(() => {
        const error = reading
          ? paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - readingOffset
          : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        document.documentElement.dataset.rotationPositionError = String(error);
      }), { once: true });
    }, reading);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-rotation-position-error');
    const error = Number(await page.locator('html').getAttribute('data-rotation-position-error'));
    expect(Math.abs(error)).toBeLessThan(1);
    if (reading) await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  });
}
