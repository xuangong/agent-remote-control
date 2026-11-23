// Component projects: webkit-conversation, webkit-mobile-viewport, orchard-phone-chromium
import { expect, test, type Page } from '@playwright/test';
import { coveringControls } from './covering.js';

// The Track and Window launchers never cover the conversation's text or the composer. On a compact screen they sit in a
// row of the navigation that the layout reserves, so the rule holds for any number of launchers; on a wide screen without the
// sidebar they float in the margin beside the reading column.
/** A launcher's button, never the rail's or the tab bar's destinations. */
const launcherButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).and(page.locator(':not(.lab-rail *, .lab-tab-bar *)'));
const launcherSelector = '.lab-launcher, .lab-tracking-floating, .lab-sidebar-shortcut';

async function coverage(page: Page) {
  return page.evaluate(selector => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const shown = (element: Element) => { const style = getComputedStyle(element); return style.visibility !== 'hidden' && style.display !== 'none'; };
    const launchers = [...document.querySelectorAll(selector)].filter(shown)
      .map(element => ({ name: element.querySelector('button')?.getAttribute('aria-label') ?? element.className, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    // The text the conversation shows: every line box of its text, clipped to the visible part of the timeline.
    const scroller = document.querySelector('.lab-timeline-scroll')!.getBoundingClientRect();
    const lines: Box[] = [];
    const walker = document.createTreeWalker(document.querySelector('.lab-timeline-scroll')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const line = { left: rect.left, right: rect.right, top: Math.max(rect.top, scroller.top), bottom: Math.min(rect.bottom, scroller.bottom) };
        if (line.bottom > line.top && rect.width > 0) lines.push(line);
      }
    }
    const composer = [...document.querySelectorAll('.lab-composer-dock')].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0);
    return {
      launchers: launchers.map(({ name, rect }) => ({ name, width: rect.width, height: rect.height })),
      lines: lines.length,
      composers: composer.length,
      covered: launchers.flatMap(({ name, rect }) => [
        ...(lines.some(line => meets(rect, line)) ? [`${name} covers conversation text`] : []),
        ...(composer.some(box => meets(rect, box)) ? [`${name} covers the composer`] : []),
      ]),
    };
  }, launcherSelector);
}

async function openLongConversation(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  // Track shows by default only on a touch screen and Ask only when chosen; the person can show each anywhere.
  await page.addInitScript(() => { for (const view of ['track', 'window', 'ask']) localStorage.setItem(`agent-remote:${view}-view`, 'true'); });
  await page.goto('/e2e/fixtures/session-stars.html?long');
  await expect(page.getByText('Item 30.', { exact: false })).toBeVisible();
}

test('at 390x844 the launchers take their own row and cover no conversation text or composer, however many there are', async ({ page }, testInfo) => {
  await openLongConversation(page, 390, 844);
  for (const name of ['Tracked sessions', 'Groups']) await expect(launcherButton(page, name)).toBeVisible();
  const shown = await coverage(page);
  // Track, Window and Ask.
  expect(shown.launchers.length).toBeGreaterThanOrEqual(3);
  expect(shown.lines).toBeGreaterThan(0);
  expect(shown.composers).toBeGreaterThan(0);
  expect(shown.covered).toEqual([]);
  for (const launcher of shown.launchers) expect(launcher.height, launcher.name).toBeGreaterThanOrEqual(44);
  // The launcher row is the navigation's only second line: a long title shrinks beside Sessions.
  const sessions = (await page.getByRole('button', { name: 'Open sessions', exact: true }).boundingBox())!, title = (await page.getByRole('button', { name: 'Favorites', exact: true }).boundingBox())!;
  expect(Math.abs(title.y - sessions.y)).toBeLessThanOrEqual(2);
  expect(title.x + title.width).toBeLessThanOrEqual(390);
  // No fixed or absolutely positioned control of any kind covers the conversation's text.
  expect(await coveringControls(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('launchers-390.png') });

  // More launchers than fit on one line wrap into another reserved line instead of covering the conversation.
  await page.evaluate(() => {
    const bar = document.querySelector('.lab-launcher-bar')!;
    for (const launcher of [...bar.querySelectorAll('.lab-launcher')]) bar.append(launcher.cloneNode(true));
  });
  const doubled = await coverage(page);
  expect(doubled.launchers).toHaveLength(2 * shown.launchers.length);
  expect(doubled.lines).toBeGreaterThan(0);
  expect(doubled.covered).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('launchers-390-doubled.png') });
});

test('a launcher panel opens under the navigation and its launcher stays in place', async ({ page }) => {
  await openLongConversation(page, 390, 844);
  const trigger = launcherButton(page, 'Groups');
  const before = await trigger.boundingBox();
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Groups', exact: true });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!, navigation = (await page.getByRole('navigation', { name: 'Session navigation' }).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(navigation.y + navigation.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await trigger.boundingBox()).toEqual(before);
  await panel.getByRole('button', { name: 'Close groups' }).click();
  await expect(panel).toBeHidden();
});

for (const width of [1440, 1181]) {
  test(`at ${width}px the launchers cover no conversation text or composer`, async ({ page, isMobile }, testInfo) => {
    test.skip(isMobile, 'A desktop viewport on a desktop profile');
    await openLongConversation(page, width, 900);
    await expect(launcherButton(page, 'Groups')).toBeVisible();
    const found = await coverage(page);
    expect(found.launchers.length).toBeGreaterThan(0);
    expect(found.lines).toBeGreaterThan(0);
    expect(found.composers).toBeGreaterThan(0);
    expect(found.covered).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`launchers-${width}.png`) });
  });
}

// The tiles of a Window can fill the width, leaving no margin to float in: the entries then take a row of the Window's toolbar
// on a wide screen, or the launcher bar on a compact one. The rule holds with the sidebar shown or hidden, for 1, 2 and 3 tiles.
for (const width of [1024, 1280, 1440]) {
  for (const tiles of [1, 2, 3]) {
    test(`at ${width}px with ${tiles} tile${tiles > 1 ? 's' : ''}, no control covers a tile's conversation text`, async ({ page, isMobile }, testInfo) => {
      test.skip(isMobile, 'A desktop viewport on a desktop profile');
      await page.setViewportSize({ width, height: 860 });
      await page.addInitScript(() => { for (const view of ['track', 'window', 'ask']) localStorage.setItem(`agent-remote:${view}-view`, 'true'); });
      await page.goto(`/e2e/fixtures/window-tiles.html?tiles=${tiles}`);
      // A compact screen opens on its sessions drawer when the address names no session.
      if (width <= 1180) await page.locator('#lab-context').getByRole('button', { name: 'Close', exact: false }).first().click();
      await expect(page.locator('.lab-timeline-scroll').getByText('Item 1 of tile-1', { exact: false }).first()).toBeVisible();
      // A compact screen keeps the entries in its launcher bar; a wide one in the sidebar's Shortcuts.
      await expect(page.locator(width > 1180 ? '.lab-sidebar-shortcut' : '.lab-launcher-bar .lab-launcher').first()).toBeVisible();
      expect(await coveringControls(page)).toEqual([]);
      if (width > 1180) {
        // Hiding the sidebar moves the entries out of it, into the Window's toolbar.
        await page.evaluate(() => {
          const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform, apple = /mac|iphone|ipad/i.test(platform);
          window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: !apple, metaKey: apple, bubbles: true, cancelable: true }));
        });
        await expect(page.locator('.lab-toolbar-launchers').getByRole('button', { name: 'Groups', exact: true })).toBeVisible();
        expect(await coveringControls(page)).toEqual([]);
      }
      await page.screenshot({ path: testInfo.outputPath(`tiles-${width}-${tiles}.png`) });
    });
  }
}
