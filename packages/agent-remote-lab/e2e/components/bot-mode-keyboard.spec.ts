import { expect, test } from '@playwright/test';

// Bot mode over the real Workbench on builder data: the editor of Window mode is the editor of Bot mode, focus follows a keyboard open, Tab
// stays in the mode on screen.
const url = '/e2e/fixtures/window-tiles.html?tiles=2&bots=1';
for (const [width, height] of [[1440, 900]] as const) test(`keyboard focus and Tab order stay in Bot mode at ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const phone = width < 600;
  const window = page.locator('[data-workbench-mode="window"]'), bot = page.locator('[data-workbench-mode="bot"]');
  const wide = !phone;
  const drawer = page.locator('#lab-context').getByRole('button', { name: 'Close', exact: false }).first();
  if (phone && await drawer.isVisible()) await drawer.click();
  if (wide) {
    const editor = window.getByRole('textbox', { name: 'Message', exact: true }).first();
    await editor.click(); await page.keyboard.type('Keep this draft across modes');
    await editor.evaluate(node => { (node as HTMLElement).dataset.retained = 'yes'; });
  }
  const destination = phone ? page.locator('.lab-tab-bar') : page.locator('.lab-rail');
  await destination.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(bot).toBeVisible();
  await expect(window).toBeHidden();
  // Beside the list, opening a bot by keyboard leaves focus on its row.
  const rows = bot.locator('[data-bot-place]');
  const row = rows.nth(wide ? 1 : 0);
  await row.focus(); await row.press('Enter');
  await expect(row).toBeFocused();
  const shown = bot.getByRole('textbox', { name: 'Message', exact: true }).locator('visible=true');
  await expect(shown).toHaveCount(1);
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-workbench-mode="window"]'))).toBe(false);
  }
  if (phone) {
    await bot.getByRole('button', { name: 'Back to chats', exact: false }).first().click();
    await expect(row).toBeFocused();
  }
});

test('the editor of Window mode is the editor of Bot mode, with its draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const editor = page.locator('[data-workbench-mode="window"]').getByRole('textbox', { name: 'Message', exact: true }).first();
  await editor.click(); await page.keyboard.type('Keep this draft across modes');
  await editor.evaluate(node => { (node as HTMLElement).dataset.retained = 'yes'; });
  await page.locator('.lab-rail').getByRole('button', { name: 'Chats', exact: true }).click();
  const bot = page.locator('[data-workbench-mode="bot"]');
  // The first bot is the one the Window selected: its editor is the very node, with the text typed.
  await bot.locator('[data-bot-place]').first().click();
  const shown = bot.getByRole('textbox', { name: 'Message', exact: true }).locator('visible=true');
  await expect(shown).toHaveAttribute('data-retained', 'yes');
  await expect(shown).toHaveText('Keep this draft across modes');
});
