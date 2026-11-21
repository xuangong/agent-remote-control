// Component projects: orchard-phone-chromium
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { draftOf, lowerKeyboard, openConversation, raiseKeyboard } from './phone-conversation.js';

// Trusted touch: only the browser decides whether a touch stream that starts on the composer or one of its controls reaches the page as
// cancelable events (a passive or already-scrolling stream is not). The hook's own decisions are unit tested
// (`useComposerKeyboardDismiss`, `useSendButtonPress`); these tests send real touches through Chromium's DevTools protocol, which WebKit
// has no equivalent for, so they run on Chromium alone.
test.beforeEach(({ browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'Trusted touch injection uses Chromium CDP.');
});

const KEYBOARD = { height: 420, offsetTop: 160 };

async function withKeyboard(page: Page, draft: string) {
  const input = await openConversation(page);
  await input.fill(draft);
  await input.focus();
  await raiseKeyboard(page, KEYBOARD);
  await keyboardSettled(page, input);
  return input;
}

/** The shell applies the keyboard's bounds in its next animation frame; a touch aimed at a control must wait for its final place. */
async function keyboardSettled(page: Page, input: Locator) {
  await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'true');
  await expect(page.locator('.lab-shell')).toHaveCSS('top', `${KEYBOARD.offsetTop}px`);
  await expect(input).toBeFocused();
}

const touch = (cdp: CDPSession) => (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x, y, radiusX: 1, radiusY: 1, force: 1 }] });

/** Records the touch events that reach the composer's boundary, and where the middle of `target` is. */
async function recordTouches(target: Locator) {
  return target.evaluate(element => {
    const boundary = element.closest('.lab-composer-input-shell')!;
    const events: Array<{ type: string; trusted: boolean; prevented: boolean; focused: boolean }> = [];
    (window as unknown as { touches: typeof events }).touches = events;
    for (const type of ['touchmove']) boundary.addEventListener(type, event => events.push({ type: event.type, trusted: event.isTrusted, prevented: event.defaultPrevented, focused: document.activeElement?.getAttribute('data-testid') === 'prompt-input' }));
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
}
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { touches: Array<{ trusted: boolean; prevented: boolean; focused: boolean }> }).touches);

test('a native drag that starts on a composer control dismisses the keyboard, keeps the draft and the page still, and activates nothing', async ({ page }, info) => {
  const draft = 'Keep the composer open and its controls inactive during a drag';
  const input = await withKeyboard(page, draft);
  const dock = page.locator('.lab-composer-dock');
  const cdp = await page.context().newCDPSession(page);
  const send = touch(cdp);
  const observations = [];
  try {
    for (const control of [dock.getByRole('button', { name: 'More actions', exact: true }), dock.getByRole('button', { name: 'Hide message input', exact: true }), dock.getByTestId('prompt-submit')]) {
      await expect(control).toBeVisible();
      const start = await recordTouches(control);
      await send('touchStart', start.x, start.y);
      await send('touchMove', start.x, start.y - 30);
      await send('touchMove', start.x, start.y - 70);
      // Upward movement keeps the keyboard; the reversal below the highest point dismisses it.
      await expect(input).toBeFocused();
      await send('touchMove', start.x, start.y - 55);
      await expect(input).not.toBeFocused();
      await lowerKeyboard(page);
      await send('touchMove', start.x, start.y + 10);
      await send('touchEnd', start.x, start.y);
      await expect(input).toBeVisible();
      expect(await draftOf(page)).toBe(draft);
      await expect(page.locator('.agent-session-panel:visible, .agent-composer-menu:visible')).toHaveCount(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const events = await recorded(page);
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.every(event => event.trusted && event.prevented)).toBe(true);
      observations.push({ control: await control.getAttribute('aria-label'), events: events.length });
      await input.focus();
      await raiseKeyboard(page, KEYBOARD);
      await keyboardSettled(page, input);
    }
    await info.attach('trusted-control-touch.json', { contentType: 'application/json', body: JSON.stringify(observations, null, 2) });
  } finally { await cdp.detach(); }
});

for (const empty of [false, true]) {
  test(`a native curved touch that leaves the composer and comes back is owned by it from the first move (${empty ? 'empty' : 'long'} draft)`, async ({ page }, info) => {
    const draft = empty ? '' : Array.from({ length: 35 }, (_, index) => `Draft segment ${index + 1}: preserve the complete message while dismissing the keyboard.`).join(' ');
    const input = await withKeyboard(page, draft || 'Temporary draft');
    if (empty) await input.fill('');
    const start = await input.evaluate(element => {
      const editor = element as HTMLElement;
      editor.scrollTop = 80;
      const box = editor.getBoundingClientRect();
      const events: Array<{ trusted: boolean; prevented: boolean; focused: boolean; outside: boolean }> = [];
      (window as unknown as { touches: typeof events }).touches = events;
      const composer = editor.closest('.lab-composer-input-shell')!;
      composer.addEventListener('touchmove', event => {
        const point = (event as TouchEvent).touches[0]!;
        events.push({ trusted: event.isTrusted, prevented: event.defaultPrevented, focused: document.activeElement === editor, outside: point.clientY < composer.getBoundingClientRect().top });
      });
      return { x: box.x + box.width / 2, y: box.bottom - 16, scrollTop: editor.scrollTop, clientHeight: editor.clientHeight, scrollHeight: editor.scrollHeight };
    });
    if (!empty) { expect(start.scrollHeight).toBeGreaterThan(start.clientHeight); expect(start.scrollTop).toBeGreaterThan(0); }
    const shell = page.locator('.lab-shell');
    const before = (await shell.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const send = touch(cdp);
    try {
      await send('touchStart', start.x, start.y);
      await send('touchMove', start.x, start.y - 20);
      await send('touchMove', start.x - 5, start.y - 90);
      await send('touchMove', start.x + 12, start.y - 160);
      await expect(input).toBeFocused();
      // The draft does not scroll and the page does not pan while the finger is above the composer.
      expect(await input.evaluate(element => element.scrollTop)).toBe(start.scrollTop);
      expect((await shell.boundingBox())!.y).toBeCloseTo(before.y, 1);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      // Curving back diagonally, each small step adds to the same downward movement.
      for (let step = 1; step <= 12; step++) await send('touchMove', start.x + 12 + step * 4, start.y - 160 + step * 5);
      await expect(input).not.toBeFocused();
      await lowerKeyboard(page);
      await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
      const afterDismissal = await input.evaluate(element => element.scrollTop);
      await send('touchMove', start.x, start.y + 20);
      await send('touchMove', start.x, start.y + 40);
      await send('touchEnd', start.x, start.y + 40);
      expect(await input.evaluate(element => element.scrollTop)).toBe(afterDismissal);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const events = await recorded(page) as Array<{ trusted: boolean; prevented: boolean; focused: boolean; outside: boolean }>;
      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.every(event => event.trusted && event.prevented)).toBe(true);
      expect(events.some(event => event.focused && event.outside)).toBe(true);
      expect(events.some(event => !event.focused)).toBe(true);
      expect(await draftOf(page)).toBe(draft);
      await info.attach('trusted-composer-touch.json', { contentType: 'application/json', body: JSON.stringify({ start, events }, null, 2) });
    } finally { await cdp.detach(); }
  });
}

test('a small native drag on Send cancels its hold, while a stationary hold inserts a line and a slight tremor is still a tap', async ({ page }) => {
  const draft = 'Small movement is a drag';
  const input = await withKeyboard(page, draft);
  const dock = page.locator('.lab-composer-dock');
  const sendButton = dock.getByTestId('prompt-submit');
  const start = await recordTouches(sendButton);
  const cdp = await page.context().newCDPSession(page);
  const send = touch(cdp);
  try {
    await send('touchStart', start.x, start.y);
    await send('touchMove', start.x, start.y - 6);
    // Cross the hold deadline without further movement: a drag has cancelled the hold, so no line is inserted.
    await page.waitForTimeout(650);
    expect(await draftOf(page)).toBe(draft);
    await send('touchMove', start.x, start.y - 40);
    await send('touchMove', start.x, start.y - 25);
    await expect(input).not.toBeFocused();
    await send('touchEnd', start.x, start.y - 25);
    expect(await draftOf(page)).toBe(draft);
    await expect(page.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(0);
    await input.focus();
    await raiseKeyboard(page, KEYBOARD);
    await keyboardSettled(page, input);
    const held = (await sendButton.boundingBox())!;
    const middle = { x: held.x + held.width / 2, y: held.y + held.height / 2 };
    await send('touchStart', middle.x, middle.y);
    await expect.poll(() => draftOf(page)).toBe(`${draft}\n`);
    await send('touchEnd', middle.x, middle.y);
    expect(await draftOf(page)).toBe(`${draft}\n`);
    await expect(page.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(0);
    const tapped = (await sendButton.boundingBox())!;
    const point = { x: tapped.x + tapped.width / 2, y: tapped.y + tapped.height / 2 };
    await send('touchStart', point.x, point.y);
    await send('touchMove', point.x, point.y - 2);
    await send('touchEnd', point.x, point.y - 2);
    await expect.poll(() => draftOf(page)).toBe('');
  } finally { await cdp.detach(); }
});
