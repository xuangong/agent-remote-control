// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Locator, type Page } from '@playwright/test';
import { contrastFailures } from './contrast.js';
import { coveringControls, panelOverlaps } from './covering.js';

// Desktop panels (I5a): the rail, the assistant list and the details each resize by a handle in the gap beside them, within a minimum
// and a maximum; the conversation fills the rest and keeps its own minimum; the widths are kept on this device. A double-click or Enter
// restores a default, the arrow keys move a handle. As the window narrows the details collapse first, then the list and the rail give
// way, and a narrow window is the phone. No panel overlaps another at any width from 800 px to ultra-wide.

const BOT = '/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief';
const STORAGE_KEY = 'agent-remote:panel-widths';

async function openBot(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${BOT}&theme=${theme}`);
  await page.locator('.lab-bot-conversation .agent-turn').first().waitFor();
}
const handle = (page: Page, name: 'Navigation width' | 'Assistant list width' | 'Details width') => page.getByRole('separator', { name, exact: true });
const widthOf = async (locator: Locator) => Math.round((await locator.boundingBox())!.width);
/** Drags a handle sideways by `by` pixels with the mouse. */
async function drag(page: Page, separator: Locator, by: number) {
  const box = (await separator.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by, y, { steps: 8 });
  await page.mouse.up();
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'The panels stand side by side on a desktop width.');

  for (const theme of ['light', 'dark'] as const) {
    test(`resizes the rail, the list and the details by their handles, keeps the widths and resets them, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openBot(page, theme);
      const rail = handle(page, 'Navigation width'), list = handle(page, 'Assistant list width'), details = handle(page, 'Details width');
      await expect(rail).toHaveAttribute('aria-valuenow', '60');
      await expect(list).toHaveAttribute('aria-valuenow', '260');
      await expect(details).toHaveAttribute('aria-valuenow', '300');
      await expect(list).toHaveAttribute('aria-valuetext', '260 pixels');
      await drag(page, rail, 80);
      await drag(page, list, 100);
      await drag(page, details, -50);
      await expect(rail).toHaveAttribute('aria-valuenow', '140');
      await expect(list).toHaveAttribute('aria-valuenow', '360');
      await expect(details).toHaveAttribute('aria-valuenow', '350');
      expect([await widthOf(page.locator('.lab-rail')), await widthOf(page.locator('.lab-bot-roster')), await widthOf(page.locator('.lab-assistant-details'))]).toEqual([140, 360, 350]);
      // A wide rail names its places beside their icons.
      await expect(page.locator('.lab-rail .lab-rail-label', { hasText: 'Chats' })).toBeVisible();
      // The panels keep the ground between them, the handles stay in the gaps, and nothing covers the conversation.
      const [roster, conversation, aside] = await Promise.all(['.lab-bot-roster', '.lab-bot-conversation', '.lab-assistant-details'].map(selector => page.locator(selector).boundingBox()));
      expect(Math.round(conversation!.x - (roster!.x + roster!.width))).toBe(10);
      expect(Math.round(aside!.x - (conversation!.x + conversation!.width))).toBe(10);
      expect(await panelOverlaps(page)).toEqual([]);
      expect(await coveringControls(page)).toEqual([]);
      expect(await contrastFailures(page)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`resized-panels-${theme}.png`) });
      // The widths are this device's: a new page opens with them.
      expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY))!)).toEqual({ rail: 140, sidebar: 360, details: 350 });
      await openBot(page, theme);
      expect([await widthOf(page.locator('.lab-rail')), await widthOf(page.locator('.lab-bot-roster')), await widthOf(page.locator('.lab-assistant-details'))]).toEqual([140, 360, 350]);
      // A double-click restores each default.
      for (const separator of [rail, list, details]) await separator.dblclick();
      await expect(rail).toHaveAttribute('aria-valuenow', '60');
      await expect(list).toHaveAttribute('aria-valuenow', '260');
      await expect(details).toHaveAttribute('aria-valuenow', '300');
      expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY))!)).toEqual({ rail: 60, sidebar: 260, details: 300 });
      // The details hold no handle: the list widened past their room collapses them once the drag ends, and narrowed again brings them
      // back. With the widest rail (200) and the widest list (420) the conversation keeps 1440 - 40 - 620 = 780.
      await rail.focus();
      await page.keyboard.press('End');
      await drag(page, list, 300);
      await expect(list).toHaveAttribute('aria-valuenow', '420');
      await expect(page.locator('.lab-assistant-details')).toBeHidden();
      expect(await widthOf(page.locator('.lab-bot-conversation'))).toBe(780);
      await list.focus();
      await page.keyboard.press('Home');
      await expect(page.locator('.lab-assistant-details')).toBeVisible();
      // On a wider window each handle stops at its panel's own maximum.
      await page.setViewportSize({ width: 1920, height: 900 });
      await drag(page, list, 300);
      await drag(page, details, -400);
      await expect(list).toHaveAttribute('aria-valuenow', '420');
      await expect(details).toHaveAttribute('aria-valuenow', '480');
      expect(await panelOverlaps(page)).toEqual([]);
    });
  }

  test('moves each handle with the arrow keys, Home and End, and restores it with Enter', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBot(page);
    const list = handle(page, 'Assistant list width'), details = handle(page, 'Details width'), rail = handle(page, 'Navigation width');
    await list.focus();
    await page.keyboard.press('ArrowRight');
    await expect(list).toHaveAttribute('aria-valuenow', '270');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(list).toHaveAttribute('aria-valuenow', '310');
    await page.keyboard.press('Home');
    await expect(list).toHaveAttribute('aria-valuenow', '220');
    await page.keyboard.press('End');
    await expect(list).toHaveAttribute('aria-valuenow', '420');
    await expect(list).toHaveAttribute('aria-valuemax', '420');
    await page.keyboard.press('Enter');
    await expect(list).toHaveAttribute('aria-valuenow', '260');
    // The details sit right of their handle: moving it left widens them.
    await details.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(details).toHaveAttribute('aria-valuenow', '310');
    await page.keyboard.press('ArrowRight');
    await expect(details).toHaveAttribute('aria-valuenow', '300');
    await rail.focus();
    await page.keyboard.press('End');
    await expect(rail).toHaveAttribute('aria-valuenow', '200');
    expect(await widthOf(page.locator('.lab-rail'))).toBe(200);
    // Tab reaches the handles in their order across the window.
    await rail.focus();
    await page.keyboard.press('Tab');
    await expect(list).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(details).toBeFocused();
  });

  test('collapses the details first as the window narrows, then the list and the rail give way, and a narrow window is the phone', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBot(page);
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ rail: 180, sidebar: 400, details: 300 })), STORAGE_KEY);
    await openBot(page);
    // 180 + 400 + 300 and the conversation's 511 need 1441 with the frame: the details wait to be opened at 1440.
    await expect(page.locator('.lab-assistant-details')).toBeHidden();
    await page.setViewportSize({ width: 1500, height: 900 });
    await expect(page.locator('.lab-assistant-details')).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(page.locator('.lab-assistant-details')).toBeHidden();
    // 1000 less the frame (40) and the conversation's minimum (511) leaves 449: the list gives way first, to 269.
    await expect(handle(page, 'Assistant list width')).toHaveAttribute('aria-valuenow', '269');
    await expect(handle(page, 'Navigation width')).toHaveAttribute('aria-valuenow', '180');
    expect(await widthOf(page.locator('.lab-bot-conversation'))).toBe(511);
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(handle(page, 'Assistant list width')).toHaveAttribute('aria-valuenow', '220');
    await expect(handle(page, 'Navigation width')).toHaveAttribute('aria-valuenow', '60');
    expect(await panelOverlaps(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('narrow-800.png') });
    // Opened by hand at 800, the details take their minimum beside the conversation, and nothing overlaps.
    await page.locator('.lab-assistant-top-bar button.lab-assistant-title').click();
    await expect(page.locator('.lab-assistant-details')).toBeVisible();
    expect(await widthOf(page.locator('.lab-assistant-details'))).toBe(260);
    expect(await panelOverlaps(page)).toEqual([]);
    // The kept widths come back as the window widens again.
    await page.setViewportSize({ width: 1500, height: 900 });
    await expect(handle(page, 'Assistant list width')).toHaveAttribute('aria-valuenow', '400');
    // At the phone width the rail and the handles give way to the phone's one panel at a time.
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(page.locator('.lab-bot-workspace')).toHaveAttribute('data-phone', 'true');
    await expect(page.locator('.lab-rail')).toHaveCount(0);
    await expect(page.locator('.lab-panel-handle')).toHaveCount(0);
    // The phone pushes the chat in from the side; once it has moved, it fills the screen.
    await expect.poll(() => panelOverlaps(page)).toEqual([]);
  });

  test('no panel overlaps another and no control covers the conversation from 800 px to 3440 px, at the minimum, default and maximum widths', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBot(page);
    for (const [name, stored] of [['minimum', { rail: 60, sidebar: 220, details: 260 }], ['default', undefined], ['maximum', { rail: 200, sidebar: 420, details: 480 }]] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(([key, value]) => { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); }, [STORAGE_KEY, stored ? JSON.stringify(stored) : ''] as const);
      await openBot(page);
      for (const width of [800, 1024, 1180, 1181, 1440, 1920, 2560, 3440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => panelOverlaps(page), `${name} widths at ${width} px`).toEqual([]);
        expect(await coveringControls(page), `${name} widths at ${width} px`).toEqual([]);
        // The conversation keeps its minimum wherever the list and the rail can still give way (from 831 px), and fills the rest.
        const conversation = (await page.locator('.lab-bot-conversation').boundingBox())!;
        if (width >= 831) expect(Math.round(conversation.width), `${name} widths at ${width} px`).toBeGreaterThanOrEqual(511);
        const panels = await Promise.all(['.lab-rail', '.lab-bot-roster', '.lab-bot-conversation', '.lab-assistant-details'].map(async selector => {
          const box = await page.locator(selector).boundingBox();
          return box && box.width > 0 ? box.x + box.width : 0;
        }));
        // No dead space: the last panel ends 10 px from the window's edge.
        expect(Math.round(width - Math.max(...panels)), `${name} widths at ${width} px`).toBe(10);
      }
    }
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'The phone shows one panel at a time.');

  for (const theme of ['light', 'dark'] as const) {
    test(`has no resize handle, and its one panel at a time overlaps nothing, ${theme}`, async ({ page }, testInfo) => {
      // Widths kept on a desktop do not reach the phone's layout.
      await page.goto(`${BOT}&theme=${theme}`);
      await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ rail: 200, sidebar: 420, details: 480 })), STORAGE_KEY);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${BOT}&theme=${theme}`);
      await page.locator('.lab-bot-conversation .agent-turn').first().waitFor();
      await expect(page.locator('.lab-panel-handle')).toHaveCount(0);
      await expect(page.locator('.lab-rail')).toHaveCount(0);
      const conversation = (await page.locator('.lab-bot-conversation').boundingBox())!;
      expect(Math.round(conversation.width)).toBe(page.viewportSize()!.width);
      expect(await panelOverlaps(page)).toEqual([]);
      expect(await coveringControls(page)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`phone-${theme}.png`) });
    });
  }
});
