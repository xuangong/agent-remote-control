import { expect, test, type Locator } from '@playwright/test';
import { toggleViewPanel } from './view-options';
import { showNewSession } from './session-navigation';

async function expectContained(container: Locator) {
  const overflow = await container.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { width: element.scrollWidth - element.clientWidth, left: bounds.left, right: bounds.right, viewport: innerWidth };
  });
  expect(overflow.width, await container.getAttribute('class') ?? 'container').toBeLessThanOrEqual(1);
  expect(overflow.left).toBeGreaterThanOrEqual(-1);
  expect(overflow.right).toBeLessThanOrEqual(overflow.viewport + 1);
}

for (const width of [320, 390, 844, 1440]) {
  test(`contains long resources and all controller views at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/');
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    const path = `artifacts/${'resource'.repeat(64)}.txt`;
    await page.getByTestId('prompt-input').fill(`Download [long resource](${path}).`);
    await page.getByTestId('prompt-submit').click();
    // Resource cards show the file name rather than the full locator (54cc2377).
    const resource = page.locator('.agent-resources li').filter({ has: page.locator('code').getByText(path.split('/').pop()!, { exact: true }) }).last();
    await expect(resource).toBeVisible();
    await expectContained(resource);
    await expectContained(page.getByTestId('timeline'));
    await page.screenshot({ path: testInfo.outputPath(`resources-${width}.png`) });
    await toggleViewPanel(page, 'Header');
    await expectContained(page.locator('.lab-app-bar'));
    await page.getByRole('tab', { name: 'Trace', exact: true }).click();
    await expectContained(page.locator('.lab-trace-layout'));
    await expectContained(page.locator('.lab-trace-list'));
    await toggleViewPanel(page, 'Replica Inspector');
    await expectContained(page.locator('#lab-inspector'));
    if (width <= 1180) await page.getByRole('button', { name: 'Close Replica Inspector' }).click();
    await toggleViewPanel(page, 'Sidebar');
    await expectContained(page.locator('#lab-context'));
  });
}
