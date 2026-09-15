import { expect, test } from '@playwright/test';

for (const width of [320, 390, 844, 1440]) {
  test(`shows previews and remembers simple mode at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/e2e/fixtures/view-overflow.html?view=previews');
    await expect(page.locator('.agent-tool-preview')).toHaveCount(2);
    await expect(page.locator('.agent-file-preview')).toHaveCount(2);
    await expect(page.locator('.agent-reasoning .agent-content-preview')).toContainText('Check the existing event');
    await expect(page.locator('.agent-question-completed .agent-content-preview')).toContainText('Which directory');
    const output = page.locator('.agent-tool-result-preview .agent-code-preview');
    const visibleLines = await output.locator('.agent-preview-line:visible').count();
    expect(visibleLines).toBe(width <= 640 ? 4 : 6);
    expect(await output.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await output.focus();
    await output.press('ArrowRight');
    await expect.poll(() => output.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await output.evaluate(element => { element.scrollLeft = 0; (element as HTMLElement).blur(); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    for (const element of await page.locator('.agent-tool-preview, .agent-file-preview, .agent-content-preview, .agent-diff-preview').all()) {
      const bounds = (await element.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(-1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    await page.getByTestId('timeline').dispatchEvent('wheel', { deltaY: -100 });
    await page.locator('.agent-reasoning').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`previews-${width}.png`) });
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Simple conversation view' }).check();
    await expect(page.locator('.agent-tool-preview')).toHaveCount(0);
    // App replaces the fixture URL with the session URL; revisit the fixture to remount it.
    await page.goto('/e2e/fixtures/view-overflow.html?view=previews');
    await expect(page.locator('.agent-tool-preview')).toHaveCount(0);
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Simple conversation view' }).uncheck();
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    await expect(page.locator('.agent-tool-preview')).toHaveCount(2);
    const tool = page.locator('.agent-tool').first();
    await tool.getByRole('button', { name: 'Show full result' }).click();
    await expect(tool.locator('.agent-tool-details')).toContainText('Test result 29');
    await tool.locator('.agent-tool-toggle').click();
    await expect(tool.locator('.agent-tool-preview')).toHaveCount(0);
    await expect(tool.locator('.agent-tool-details')).toBeHidden();
    expect(errors).toEqual([]);
  });
}
