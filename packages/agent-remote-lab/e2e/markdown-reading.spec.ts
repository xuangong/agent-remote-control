import { expect, test } from '@playwright/test';

test('keeps text sizing stable through portrait and landscape viewport changes', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Mobile text sizing behavior');
  await page.goto('/e2e/fixtures/markdown-reading.html?cached=1');
  const paragraph = page.locator('.agent-markdown p').filter({ hasText: /^Paragraph 10\./ });
  const portrait = page.viewportSize()!;
  const measure = () => paragraph.evaluate(node => {
    const style = getComputedStyle(node);
    const range = document.createRange();
    range.setStart(node.firstChild!, 0);
    range.setEnd(node.firstChild!, 10);
    const bounds = range.getBoundingClientRect();
    return { fontSize: style.fontSize, width: bounds.width, height: bounds.height,
      adjustment: style.getPropertyValue('-webkit-text-size-adjust') || style.getPropertyValue('text-size-adjust') };
  });
  const initial = await measure();
  const measurements = [initial];
  for (const viewport of [{ width: portrait.height, height: portrait.width }, portrait]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await measure()).fontSize).toBe(initial.fontSize);
    const current = await measure();
    measurements.push(current);
    expect(current.width).toBeCloseTo(initial.width, 0);
    expect(current.height).toBeCloseTo(initial.height, 0);
  }
  await testInfo.attach('orientation-text-metrics', { body: JSON.stringify(measurements), contentType: 'application/json' });
  const supportsAdjustment = await page.evaluate(() => CSS.supports('-webkit-text-size-adjust', '100%') || CSS.supports('text-size-adjust', '100%'));
  if (supportsAdjustment) expect(measurements.map(value => value.adjustment)).toEqual(['100%', '100%', '100%']);
  else testInfo.annotations.push({ type: 'coverage', description: 'This desktop browser build does not implement mobile text inflation; only viewport and glyph stability were checked.' });
});

test('uses cached image dimensions in the first layout when opening Markdown', async ({ page }) => {
  await page.goto('/e2e/fixtures/markdown-reading.html?cached=1');
  const frame = page.locator('.agent-markdown-image');
  await expect(frame).toHaveCSS('aspect-ratio', '1200 / 600');
  const initialHeight = await page.locator('html').getAttribute('data-initial-image-height');
  expect(Number(initialHeight)).toBeCloseTo((await frame.boundingBox())!.height, 0);
});

test('keeps the visible paragraph steady when an earlier image in the same reply gains dimensions', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/markdown-reading.html');
  const timeline = page.getByTestId('timeline');
  const paragraph = page.locator('.agent-markdown p').filter({ hasText: /^Paragraph 10\./ });
  await timeline.dispatchEvent('wheel', { deltaY: -1 });
  await paragraph.evaluate(node => {
    const viewport = node.closest('.lab-timeline-scroll')!;
    viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  const target = (await timeline.boundingBox())!.y + 4;
  await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - target)).toBeLessThan(1);
  const before = (await paragraph.boundingBox())!.y;
  await page.screenshot({ path: testInfo.outputPath('before-metadata.png') });
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-metadata')));
  await expect(page.locator('.agent-markdown-image')).toHaveCSS('aspect-ratio', '1200 / 600');
  await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - before)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('after-metadata.png') });
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-remount')));
  await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - before)).toBeLessThan(1);
  const initialHeight = Number(await page.locator('html').getAttribute('data-initial-image-height'));
  expect(initialHeight).toBeCloseTo((await page.locator('.agent-markdown-image').boundingBox())!.height, 0);
});
