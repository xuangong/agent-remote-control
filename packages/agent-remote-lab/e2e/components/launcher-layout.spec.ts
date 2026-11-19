import { expect, test, type Page } from '@playwright/test';

// The Track, Team, TPM and Window launchers never cover the conversation's text or the composer. On a compact screen they sit in a
// row of the navigation that the layout reserves, so the rule holds for any number of launchers; on a wide screen without the
// sidebar they float in the margin beside the reading column.
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
  // Track and TPM show by default only on a touch screen and Ask only when chosen; the person can show each anywhere.
  await page.addInitScript(() => { for (const view of ['track', 'team', 'tpm', 'window', 'ask']) localStorage.setItem(`agent-remote:${view}-view`, 'true'); });
  await page.goto('/e2e/fixtures/session-stars.html?long');
  await expect(page.getByText('Item 30.', { exact: false })).toBeVisible();
}

test('at 390x844 the launchers take their own row and cover no conversation text or composer, however many there are', async ({ page }, testInfo) => {
  await openLongConversation(page, 390, 844);
  for (const name of ['Tracked sessions', 'Teams', 'TPM works', 'Windows']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  const four = await coverage(page);
  expect(four.launchers.length).toBeGreaterThanOrEqual(4);
  expect(four.lines).toBeGreaterThan(0);
  expect(four.composers).toBeGreaterThan(0);
  expect(four.covered).toEqual([]);
  for (const launcher of four.launchers) expect(launcher.height, launcher.name).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath('launchers-390.png') });

  // More launchers than fit on one line wrap into another reserved line instead of covering the conversation.
  await page.evaluate(() => {
    const bar = document.querySelector('.lab-launcher-bar')!;
    for (const launcher of [...bar.querySelectorAll('.lab-launcher')]) bar.append(launcher.cloneNode(true));
  });
  const eight = await coverage(page);
  expect(eight.launchers).toHaveLength(2 * four.launchers.length);
  expect(eight.lines).toBeGreaterThan(0);
  expect(eight.covered).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('launchers-390-eight.png') });
});

test('a launcher panel opens under the navigation and its launcher stays in place', async ({ page }) => {
  await openLongConversation(page, 390, 844);
  const trigger = page.getByRole('button', { name: 'Windows', exact: true });
  const before = await trigger.boundingBox();
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Windows', exact: true });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!, navigation = (await page.getByRole('navigation', { name: 'Session navigation' }).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(navigation.y + navigation.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await trigger.boundingBox()).toEqual(before);
  await panel.getByRole('button', { name: 'Close Windows' }).click();
  await expect(panel).toBeHidden();
});

for (const width of [1440, 1181]) {
  test(`at ${width}px the launchers cover no conversation text or composer`, async ({ page, isMobile }, testInfo) => {
    test.skip(isMobile, 'A desktop viewport on a desktop profile');
    await openLongConversation(page, width, 900);
    await expect(page.getByRole('button', { name: 'Windows', exact: true })).toBeVisible();
    const found = await coverage(page);
    expect(found.launchers.length).toBeGreaterThan(0);
    expect(found.lines).toBeGreaterThan(0);
    expect(found.composers).toBeGreaterThan(0);
    expect(found.covered).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`launchers-${width}.png`) });
  });
}
