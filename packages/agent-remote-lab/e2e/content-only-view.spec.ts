import { expect, test } from '@playwright/test';

for (const width of [320, 390, 1440]) {
  test(`content-only view filters execution details and persists at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const open = () => page.getByRole('button', { name: 'View options', exact: true }).click();
    await page.goto('/e2e/fixtures/view-overflow.html?view=content');
    await expect(page.locator('.agent-tool')).toHaveCount(3);
    await open();
    const content = page.getByRole('checkbox', { name: 'Content only view' });
    const simple = page.getByRole('checkbox', { name: 'Simple conversation view' });
    expect((await content.boundingBox())!.y).toBeLessThan((await simple.boundingBox())!.y);
    await content.check();
    await expect(simple).not.toBeChecked();
    await open();
    await expect(page.locator('.agent-timeline-entry')).toHaveCount(6);
    await expect(page.locator('.agent-message-user strong')).toHaveText('fix the renderer');
    await expect(page.locator('.agent-message-assistant')).toContainText('I found the failing assertion');
    await expect(page.locator('.agent-tool')).toHaveCount(1);
    await expect(page.locator('.agent-tool')).toContainText('functions.update_plan');
    await expect(page.locator('.agent-todo')).toContainText('Completed');
    await expect(page.locator('.agent-todo')).toContainText('In progress');
    await expect(page.locator('.agent-plan-completed')).toContainText('Approved');
    await expect(page.locator('.agent-question-completed')).toContainText('Current project');
    await expect(page.locator('.agent-question-completed .agent-content-preview')).toContainText('Which directory');
    await expect(page.locator('.agent-reasoning, .agent-error, .agent-inspect-entry')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: testInfo.outputPath(`content-only-${width}.png`) });
    await page.goto('/e2e/fixtures/view-overflow.html?view=content');
    await expect(page.locator('.agent-timeline-entry')).toHaveCount(6);
    await open();
    await expect(content).toBeChecked();
    await simple.check();
    await expect(content).not.toBeChecked();
    await expect(page.locator('.agent-tool')).toHaveCount(3);
    await expect(page.locator('.agent-tool-preview')).toHaveCount(0);
    await content.check();
    await expect(simple).not.toBeChecked();
    await content.uncheck();
    await expect(page.locator('.agent-tool-preview')).toHaveCount(3);
    expect(errors).toEqual([]);
  });
}
