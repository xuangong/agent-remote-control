import { expect, test } from '@playwright/test';

// Bot mode over the real Workbench on builder data: the editor of Window mode is the editor of Bot mode, a bot opened with the keyboard
// takes focus to its title, Tab stays in the mode on screen, and on a phone Back returns focus to the bot's row.
const url = '/e2e/fixtures/window-tiles.html?tiles=2&bots=1';
for (const [width, height] of [[1440, 900], [390, 844]] as const) test(`a bot opened with the keyboard takes focus to its title, and Tab stays in Bot mode at ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const phone = width < 600;
  // A phone's home is the list of chats; a wide screen comes from Window mode with a draft, through the rail.
  await page.goto(phone ? `${url}&mode=bot` : url);
  const window = page.locator('[data-workbench-mode="window"]'), bot = page.locator('[data-workbench-mode="bot"]');
  if (!phone) {
    const editor = window.getByRole('textbox', { name: 'Message', exact: true }).first();
    await editor.click(); await page.keyboard.type('Keep this draft across modes');
    await page.locator('.lab-rail').getByRole('button', { name: 'Chats', exact: true }).click();
  }
  await expect(bot).toBeVisible();
  await expect(window).toBeHidden();
  // Opening a bot by keyboard moves focus to its title (O56), at once or once its conversation is described.
  const row = bot.locator('[data-bot-place]').nth(phone ? 0 : 1);
  const name = await row.getAttribute('aria-label');
  await row.focus(); await row.press('Enter');
  const title = bot.locator('button.lab-assistant-title');
  await expect(title).toBeFocused();
  await expect(title).toHaveAccessibleName(name!);
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
