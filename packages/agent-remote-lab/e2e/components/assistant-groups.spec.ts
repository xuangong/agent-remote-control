// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Locator, type Page } from '@playwright/test';
import { englishWords } from './english-words.js';

// Groups as one concept (I5): Chats and the Assistants directory list the same groups in the same order, the default group
// ("Ungrouped") last, and every group operation is reachable from the directory on a desktop and on a phone.

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) <= 430;
const url = (query = '') => `/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&groups=1${query}`;
const go = async (page: Page, name: string) => {
  const place = phone(page) ? page.locator('.lab-tab-bar').getByRole('button', { name, exact: true }) : page.locator('.lab-rail').getByRole('button', { name, exact: true });
  await place.click();
};
const titles = async (sections: Locator) => (await sections.locator(':scope > .lab-bot-section-head h2, :scope > h2').allTextContents()).map(text => text.trim());
const names = (section: Locator) => section.locator('.lab-bot-name').allTextContents();
const directoryGroup = (page: Page, title: string) => page.locator('.lab-directory-group').filter({ has: page.locator('h2', { hasText: new RegExp(`^${title}`) }) });
/** Opens a ⋯ menu once its button has come into view (a menu closes when its button moves), then chooses an item. */
async function choose(button: Locator, item: string) {
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await button.click();
  await button.page().getByRole('menuitem', { name: item, exact: true }).click();
}
const groupAction = (page: Page, group: string, item: string) => choose(page.getByRole('button', { name: `Group actions: ${group}`, exact: true }), item);
const assistantAction = (page: Page, name: string, item: string) => choose(page.locator('.lab-directory').getByRole('button', { name: `More actions for ${name}`, exact: true }), item);

test('sections Chats by group in the groups\' order, each by activity, with the default group last', async ({ page }, testInfo) => {
  await page.goto(url());
  const chats = page.locator('.lab-bot-roster-list');
  await expect(chats.locator('.lab-chat-group')).toHaveCount(3);
  expect((await chats.locator('.lab-chat-group-title').allTextContents()).map(text => text.trim())).toEqual(['Notes', 'Research', 'Ungrouped']);
  // Chief is pinned; Reviewer has the latest reply; the rest keep roster order.
  expect(await names(chats.locator('.lab-chat-group').nth(0))).toEqual(['Chief', 'Reviewer', 'Builder']);
  expect(await names(chats.locator('.lab-chat-group').nth(2))).toEqual(['Ink', 'Rice']);
  await page.screenshot({ path: testInfo.outputPath(`chats-by-group-${phone(page) ? 'phone' : 'desktop'}.png`) });
});

test('lists the same groups in the Assistants directory, with every group operation reachable', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url());
  await go(page, 'Assistants');
  const directory = page.locator('.lab-directory');
  await expect(directory.locator('.lab-directory-group')).toHaveCount(3);
  expect(await titles(directory.locator('.lab-directory-group'))).toEqual(['Notes', 'Research', 'Ungrouped']);
  expect(await names(directoryGroup(page, 'Ungrouped'))).toEqual(['Ink', 'Rice']);
  await page.screenshot({ path: testInfo.outputPath(`assistants-by-group-${phone(page) ? 'phone' : 'desktop'}.png`) });

  // Create, rename and order.
  await directory.getByRole('button', { name: 'New group', exact: true }).click();
  const sheet = page.locator('dialog.orchard-sheet[open]');
  await sheet.getByRole('textbox', { name: 'Group name' }).fill('Ops');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => titles(directory.locator('.lab-directory-group'))).toEqual(['Notes', 'Research', 'Ops', 'Ungrouped']);
  await groupAction(page, 'Research', 'Rename…');
  await page.locator('dialog.orchard-sheet[open]').getByRole('textbox', { name: 'Group name' }).fill('Research team');
  await page.locator('dialog.orchard-sheet[open]').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Group actions: Research team', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath(`group-menu-${phone(page) ? 'phone' : 'desktop'}.png`) });
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await expect.poll(() => titles(directory.locator('.lab-directory-group'))).toEqual(['Research team', 'Notes', 'Ops', 'Ungrouped']);
  // The last group people made cannot go below the default group.
  await page.getByRole('button', { name: 'Group actions: Ops', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Move down', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // Mute and notifications.
  await groupAction(page, 'Notes', 'Mute');
  await expect(directoryGroup(page, 'Notes').getByRole('img', { name: 'Muted' })).toBeVisible();
  await groupAction(page, 'Research team', 'Notifications…');
  const notifications = page.locator('dialog.orchard-sheet[open]');
  await notifications.getByRole('button', { name: 'Only when it needs you', exact: true }).click();
  await expect(notifications.getByRole('button', { name: 'Only when it needs you', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath(`group-notifications-${phone(page) ? 'phone' : 'desktop'}.png`) });
  await notifications.getByRole('button', { name: 'Done', exact: true }).click();

  // Add, move and remove an assistant.
  await groupAction(page, 'Ops', 'Add assistants…');
  await page.locator('dialog.orchard-sheet[open]').getByRole('button', { name: 'Add Ink', exact: true }).click();
  await page.locator('dialog.orchard-sheet[open]').getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => names(directoryGroup(page, 'Ops'))).toEqual(['Ink']);
  await expect(directory.getByRole('status')).toHaveText('“Ink” is in “Ops” now.');
  await assistantAction(page, 'Ink', 'Move to group…');
  await page.locator('dialog.orchard-sheet[open]').getByRole('button', { name: 'Research team', exact: true }).click();
  await expect.poll(() => names(directoryGroup(page, 'Research team'))).toEqual(['Scout', 'Gauge', 'Ink']);
  await expect(directory.getByRole('status')).toHaveText('“Ink” is in “Research team” now.');
  await assistantAction(page, 'Ink', 'Remove from “Research team”');
  await expect.poll(() => names(directoryGroup(page, 'Ungrouped'))).toEqual(['Rice', 'Ink']);
  await expect(directory.getByRole('status')).toHaveText('“Ink” is in “Ungrouped” now.');
  // Ops is empty again, so it can be deleted; a group with assistants cannot.
  await page.getByRole('button', { name: 'Group actions: Notes', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete group', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await groupAction(page, 'Ops', 'Delete group');
  await expect.poll(() => titles(directory.locator('.lab-directory-group'))).toEqual(['Research team', 'Notes', 'Ungrouped']);
  await assistantAction(page, 'Rice', 'Pin to top');
  await assistantAction(page, 'Rice', 'Mute');
  await expect.poll(() => directoryGroup(page, 'Ungrouped').locator('.lab-bot-row[data-muted]').count()).toBe(1);

  // Chats follow: the same order, the muted group quiet, Ink back in the default group after Rice, which is pinned.
  await go(page, 'Chats');
  const chats = page.locator('.lab-bot-roster-list');
  expect((await chats.locator('.lab-chat-group-title').allTextContents()).map(text => text.trim())).toEqual(['Research team', 'Notes', 'Ungrouped']);
  await expect(chats.locator('.lab-chat-group[data-muted]')).toHaveCount(1);
  expect(await names(chats.locator('.lab-chat-group').nth(2))).toEqual(['Rice', 'Ink']);
  expect(errors).toEqual([]);
});

test('moves an open assistant from its card and keeps it open at its new place', async ({ page }) => {
  await page.goto(url('&section=research&bot=scout'));
  const title = page.locator('.lab-assistant-top-bar button.lab-assistant-title');
  await expect(title).toContainText('Scout');
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click();
  const details = page.locator('.lab-assistant-details:visible, dialog.orchard-sheet[open]').first();
  // A phone's details sheet slides up; its menu opens once the sheet stands still.
  await details.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  await choose(details.getByRole('button', { name: 'More actions for Scout', exact: true }), 'Move to group…');
  await page.locator('dialog.orchard-sheet[open]').getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(/section=notes/);
  await expect(title).toContainText('Scout');
});

test.describe('in Chinese', () => {
  test.use({ locale: 'zh-CN' });
  test('words the groups in Chinese, with no stray English', async ({ page }) => {
    await page.goto(url());
    await expect(page.locator('.lab-chat-group-title').last()).toHaveText('未分组');
    await go(page, '助手');
    await expect(page.locator('.lab-directory').getByRole('button', { name: '新建分组', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '分组操作：研究', exact: true }).click();
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(expect.arrayContaining(['添加助手…', '重命名…', '免打扰', '通知…', '上移', '下移']));
    await page.keyboard.press('Escape');
    expect(await englishWords(page, { allow: ['Mac', 'mini', 'claude', 'Claude', 'Code', 'Codex'] })).toEqual([]);
  });
});
