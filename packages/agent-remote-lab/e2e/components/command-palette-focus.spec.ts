import { expect, test } from '@playwright/test';

// The palette is a native modal: the browser returns focus to the composer it was opened from when it closes, which jsdom cannot show.
test('the command palette opens from the composer and returns focus there when it closes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The keyboard shortcut is for a desktop keyboard.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=2');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true }).first();
  await composer.click();
  const apple = await page.evaluate(() => /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform));
  const palette = page.getByRole('dialog', { name: 'Search', exact: true });
  await page.keyboard.press(apple ? 'Meta+K' : 'Control+K');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(composer).toBeFocused();
});
