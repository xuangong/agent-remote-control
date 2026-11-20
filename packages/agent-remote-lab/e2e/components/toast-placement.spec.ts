import { expect, test } from '@playwright/test';

async function raiseCommandErrorToast(page: import('@playwright/test').Page) {
  await page.goto('/e2e/fixtures/toast-placement.html');
  const input = page.getByTestId('prompt-input');
  await input.fill('Run the refused command');
  // The send button sends under any pointer; Return makes a new line on a touch screen.
  await page.getByTestId('prompt-submit').click();
  const toast = page.locator('.lab-toast').filter({ hasText: 'The command was refused by the fixture.' });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await toast.hover(); // Pause the countdown while checking viewport transitions.
  return page.locator('body');
}

test('mobile toast stays above the composer through keyboard and draft resizing', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = await raiseCommandErrorToast(page);
  const input = pane.getByTestId('prompt-input');
  for (const viewport of [{ height: 844, offsetTop: 0 }, { height: 420, offsetTop: 80 }, { height: 340, offsetTop: 160 }, { height: 844, offsetTop: 0 }]) {
    await page.evaluate(value => {
      for (const [key, next] of Object.entries(value)) Object.defineProperty(window.visualViewport!, key, { configurable: true, value: next });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    }, viewport);
    await input.fill(viewport.height === 340 ? 'A draft\nwith several\nlines of text\nto keep visible' : 'Keep typing');
    await expect.poll(async () => {
      const notification = await page.locator('.lab-toast-region').boundingBox();
      const composer = await pane.locator('.lab-composer-dock').boundingBox();
      return !!notification && !!composer && notification.height > 0
        && notification.y >= viewport.offsetTop && notification.y + notification.height <= composer.y - 8;
    }).toBe(true);
    await expect(input).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('toast-above-composer.png') });
});

test('desktop keeps the existing bottom-right toast position', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await raiseCommandErrorToast(page);
  const bounds = (await page.locator('.lab-toast-region').boundingBox())!;
  expect(bounds.x + bounds.width).toBeCloseTo(1424, 0);
  expect(bounds.y + bounds.height).toBeCloseTo(884, 0);
});

test('mobile toast follows the collapsed composer and keeps its toggle accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = await raiseCommandErrorToast(page);
  await pane.getByRole('button', { name: 'Hide message input', exact: true }).click();
  const toggle = pane.getByRole('button', { name: 'Show message input', exact: true });
  await expect.poll(async () => {
    const bounds = await page.locator('.lab-toast-region').boundingBox();
    const button = await toggle.boundingBox();
    return bounds && button ? Math.round(button.y - bounds.y - bounds.height) : undefined;
  }).toBe(12);
  await toggle.click();
  await expect.poll(async () => {
    const toast = await page.locator('.lab-toast-region').boundingBox();
    const composer = await pane.locator('.lab-composer-dock').boundingBox();
    return !!toast && !!composer && toast.y + toast.height <= composer.y - 8;
  }).toBe(true);
});
