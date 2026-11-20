import { expect, test, type Page } from '@playwright/test';
import { englishWords } from './english-words';

// The main screens in Chinese (I4, Task 7): no Latin word a person reads is left in English, except proper names, code and
// paths. Bot mode's conversation with the composer, its + menu and the assistant's details; Window mode's tiles and a tile's
// details. Each check names where a word was found.
test.use({ locale: 'zh-CN' });

const conversation = '/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief&pending=none';
/** The fixtures' own sample data: agent names in the letters, providers, a folder, a tool, a Host and the account's name. */
const sample = ['Chief', 'Planner', 'claude', 'notes', 'Write', 'Alice', 'Example', 'Work', 'Recorded'];

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
