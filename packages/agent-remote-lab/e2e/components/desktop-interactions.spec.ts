// Component projects: webkit-desktop
import { expect, test, type Page } from '@playwright/test';

// The desktop's keyboard and context menus over the real Workbench on builder data (I5d): the shortcuts sheet, a new chat, F6
// between the panels, a chat's menu and a message's menu (Copy with its formatting, Quote into the composer), and the browser's
// own menu over text the reader selected.
test.skip(({ isMobile }) => isMobile, 'Keyboard shortcuts and context menus are the desktop\'s.');
const url = '/e2e/fixtures/window-tiles.html?tiles=3&bots=1&mode=bot&users=3';

/** What the page puts on the clipboard, recorded in the page: a headless browser has no clipboard of its own to read back. */
async function recordClipboard(page: Page) {
  await page.addInitScript(() => {
    const written: { text?: string; html?: string }[] = [];
    (window as unknown as { clipboardWrites: typeof written }).clipboardWrites = written;
    const read = (blob: Blob) => new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { written.push({ text }); },
      write: async (items: ClipboardItem[]) => {
        for (const item of items) written.push({ text: await read(await item.getType('text/plain')), ...(item.types.includes('text/html') ? { html: await read(await item.getType('text/html')) } : {}) });
      },
    } });
  });
}

/** The primary modifier as the page decides it (kernel/platform.ts): a desktop device may report another system than the host's. */
const primaryKey = (page: Page) => page.evaluate(() => /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform) ? 'Meta' : 'Control');

async function openChat(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const bot = page.locator('[data-workbench-mode="bot"]');
  await bot.locator('[data-bot-place]').first().click();
  await expect(bot.getByTestId('prompt-input').locator('visible=true')).toHaveCount(1);
  await expect(bot.locator('.agent-message-assistant').first()).toBeVisible();
  return bot;
}

test('⌘/ lists the shortcuts in groups; Escape closes the sheet, and ⌘/ closes it too', async ({ page }) => {
  await openChat(page);
  const primary = await primaryKey(page);
  await page.keyboard.press(`${primary}+Slash`);
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { level: 3 })).toHaveText(['General', 'Getting around', 'In a conversation']);
  await expect(sheet.locator('dt')).toContainText(['Search, or switch to an assistant', 'New assistant', 'Next panel', 'Send', 'New line']);
  await expect(sheet.locator('.lab-shortcuts-row', { hasText: 'New assistant' }).locator('kbd')).toHaveText(primary === 'Meta' ? '⇧⌘O' : 'Ctrl+Shift+O');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.keyboard.press(`${primary}+Slash`);
  await expect(sheet).toBeVisible();
  await page.keyboard.press(`${primary}+Slash`);
  await expect(sheet).toBeHidden();
});

test('⇧⌘O starts a new assistant in Bot mode, and the palette shows the same keys', async ({ page }) => {
  await openChat(page);
  const primary = await primaryKey(page);
  await page.keyboard.press(`${primary}+Shift+KeyO`);
  await expect(page.getByRole('dialog', { name: 'New assistant' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'New assistant' })).toBeHidden();
  await page.keyboard.press(`${primary}+KeyK`);
  const option = page.getByRole('option', { name: /New assistant/ });
  await expect(option).toHaveAttribute('aria-keyshortcuts', /^(Shift\+Meta|Control\+Shift)\+O$/);
});

test('F6 moves the focus to the next panel and Shift-F6 back: the rail, the chat in the list, the composer, the details', async ({ page }) => {
  const bot = await openChat(page);
  await page.locator('.lab-rail').getByRole('button', { name: 'Chats', exact: true }).focus();
  await page.keyboard.press('F6');
  await expect(bot.locator('.lab-bot-row[aria-current="true"]')).toBeFocused();
  await page.keyboard.press('F6');
  await expect(bot.getByTestId('prompt-input').locator('visible=true')).toBeFocused();
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.lab-assistant-details'))).toBe(true);
  await page.keyboard.press('F6');
  await expect(page.locator('.lab-rail').getByRole('button', { name: 'Chats', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.lab-assistant-details'))).toBe(true);
  await page.keyboard.press('Shift+F6');
  await expect(bot.getByTestId('prompt-input').locator('visible=true')).toBeFocused();
});

test('a chat\'s context menu offers pin, mute, rename and move; Shift-F10 opens it from the keyboard and Escape returns to the row', async ({ page }) => {
  const bot = await openChat(page);
  const row = bot.locator('[data-bot-place]').nth(1);
  const name = (await row.getAttribute('aria-label'))!;
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `More actions for ${name}` });
  await expect(menu.getByRole('menuitem')).toHaveText(['Pin to top', 'Mute', 'Rename…', 'Move to group…', 'Remove from “Tiles”']);
  await menu.getByRole('menuitem', { name: 'Pin to top' }).click();
  await expect(menu).toBeHidden();
  await expect(bot.locator('.lab-bot-row', { has: page.getByRole('img', { name: 'Pinned' }) }).first()).toHaveAttribute('aria-label', name);
  const pinned = bot.locator(`.lab-bot-row[aria-label="${name}"]`);
  await pinned.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await expect(menu.getByRole('menuitem').first()).toHaveText('Unpin');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(pinned).toBeFocused();
  // Rename… names the assistant on every device.
  await pinned.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Rename…' }).click();
  const sheet = page.getByRole('dialog', { name: `Rename “${name}”` });
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Renamed helper');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(bot.locator('.lab-bot-row[aria-label="Renamed helper"]')).toBeVisible();
});

test('a message\'s context menu copies it with its formatting and quotes it into the composer; selected text keeps the browser\'s menu', async ({ page }) => {
  await recordClipboard(page);
  const bot = await openChat(page);
  const reply = bot.locator('.agent-timeline-entry', { has: page.locator('.agent-message-assistant') }).last();
  const text = (await reply.locator('.agent-message').innerText()).trim();
  await reply.locator('.agent-message').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Copy', 'Quote']);
  await menu.getByRole('menuitem', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { clipboardWrites: { text?: string; html?: string }[] }).clipboardWrites.at(-1))).toMatchObject({
    text: expect.stringContaining(text.slice(0, 20)), html: expect.stringMatching(/^<div><p>/) });
  await reply.locator('.agent-message').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Quote' }).click();
  const editor = bot.getByTestId('prompt-input').locator('visible=true');
  await expect(editor).toBeFocused();
  await expect(editor).toContainText(`> ${text.slice(0, 20)}`);
  // Over text the reader selected, the browser's own menu stays: the page opens none.
  await reply.locator('.agent-message p').first().evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await reply.locator('.agent-message p').first().click({ button: 'right' });
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => String(window.getSelection()).trim().length)).toBeGreaterThan(20);
});
