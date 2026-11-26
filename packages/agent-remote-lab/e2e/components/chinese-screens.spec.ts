// Component projects: orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';
import { englishWords } from './english-words';

// The main screens in Chinese (I4, Task 7): no Latin word a person reads is left in English, except proper names, code and
// paths. Bot mode's conversation with the composer, its + menu and the assistant's details; Window mode's tiles and a tile's
// details. Each check names where a word was found.
test.use({ locale: 'zh-CN' });

const conversation = '/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief&pending=none';
/** The fixtures' own sample data: agent names in the letters, providers, a folder, a tool, a Host, a model and the account's name. */
const sample = ['Chief', 'Planner', 'claude', 'notes', 'Write', 'Alice', 'Example', 'Work', 'Recorded', 'recorded-model'];

async function shown(page: Page, where: string) {
  expect(await englishWords(page, { allow: sample }), where).toEqual([]);
}

test('Bot mode: the conversation, the composer and its + menu', async ({ page }) => {
  await page.goto(conversation);
  const capsule = page.locator('.agent-composer-capsule').first();
  await expect(capsule).toBeVisible();
  await shown(page, 'conversation');
  await capsule.getByTestId('prompt-input').click();
  await shown(page, 'composer focused');
  await capsule.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page.getByRole('region', { name: '更多操作', exact: true })).toBeVisible();
  await shown(page, '+ menu');
});

test("Bot mode: the assistant's details beside the conversation", async ({ page, isMobile }) => {
  test.skip(isMobile, 'The details stand beside the conversation on a wide screen.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(conversation);
  await expect(page.locator('.lab-assistant-details')).toBeVisible();
  await shown(page, 'details');
});

test("Window mode: the tiles and a tile's details", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Tiles stand side by side on a desktop width.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=3&bots=1');
  const tiles = page.locator('.lab-window-workbench .lab-primary-group');
  await expect(tiles).toHaveCount(3);
  await shown(page, 'tiles');
  await tiles.first().locator('.lab-session-heading').getByRole('button', { name: /详情/ }).click();
  await expect(tiles.first().locator('.lab-tile-details')).toBeVisible();
  await shown(page, 'tile details');
});

test('Bot mode on a desktop: no chat open, the shortcuts sheet, the palette and the context menus', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The keyboard and the context menus are the desktop\'s.');
  // The tiles fixture's sessions run on the lab's own Host ("local") with its recorded provider.
  const shown = async (page: Page, where: string) => expect(await englishWords(page, { allow: [...sample, 'local', 'recorded'] }), where).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=3&bots=1&mode=bot&users=3');
  const bot = page.locator('[data-workbench-mode="bot"]');
  await expect(bot.locator('.lab-bot-welcome')).toBeVisible();
  await shown(page, 'no chat open');
  await bot.locator('[data-bot-place]').first().click();
  await expect(bot.locator('.agent-message-assistant').first()).toBeVisible();
  const primary = await page.evaluate(() => /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.press(`${primary}+Slash`);
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible();
  await shown(page, 'shortcuts sheet');
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${primary}+KeyK`);
  await expect(page.getByRole('dialog', { name: '搜索' })).toBeVisible();
  await shown(page, 'palette');
  await page.keyboard.press('Escape');
  await bot.locator('[data-bot-place]').nth(1).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await shown(page, 'chat menu');
  await page.keyboard.press('Escape');
  await bot.locator('.agent-message-assistant').last().click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '消息操作' })).toBeVisible();
  await shown(page, 'message menu');
});
