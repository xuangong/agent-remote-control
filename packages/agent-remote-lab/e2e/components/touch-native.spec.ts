// Component projects: orchard-phone-webkit, orchard-phone-chromium, webkit-desktop
import { expect, test, type Page } from '@playwright/test';

// The installed app answers a finger like a native app: chrome is not text, text stays copyable, a press shows at once, no zoom.
const chrome = { searchButton: 'button[aria-label="Search this session"]', copyButton: 'button[aria-label="Copy text"]', title: 'h2', send: 'button[type="submit"]' };
const text = { message: 'article p', field: '.ProseMirror, textarea' };

/** `bare` leaves out the request cards, which cover the newest messages. */
async function open(page: Page, bare = false): Promise<void> {
  await page.goto(`/e2e/fixtures/question-input.html${bare ? '?bare' : ''}`);
  await page.locator(text.message).first().waitFor();
}
const style = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((node, property) => {
  const computed = getComputedStyle(node) as unknown as Record<string, string>;
  return computed[property] ?? computed[`webkit${property[0]!.toUpperCase()}${property.slice(1)}`] ?? '';
}, property);

test('app chrome is not selectable while message text and fields are', async ({ page }) => {
  test.setTimeout(30_000);
  await open(page, true);
  for (const selector of [chrome.searchButton, chrome.copyButton, chrome.title]) expect(await style(page, selector, 'userSelect'), selector).toBe('none');
  for (const selector of [text.message, text.field]) expect(await style(page, selector, 'userSelect'), selector).not.toBe('none');
  // A press and drag over the title selects nothing; over the message it selects the message.
  await page.locator(chrome.title).first().click({ clickCount: 3 });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
  await page.locator(text.message).last().click({ clickCount: 3 });
  expect(await page.evaluate(() => getSelection()?.toString().trim())).toContain('Earlier');
});

test('a tap neither flashes the browser highlight, nor opens a callout on chrome, nor waits to see a double tap', async ({ page }) => {
  test.setTimeout(30_000);
  await open(page);
  for (const selector of [chrome.searchButton, chrome.title, text.message, text.field]) {
    expect(await style(page, selector, 'touchAction'), `${selector} touch-action`).toBe('manipulation');
    expect(await style(page, selector, 'webkitTapHighlightColor'), `${selector} tap highlight`).toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
  }
  // Chromium has no callout property; WebKit reports it.
  const callout = await style(page, chrome.searchButton, 'webkitTouchCallout');
  if (callout) expect(callout).toBe('none');
});

test('the shell does not rubber-band as a whole and its scroll container keeps its own bounce', async ({ page }) => {
  test.setTimeout(30_000);
  await open(page);
  expect(await style(page, 'html', 'overscrollBehaviorY')).toBe('none');
  expect(await style(page, 'body', 'overscrollBehaviorY')).toBe('none');
  expect(await style(page, '.lab-timeline-scroll', 'overscrollBehaviorY')).not.toBe('none');
});

test('a press shows the pressed state in the next frame', async ({ page, browserName, hasTouch }) => {
  test.setTimeout(30_000);
  await open(page);
  const button = page.locator(chrome.searchButton).first();
  const box = (await button.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const pressedLayer = () => button.evaluate(node => new Promise<string>(resolve => requestAnimationFrame(() => resolve(getComputedStyle(node).backgroundImage))));
  expect(await pressedLayer()).toBe('none');
  const session = browserName === 'chromium' && hasTouch ? await page.context().newCDPSession(page) : undefined;
  if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  expect(await pressedLayer()).not.toBe('none');
  // Moving away before the release ends the press without a click.
  if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else { await page.mouse.move(2, 2); await page.mouse.up(); }
  expect(await pressedLayer()).toBe('none');
});

test('no field is small enough to zoom the page on focus, and a double tap does not zoom', async ({ page, hasTouch }) => {
  test.setTimeout(30_000);
  await open(page);
  const phone = hasTouch || (page.viewportSize()?.width ?? 2000) <= 1180;
  const sizes = await page.locator('input:not([type=checkbox]):not([type=radio]), textarea, select, .ProseMirror').evaluateAll(nodes =>
    nodes.map(node => ({ field: `${node.tagName.toLowerCase()}${node.getAttribute('name') ? `[${node.getAttribute('name')}]` : ''}`, size: parseFloat(getComputedStyle(node).fontSize) })));
  expect(sizes.length).toBeGreaterThan(0);
  if (phone) expect(sizes.filter(({ size }) => size < 16)).toEqual([]);
  if (!hasTouch) return;
  const scale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
  await page.locator('input[name="directory-custom"]').tap();
  expect(await scale()).toBe(1);
  await open(page, true);
  const message = page.locator(text.message).last();
  await message.tap(); await message.tap();
  expect(await scale()).toBe(1);
});
