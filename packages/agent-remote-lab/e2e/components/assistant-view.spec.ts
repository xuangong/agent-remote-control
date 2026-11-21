// Component projects: webkit-conversation, orchard-phone-chromium, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';
import { contrastFailures } from './contrast.js';
import { coveringControls } from './covering.js';

// Bot mode's three floating panels on the warm ground (I3 plan, Task B2): the assistants, the conversation and its details,
// 10 px apart with 22 px corners; below the compact width the details wait to be opened; both themes pass AA and no
// control floats over the conversation's text.

async function openBot(page: Page, query = '') {
  await page.goto(`/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief${query}`);
  await page.locator('.lab-bot-conversation .agent-turn').first().waitFor();
}
const box = (page: Page, selector: string) => page.locator(selector).first().boundingBox().then(value => value!);

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'The panels stand side by side on a desktop width.');

  for (const theme of ['light', 'dark'] as const) {
    test(`three panels 10 px apart with 22 px corners, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await openBot(page, `&theme=${theme}`);
      const panels = ['.lab-bot-roster', '.lab-bot-conversation', '.lab-assistant-details'];
      for (const selector of panels) await expect(page.locator(selector)).toBeVisible();
      const [roster, conversation, details] = await Promise.all(panels.map(selector => box(page, selector)));
      expect(Math.round(roster!.width)).toBe(260);
      expect(Math.round(details!.width)).toBe(300);
      expect(Math.round(conversation!.x - (roster!.x + roster!.width))).toBe(10);
      expect(Math.round(details!.x - (conversation!.x + conversation!.width))).toBe(10);
      for (const selector of panels) expect(await page.locator(selector).evaluate(node => getComputedStyle(node).borderTopLeftRadius)).toBe('22px');
      // The ground shows between the panels.
      const ground = await page.locator('.lab-bot-workspace').evaluate(node => getComputedStyle(node).backgroundColor);
      expect(ground).not.toBe(await page.locator('.lab-bot-conversation').evaluate(node => getComputedStyle(node).backgroundColor));
      // The top bar says what the assistant is doing, the same sentence as its row.
      await expect(page.locator('.lab-assistant-top-bar .lab-assistant-sentence')).toHaveText(await page.locator('.lab-bot-row[aria-current="true"] .lab-bot-sentence').innerText());
      expect(await contrastFailures(page)).toEqual([]);
      expect(await coveringControls(page)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`bot-mode-${theme}.png`) });
    });
  }

  test('at 1180 px the details wait to be opened and the conversation keeps its column', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await openBot(page);
    await expect(page.locator('.lab-bot-roster')).toBeVisible();
    await expect(page.locator('.lab-assistant-details')).toBeHidden();
    const title = page.locator('.lab-assistant-top-bar button.lab-assistant-title');
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    const turn = await box(page, '.lab-bot-conversation .agent-turn');
    const conversation = await box(page, '.lab-bot-conversation');
    expect(turn.width).toBeGreaterThanOrEqual(580);
    expect(turn.x).toBeGreaterThanOrEqual(conversation.x);
    expect(turn.x + turn.width).toBeLessThanOrEqual(conversation.x + conversation.width);
    expect(await coveringControls(page)).toEqual([]);
    // The name opens them beside the conversation, and Close puts them away.
    await title.click();
    await expect(page.locator('.lab-assistant-details')).toBeVisible();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: testInfo.outputPath('bot-mode-1180-details.png') });
    await page.locator('.lab-assistant-details').getByRole('button', { name: 'Close details' }).click();
    await expect(page.locator('.lab-assistant-details')).toBeHidden();
  });
});

// Window mode (I3 plan, Task B4): every tile is a floating panel on the same ground, with the assistant's header (avatar, name,
// sentence) and its details over the window; window and tile behaviour is unchanged.
test.describe('window', () => {
  test.skip(({ isMobile }) => isMobile, 'Tiles stand side by side on a desktop width; the phone stacks them.');

  for (const theme of ['light', 'dark'] as const) {
    test(`tiles are floating panels with the assistant's header, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/e2e/fixtures/window-tiles.html?tiles=3&bots=1');
      const tiles = page.locator('.lab-window-workbench .lab-primary-group');
      await expect(tiles).toHaveCount(3);
      await expect(page.locator('.lab-timeline-scroll').getByText('Item 1 of tile-1', { exact: false }).first()).toBeVisible();
      const boxes = await tiles.evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, radius: getComputedStyle(node).borderTopLeftRadius }; }));
      for (const box of boxes) expect(box.radius).toBe('22px');
      for (let index = 1; index < boxes.length; index++) expect(Math.round(boxes[index]!.left - boxes[index - 1]!.right)).toBe(10);
      const ground = await page.locator('.lab-window-workbench').evaluate(node => getComputedStyle(node).backgroundColor);
      expect(ground).not.toBe(await tiles.first().evaluate(node => getComputedStyle(node).backgroundColor));
      // Each header: the avatar, the name and one sentence; the session's title is the name of a bot.
      const header = tiles.first().locator('.lab-session-heading');
      await expect(header.locator('.lab-tile-avatar .orchard-avatar')).toBeVisible();
      await expect(header.locator('.lab-tile-identity .agent-session-title')).toHaveText('Reply with the words LOCAL and OK, tile 1');
      await expect(header.locator('.lab-tile-sentence')).toHaveText('Ready when you are');
      expect(await contrastFailures(page)).toEqual([]);
      expect(await coveringControls(page)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`window-mode-${theme}.png`) });
      // Its details open over the window.
      await header.getByRole('button', { name: /^Details of / }).click();
      const details = tiles.first().locator('.lab-tile-details');
      // The assistant is called by its name, never the session's title.
      await expect(details.locator('.lab-assistant-card-name')).toHaveText(await header.locator('.lab-tile-name').innerText());
      await expect(details.locator('.lab-assistant-card-name')).not.toHaveText('Reply with the words LOCAL and OK, tile 1');
      expect(await contrastFailures(page)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`window-mode-details-${theme}.png`) });
      await details.getByRole('button', { name: 'Close details' }).click();
      await expect(details).toBeHidden();
    });
  }

  test('a folded tile is the same assistant: its avatar is the header\'s', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/fixtures/window-tiles.html?tiles=3&bots=1');
    const tile = page.locator('.lab-window-workbench .lab-primary-group').nth(1);
    await expect(tile.locator('.lab-tile-avatar .orchard-avatar')).toBeVisible();
    const avatar = (scope: ReturnType<Page['locator']>) => scope.evaluate(node => { const svg = node.querySelector('.orchard-avatar'); return [svg?.getAttribute('data-shape'), svg?.querySelector<SVGPathElement>('.orchard-avatar-body')?.style.fill]; });
    const before = await avatar(tile.locator('.lab-tile-avatar'));
    await tile.getByRole('button', { name: /^Minimize primary group: / }).click();
    await expect(tile.locator('.lab-folded-bot')).toBeVisible();
    expect(await avatar(tile.locator('.lab-folded-bot-picture'))).toEqual(before);
  });
});
