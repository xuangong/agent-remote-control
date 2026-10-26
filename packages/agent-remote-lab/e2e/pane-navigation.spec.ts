import { expect, test, type Page } from '@playwright/test';

const fixture = '/e2e/fixtures/session-family-resize.html';
const pane = (page: Page, name: string) => page.locator(`.lab-session-family-pane[aria-label="${name}"]`);
const selected = (page: Page) => page.locator('.lab-session-family-pane[data-selected]').getAttribute('aria-label');

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${fixture}?content`);
  await expect(page.getByRole('separator')).toHaveCount(6);
  const rail = page.locator('.lab-session-dock-rail');
  await expect.poll(() => rail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(400);
  return rail;
}

test('a horizontal mouse wheel over a conversation, its heading or its composer scrolls the window rail', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Wide layouts have a horizontal window rail.');
  const rail = await open(page);
  // Containing overscroll in every direction stops a sideways wheel in some browsers; the rail must still scroll.
  await page.locator('.lab-timeline-scroll').evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).style.overscrollBehavior = 'contain'; }));
  for (const name of ['Primary', 'Dock']) {
    for (const selector of ['.lab-timeline-scroll', '.lab-session-heading', '.lab-composer-dock']) {
      const target = pane(page, name).locator(selector).first();
      await rail.evaluate(element => { element.scrollLeft = 0; });
      await target.scrollIntoViewIfNeeded();
      const start = await rail.evaluate(element => element.scrollLeft);
      const box = (await target.boundingBox())!;
      // Inside the conversation, away from tables and code blocks, which scroll on their own.
      await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height, 900) - Math.min(40, box.height / 2));
      await page.mouse.wheel(150, 0);
      await expect.poll(() => rail.evaluate(element => element.scrollLeft), { message: `${name} ${selector}` }).toBeGreaterThan(start + 100);
      await page.mouse.wheel(-150, 0);
      await expect.poll(() => rail.evaluate(element => element.scrollLeft), { message: `${name} ${selector}` }).toBe(start);
    }
  }
});

test('the mouse back and forward buttons select the adjacent session view and bring it into view without leaving the page', async ({ page, isMobile, browserName }) => {
  test.skip(isMobile || browserName !== 'chromium', 'Presses the back and forward buttons through Chromium input events.');
  // A previous page, so an unhandled back button would leave the Window.
  await page.goto('/e2e/fixtures/session-stars.html');
  const rail = await open(page);
  const start = page.url();
  await rail.evaluate(element => { element.scrollLeft = 0; });
  const cdp = await page.context().newCDPSession(page);
  // Always over the first pane, which must not take the selection just because the button is pressed over it.
  const point = (await pane(page, 'Primary').boundingBox())!;
  const press = async (button: 'back' | 'forward') => {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: point.x + 60, y: point.y + 200, button, clickCount: 1 });
    }
  };
  const visible = async (name: string) => {
    const edge = (await rail.boundingBox())!;
    const box = (await pane(page, name).boundingBox())!;
    return box.x >= edge.x - 1 && box.x + box.width <= edge.x + edge.width + 1;
  };
  expect(await selected(page)).toBe('Primary');
  for (const name of ['Primary child', 'Primary leaf', 'Dock', 'Dock child', 'Dock leaf']) {
    await press('forward');
    await expect.poll(() => selected(page)).toBe(name);
    await expect.poll(() => visible(name)).toBe(true);
  }
  await press('forward');
  await page.waitForTimeout(200);
  expect(await selected(page)).toBe('Dock leaf');
  for (const name of ['Dock child', 'Dock', 'Primary leaf', 'Primary child', 'Primary']) {
    await press('back');
    await expect.poll(() => selected(page)).toBe(name);
    await expect.poll(() => visible(name)).toBe(true);
  }
  await press('back');
  await page.waitForTimeout(500);
  expect(await selected(page)).toBe('Primary');
  await expect.poll(() => rail.evaluate(element => element.scrollLeft)).toBe(0);
  expect(page.url()).toBe(start);
});
