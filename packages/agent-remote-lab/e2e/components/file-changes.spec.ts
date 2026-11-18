import { expect, test } from '@playwright/test';

for (const width of [320, 390, 844, 1440]) {
  test(`renders file changes with local diff scrolling at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 740 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/e2e/fixtures/view-overflow.html?view=file-changes');
    await page.locator('.agent-tool-toggle').click();
    const files = page.locator('.agent-file-change');
    await expect(files).toHaveCount(5);
    const first = files.first();
    await expect(first).toHaveAttribute('open', '');
    await expect(first.locator('.agent-diff-stats')).toHaveText('+1−1');
    const diff = first.getByRole('region');
    await diff.focus();
    await diff.press('ArrowRight');
    await expect.poll(() => diff.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await diff.evaluate(element => { element.scrollLeft = 0; });
    for (let index = 1; index < 5; index++) await files.nth(index).locator('summary').click();
    await expect(files.nth(1).getByRole('region')).toContainText('+first line');
    await expect(files.nth(2).getByRole('region')).toContainText('-old line');
    await expect(files.nth(3)).toContainText('No diff content provided.');
    await expect(files.nth(4)).toContainText('Binary files');
    await page.locator('.agent-file-raw > summary').click();
    await expect(page.locator('.agent-file-raw pre')).toContainText('"format": "file_changes"');
    expect(await page.getByTestId('timeline').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    for (const element of await page.locator('.agent-file-change, .agent-file-change > summary, .agent-diff-scroll').all()) {
      const bounds = (await element.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect((await first.locator('summary').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.locator('.agent-file-raw > summary').click();
    await page.getByTestId('timeline').dispatchEvent('wheel', { deltaY: -100 });
    await diff.scrollIntoViewIfNeeded();
    await expect(diff).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`file-changes-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
