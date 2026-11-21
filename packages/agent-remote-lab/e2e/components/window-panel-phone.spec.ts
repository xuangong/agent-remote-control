import { expect, test } from '@playwright/test';

// The Windows panel of the launcher row, on the narrowest phones: it stays inside the screen with a long Window title, and every control stays inside it.
for (const width of [320, 390]) test(`the Windows panel fits a ${width}px phone with a long title`, async ({ page }) => {
  await page.setViewportSize({ width, height: 667 });
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=2');
  const close = page.locator('#lab-context').getByRole('button', { name: 'Close', exact: false }).first();
  if (await close.isVisible()) await close.click();
  const launcher = page.getByRole('button', { name: 'Windows', exact: true }).and(page.locator(':not(.lab-rail *, .lab-tab-bar *)'));
  await launcher.click();
  const panel = page.locator('.lab-window-panel');
  await expect(panel).toBeVisible();
  const title = 'A long Window title keeps the current workspace readable on a narrow phone screen';
  const current = panel.locator('[data-window-id][aria-current="true"]');
  await panel.locator(`[data-window-rename="${await current.getAttribute('data-window-id')}"]`).click();
  await panel.getByLabel('Window title', { exact: true }).fill(title);
  const bounds = () => panel.evaluate(element => {
    const box = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('[data-window-row], [data-window-view-row], [data-window-id], [data-window-view-id], input, button')].map(control => control.getBoundingClientRect())
      .filter(rect => rect.width > 0);
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, outside: controls.filter(rect => rect.left < box.left - 1 || rect.right > box.right + 1).length, pageWidth: document.documentElement.scrollWidth };
  });
  let measured = await bounds();
  expect(measured.left).toBeGreaterThanOrEqual(0); expect(measured.right).toBeLessThanOrEqual(width);
  expect(measured.top).toBeGreaterThanOrEqual(0); expect(measured.bottom).toBeLessThanOrEqual(667);
  expect(measured.outside).toBe(0);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(current).toContainText(title);
  measured = await bounds();
  expect(measured.pageWidth).toBe(width);
  expect(measured.outside).toBe(0);
  await panel.getByRole('button', { name: 'Close Windows', exact: true }).click();
  await expect(panel).toBeHidden();
});
