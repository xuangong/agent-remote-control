import { expect, test, type Locator, type Page } from '@playwright/test';
import { contrastFailures } from './contrast.js';
import { coveringControls } from './covering.js';

// The phone (I3 plan, decision 14 and Task B6), at 390 x 844: the assistant list is home, a conversation is full screen with
// a way back (Back, the browser's back, a swipe from the left edge), details are a sheet that clears the home indicator, a
// window is a stack of tiles swiped through, the composer stays above the keyboard, and Return makes a new line.

test.skip(({ viewport }) => (viewport?.width ?? 0) > 430, 'A phone width.');

async function home(page: Page, query = '') {
  await page.goto(`/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot${query}`);
  await expect(page.locator(query.includes('bot=') ? '.lab-bot-conversation' : '.lab-bot-roster')).toBeVisible();
}
/** A swipe from `from` to `to` on `target`, as touch events carry it. */
async function swipe(target: Locator, from: { x: number; y: number }, to: { x: number; y: number }) {
  await target.evaluate((node, { from, to }) => {
    const touch = (point: { x: number; y: number }) => ({ clientX: point.x, clientY: point.y, identifier: 1, target: node });
    for (const [type, point, list] of [['touchstart', from, 'touches'], ['touchend', to, 'changedTouches']] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [touch(point)] : [] });
      Object.defineProperty(event, 'changedTouches', { value: [touch(point)] });
      void list;
      node.dispatchEvent(event);
    }
  }, { from, to });
}

test('a long name is cut short in the top bar, which leaves Back and the conversation\'s tools reachable', async ({ page }) => {
  await home(page, '&section=notes&bot=chief&longName=1');
  const bar = page.locator('.lab-assistant-top-bar');
  const back = bar.getByRole('button', { name: 'Back to assistants', exact: true });
  const title = bar.locator('button.lab-assistant-title');
  await expect(title).toBeVisible();
  const [backBox, titleBox, toolsBox] = await Promise.all([back.boundingBox(), title.boundingBox(), bar.locator('.lab-assistant-top-bar-trailing').boundingBox()]);
  expect(titleBox!.x).toBeGreaterThanOrEqual(backBox!.x + backBox!.width - 1);
  expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(toolsBox!.x + 1);
  expect(await title.locator('.lab-assistant-name').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  // Its details sheet keeps a long session title on one cut row, never wider than the screen.
  await title.click();
  const sheet = page.locator('dialog.orchard-sheet[open]');
  await expect(sheet.locator('ol.lab-assistant-chain li').first()).toBeVisible();
  expect(await sheet.locator('.lab-assistant-details-body').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  const card = await sheet.locator('.lab-assistant-card').boundingBox();
  expect(card!.x + card!.width).toBeLessThanOrEqual(390);
  await sheet.getByRole('button', { name: 'Close', exact: false }).first().click();
  await back.click();
  await expect(page.locator('.lab-bot-roster')).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the list is home; a conversation opens full screen and Back, the browser and an edge swipe return to the list where it was, ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await home(page, `&assistants=24&theme=${theme}`);
    await expect(page.locator('.lab-bot-conversation')).toBeHidden();
    expect(await contrastFailures(page)).toEqual([]);
    expect(await coveringControls(page, '.lab-bot-roster')).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`phone-list-${theme}.png`) });
    const roster = page.locator('.lab-bot-roster');
    await roster.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button', { name: 'Chief', exact: true }).click();
    await expect(page.locator('.lab-bot-conversation')).toBeVisible();
    await expect(roster).toBeHidden();
    await page.locator('.lab-bot-conversation .agent-turn').first().waitFor();
    expect(await contrastFailures(page)).toEqual([]);
    expect(await coveringControls(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`phone-conversation-${theme}.png`) });
    // The browser's back returns to the list.
    await page.goBack();
    await expect(roster).toBeVisible();
    await expect(page.locator('.lab-bot-conversation')).toBeHidden();
    // From further down the list, a conversation and back keep the list where it was.
    await roster.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const scrolled = await roster.evaluate(node => node.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Helper 20', exact: true }).click();
    await expect(page.locator('.lab-bot-conversation')).toBeVisible();
    // A swipe from the left edge goes back, as in a native navigation stack.
    await swipe(page.locator('.lab-bot-conversation'), { x: 8, y: 400 }, { x: 260, y: 410 });
    await expect(roster).toBeVisible();
    expect(Math.abs(await roster.evaluate(node => node.scrollTop) - scrolled)).toBeLessThanOrEqual(1);
    // The top bar's Back too.
    await page.getByRole('button', { name: 'Chief', exact: true }).click();
    await page.getByRole('button', { name: 'Back to assistants', exact: true }).click();
    await expect(roster).toBeVisible();
  });
}

test("details open as a sheet from the assistant's name and clear the home indicator", async ({ page }, testInfo) => {
  await home(page, '&section=notes&bot=chief');
  // An iPhone's home indicator.
  await page.evaluate(() => document.documentElement.style.setProperty('--orchard-safe-area-bottom', '34px'));
  const title = page.locator('.lab-assistant-top-bar button.lab-assistant-title');
  await title.click();
  const sheet = page.locator('dialog.orchard-sheet[open]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.lab-assistant-card-name')).toHaveText('Chief');
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  expect(await sheet.locator('.orchard-sheet-body').evaluate(node => getComputedStyle(node).paddingBottom)).toBe('48px');
  expect(await coveringControls(page, '.orchard-sheet-body')).toEqual([]);
  expect(await contrastFailures(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('phone-details-sheet.png') });
  await sheet.getByRole('button', { name: 'Close', exact: false }).first().click();
  await expect(sheet).toHaveCount(0);
});

test('a window is a stack of tiles: a swipe moves one tile and the indicator follows', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/window-tiles.html?tiles=3');
  const close = page.locator('#lab-context').getByRole('button', { name: 'Close', exact: false }).first();
  if (await close.isVisible()) await close.click();
  const track = page.locator('.lab-tile-stack-track');
  await expect(track).toBeVisible();
  const pages = page.locator('.lab-tile-stack-pages > button');
  await expect(pages).toHaveCount(3);
  await expect(pages.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.lab-timeline-scroll').getByText('Item 1 of tile-1', { exact: false }).first()).toBeVisible();
  expect(await coveringControls(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('phone-tile-stack.png') });
  // A swipe settles one tile further: that tile is presented, and the indicator moves with it.
  await track.evaluate(node => node.scrollTo({ left: node.clientWidth }));
  await expect(pages.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.lab-tile-stack-page').nth(1).locator('.lab-timeline-scroll').getByText('Item 1 of tile-2', { exact: false }).first()).toBeVisible();
  expect(Math.round(await track.evaluate(node => node.scrollLeft / node.clientWidth))).toBe(1);
  // The indicator presents a tile too.
  await pages.nth(2).click();
  await expect(pages.nth(2)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => track.evaluate(node => Math.round(node.scrollLeft / node.clientWidth))).toBe(2);
});

test('the composer stays above the keyboard without the conversation jumping, and Return makes a new line', async ({ page, browserName }) => {
  await home(page, '&section=notes&bot=chief&pending=none');
  const editor = page.locator('.lab-bot-conversation').getByRole('textbox', { name: 'Message' });
  await expect(editor).toBeVisible();
  const last = page.locator('.lab-bot-conversation .agent-timeline-entry').last();
  const gap = async () => { const composer = (await page.locator('.lab-bot-conversation .lab-composer-dock').boundingBox())!; const bubble = (await last.boundingBox())!; return composer.y - (bubble.y + bubble.height); };
  const before = await gap();
  // The keyboard takes the lower part of the screen.
  await page.setViewportSize({ width: 390, height: 520 });
  await expect.poll(async () => (await page.locator('.lab-bot-conversation .lab-composer-dock').boundingBox())!.y + 1).toBeLessThan(520);
  expect(Math.abs(await gap() - before)).toBeLessThanOrEqual(1);
  // Under a coarse pointer Return inserts a line; Send sends.
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  await editor.click();
  await page.keyboard.type('First line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  const text = () => editor.evaluate(node => node instanceof HTMLTextAreaElement ? node.value : (node as HTMLElement).innerText);
  if (coarse) expect(await text()).toMatch(/First line\n+second line/);
  void browserName;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(text).toBe('');
});

test('every control on the phone screens is at least 44 px under a coarse pointer', async ({ page }) => {
  await home(page);
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  test.skip(!coarse, 'Only a coarse pointer needs 44 px targets.');
  const small = () => page.locator('.lab-bot-workspace').evaluate(root => [...root.querySelectorAll('button, a[href], [role="button"]')]
    .filter(node => (node as HTMLElement).offsetParent !== null && !node.closest('.lab-bot-directory-controls, .lab-bot-other'))
    .map(node => { const box = node.getBoundingClientRect(); return { name: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 24), width: Math.round(box.width), height: Math.round(box.height) }; })
    .filter(box => box.height < 44 || box.width < 44));
  expect(await small()).toEqual([]);
  await page.getByRole('button', { name: 'Chief', exact: true }).click();
  await page.locator('.lab-bot-conversation .lab-assistant-top-bar').waitFor();
  const bar = await page.locator('.lab-bot-conversation .lab-assistant-top-bar').evaluate(root => [...root.querySelectorAll('button')]
    .map(node => { const box = node.getBoundingClientRect(); return { name: node.getAttribute('aria-label'), height: Math.round(box.height), width: Math.round(box.width) }; })
    .filter(box => box.height < 44 || box.width < 44));
  expect(bar).toEqual([]);
});
