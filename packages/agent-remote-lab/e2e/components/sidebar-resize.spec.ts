import { expect, test } from '@playwright/test';
import { toggleViewPanel } from '../view-options';

test('resizes the desktop sidebar, retains its width, and supports keyboard reset', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const handle = page.getByRole('separator', { name: 'Sidebar width' });
  const rail = page.locator('#lab-context');
  await expect(handle).toHaveAttribute('aria-valuenow', '260');
  const bounds = await handle.boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 150);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 140, bounds!.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '360');
  expect((await rail.boundingBox())!.width).toBe(360);
  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', '360');
  await handle.focus(); await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '350');
  await page.keyboard.press('Home'); await expect(handle).toHaveAttribute('aria-valuenow', '220');
  await page.keyboard.press('End'); await expect(handle).toHaveAttribute('aria-valuenow', '360');
  await page.setViewportSize({ width: 1181, height: 800 });
  // With the rail and the inspector open, the sidebar gives way so that the main stage keeps its room; the saved width returns when the inspector closes.
  await toggleViewPanel(page, 'Replica Inspector');
  await expect(handle).toHaveAttribute('aria-valuenow', '301');
  expect((await page.locator('.lab-main-stage').boundingBox())!.width).toBeGreaterThanOrEqual(479);
  await toggleViewPanel(page, 'Replica Inspector');
  await expect(handle).toHaveAttribute('aria-valuenow', '360');
  await page.setViewportSize({ width: 1180, height: 800 });
  await expect(handle).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(handle).toHaveAttribute('aria-valuenow', '360');
  const resetBounds = await handle.boundingBox();
  await page.mouse.dblclick(resetBounds!.x + 4, resetBounds!.y + 150);
  await expect(handle).toHaveAttribute('aria-valuenow', '260');
  await toggleViewPanel(page, 'Sidebar'); await expect(handle).toHaveCount(0);
  await toggleViewPanel(page, 'Sidebar'); await expect(handle).toBeVisible();
});

test.describe('in Chinese', () => {
  test.use({ locale: 'zh-CN' });
  test('words the sidebar handle in Chinese', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium-desktop');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const handle = page.getByRole('separator', { name: '侧边栏宽度' });
    await expect(handle).toHaveAttribute('aria-valuenow', '260');
    await expect(handle).toHaveAttribute('aria-valuetext', '260 像素');
  });
});
