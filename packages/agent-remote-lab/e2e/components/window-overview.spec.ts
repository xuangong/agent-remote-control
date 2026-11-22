// Component projects: webkit-conversation, orchard-phone-chromium, orchard-phone-webkit
import { expect, test } from '@playwright/test';

// All Windows on a wide screen opens from the keyboard and returns focus where it was; a narrow screen keeps no overview at all.
const overview = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'All groups' });

test('on a wide screen Ctrl+Shift+Up shows every Window and Ctrl+Shift+Down returns', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The overview is for wide screens.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=2');
  await expect(page.locator('.lab-session-family-pane').first()).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect(overview(page)).toBeVisible();
  const card = overview(page).locator('[data-window-card]').first();
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute('aria-current', 'true');
  // Both panes of the Window show in its thumbnail.
  await expect(card.locator('.lab-window-card-pane')).toHaveCount(2);
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect(overview(page)).toBeHidden();
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect(overview(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overview(page)).toBeHidden();
});

test('on a phone the shortcut opens nothing and the Windows list has no All Windows button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=2');
  await expect(page.locator('.lab-tile-stack-track')).toBeVisible();
  await page.keyboard.press('Control+Shift+ArrowUp');
  await page.waitForTimeout(200);
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show all groups', exact: true })).toHaveCount(0);
});
