import { expect, test } from '@playwright/test';

for (const [viewportWidth, viewWidth] of [[320, 320], [390, 390], [1440, 390], [1440, 1440]] as const) {
  test(`bounds tool summaries in a ${viewWidth}px view on a ${viewportWidth}px screen`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewportWidth, height: 850 });
    await page.goto('/e2e/fixtures/view-overflow.html?view=summaries&mode=simple');
    await page.locator('main').evaluate((element, width) => { element.style.maxWidth = `${width}px`; }, viewWidth);
    const tools = page.locator('.agent-tool');
    await expect(tools).toHaveCount(7);
    await expect(page.locator('.agent-tool-preview')).toHaveCount(0);
    for (const tool of await tools.all()) {
      const summary = tool.locator('.agent-tool-summary');
      const size = await summary.evaluate(element => ({
        height: element.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(element).lineHeight),
      }));
      expect(size.height, await tool.locator('.agent-timeline-title').innerText()).toBeLessThanOrEqual(size.lineHeight * 3 + 1);
      await expect(tool.locator('.agent-tool-toggle')).toHaveAttribute('aria-expanded', 'false');
    }
    for (const message of await page.locator('.agent-message .agent-markdown').all()) {
      const size = await message.evaluate(element => ({
        height: element.clientHeight, fullHeight: element.scrollHeight,
        lineHeight: parseFloat(getComputedStyle(element).lineHeight),
      }));
      expect(size.height).toBeGreaterThan(size.lineHeight * 3);
      expect(size.fullHeight - size.height).toBeLessThanOrEqual(1);
    }
    const shell = tools.first();
    await shell.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('collapsed.png') });
    await shell.locator('.agent-tool-toggle').focus();
    await page.keyboard.press('Enter');
    const command = shell.locator('.agent-tool-detail code');
    await expect(command).toBeVisible();
    await expect(command).toContainText('END OF TASK');
    const heights = await shell.evaluate(element => ({
      summary: element.querySelector('.agent-tool-summary')!.getBoundingClientRect().height,
      details: element.querySelector('.agent-tool-details')!.getBoundingClientRect().height,
    }));
    expect(heights.details).toBeGreaterThan(heights.summary * 3);
    await shell.locator('.agent-tool-toggle').press('Enter');
    await expect(shell.locator('.agent-tool-details')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewportWidth);
  });
}
