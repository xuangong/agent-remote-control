import { expect, test } from '@playwright/test';
import { chooseDeviceProcessMode } from './device-process-mode.js';

for (const width of [320, 390, 844, 1440]) {
  test(`starts in Concise, then shows and remembers every step's preview in Full at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/e2e/fixtures/view-overflow.html?view=previews&process=concise');
    await expect(page.locator('.agent-tool')).toHaveCount(0);
    await expect(page.locator('.agent-tool-preview')).toHaveCount(0);
    await chooseDeviceProcessMode(page, 'Full');
    await expect(page.locator('.agent-tool-preview')).toHaveCount(2);
    await expect(page.locator('.agent-file-preview')).toHaveCount(2);
    await expect(page.locator('.agent-reasoning .agent-content-preview')).toContainText('Check the existing event');
    // An answered question stays one receipt line in every mode; its questions show when it is opened.
    const receipt = page.locator('.agent-question-completed');
    await expect(receipt.locator('.agent-receipt-details')).toBeHidden();
    await receipt.locator('.agent-receipt-toggle').click();
    await expect(receipt.locator('.agent-receipt-details')).toContainText('Which directory');
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
    // App replaces the fixture URL with the session URL; revisit the fixture to remount it.
    await page.goto('/e2e/fixtures/view-overflow.html?view=previews');
    await expect(page.locator('.agent-tool-preview')).toHaveCount(2);
    const tool = page.locator('.agent-tool').first();
    await tool.getByRole('button', { name: 'Show full result' }).click();
    await expect(tool.locator('.agent-tool-details')).toContainText('Test result 29');
    await tool.locator('.agent-tool-toggle').click();
    await expect(tool.locator('.agent-tool-preview')).toHaveCount(0);
    await expect(tool.locator('.agent-tool-details')).toBeHidden();
    await chooseDeviceProcessMode(page, 'Concise');
    await expect(page.locator('.agent-tool-preview')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
