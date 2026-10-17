import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

for (const visualClientRects of [false, true]) {
  test(`keeps floating controls under the pointer across keyboard changes (visual rects=${visualClientRects})`, async ({ page }) => {
    await page.addInitScript(visual => {
      const viewport = Object.assign(new EventTarget(), { width: 390, height: 420, offsetTop: 160, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      // Reproduce WebKit's client-rect origin without a native software keyboard.
      if (visual) {
        const measure = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          const rect = measure.call(this);
          return this.matches('.lab-tracking-floating')
            ? new DOMRect(rect.x - viewport.offsetLeft, rect.y - viewport.offsetTop, rect.width, rect.height)
            : rect;
        };
      }
    }, visualClientRects);
    await page.goto('/');
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    const input = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('/ask');
    await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-submit')).toBeEnabled();
    await input.press('Enter');
    const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
    await expect(trigger).toBeEnabled();
    const root = page.locator('.lab-ask-floating');
    const position = () => root.evaluate(element => {
      const style = getComputedStyle(element);
      return { x: parseFloat(style.left), y: parseFloat(style.top), width: parseFloat(style.width) };
    });
    const initial = await position();
    // The default is right-aligned, with no saved left coordinate.
    expect(initial.x + initial.width).toBeCloseTo(378, 1);
    expect(initial.y).toBe(276);
    const bounds = (await trigger.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 - 75, bounds.y + bounds.height / 2 + 35, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await position()).x).toBeCloseTo(initial.x - 75, 2);
    await expect.poll(async () => (await position()).y).toBeCloseTo(initial.y + 35, 2);
    await expect(page.getByRole('dialog', { name: 'Ask', exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'false');
    const settled = await position();
    expect(settled.x).toBeCloseTo(initial.x - 75, 2);
    expect(settled.y).toBeCloseTo(initial.y + 35, 2);
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'Ask', exact: true })).toBeVisible();
  });
}

async function openFocusedComposer(page: Page, draft: string) {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const input = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.fill(draft);
  await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-submit')).toBeEnabled();
  await input.focus();
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 420, offsetTop: 160 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'true');
  await expect(input).toBeFocused();
  return input;
}

test('pulls down a focused composer to dismiss the keyboard while preserving its draft', async ({ page }) => {
  const draft = 'Keep this draft while dismissing the keyboard';
  const input = await openFocusedComposer(page, draft);
  const result = await input.evaluate(element => {
    const dispatch = (type: string, screenY: number, clientY: number) => {
      const touch = { identifier: 1, target: element, screenX: 120, screenY, clientX: 120, clientY };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] } });
      return element.dispatchEvent(event);
    };
    dispatch('touchstart', 300, 300);
    const first = dispatch('touchmove', 324, 324);
    const blurred = document.activeElement !== element;
    Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
    const closing = dispatch('touchmove', 340, 180);
    dispatch('touchend', 340, 180);
    return { first, closing, blurred };
  });
  expect(result).toEqual({ first: false, closing: false, blurred: true });
  await expect(input).not.toBeFocused();
  expect(await input.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent)).toBe(draft);
  await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'false');
  await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBeCloseTo(844, 1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

for (const releaseBetweenDirections of [false, true]) {
  test(`keeps the focused composer fixed before downward dismissal (separate touches=${releaseBetweenDirections})`, async ({ page }) => {
    const draft = 'Keep the draft through an upward and downward drag';
    const input = await openFocusedComposer(page, draft);
    const result = await input.evaluate((element, release) => {
      const dispatch = (type: string, screenY: number, clientY = screenY) => {
        const touch = { identifier: 1, target: element, screenX: 120, screenY, clientX: 120, clientY };
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] } });
        return element.dispatchEvent(event);
      };
      const shell = document.querySelector('.lab-shell')!;
      const initialTop = shell.getBoundingClientRect().top;
      dispatch('touchstart', 300);
      const firstUp = dispatch('touchmove', 280);
      const secondUp = dispatch('touchmove', 260);
      const focusedAfterUp = document.activeElement === element;
      const topAfterUp = shell.getBoundingClientRect().top;
      if (release) { dispatch('touchend', 260); dispatch('touchstart', 260); }
      // Reverse below the original touch position rather than crossing it again.
      const downward = dispatch('touchmove', 278);
      const blurred = document.activeElement !== element;
      Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      const closing = dispatch('touchmove', 290, 130);
      dispatch('touchend', 290, 130);
      return { firstUp, secondUp, focusedAfterUp, initialTop, topAfterUp, downward, blurred, closing, scrollY: window.scrollY };
    }, releaseBetweenDirections);
    expect(result.firstUp).toBe(false);
    expect(result.secondUp).toBe(false);
    expect(result.focusedAfterUp).toBe(true);
    expect(result.topAfterUp).toBe(result.initialTop);
    expect(result.downward).toBe(false);
    expect(result.blurred).toBe(true);
    expect(result.closing).toBe(false);
    expect(result.scrollY).toBe(0);
    await expect(input).not.toBeFocused();
    expect(await input.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent)).toBe(draft);
    await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'false');
    await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBeCloseTo(844, 1);
  });
}

for (const empty of [false, true]) {
test(`owns a native curved touch outside the composer and back (empty=${empty})`, async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Trusted touch injection uses Chromium CDP. WebKit covers the event and viewport contract above.');
  const draft = empty ? '' : Array.from({ length: 35 }, (_, index) => `Draft segment ${index + 1}: preserve the complete message while dismissing the keyboard.`).join(' ');
  const input = await openFocusedComposer(page, draft || 'Temporary draft to wait for session readiness');
  if (empty) await input.fill('');
  expect(await input.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent)).toBe(draft);
  const start = await input.evaluate(element => {
    const editor = element as HTMLElement;
    editor.scrollTop = 80;
    const box = editor.getBoundingClientRect();
    const events: Array<{ trusted: boolean; prevented: boolean; focused: boolean; x: number; y: number; outside: boolean }> = [];
    (editor as HTMLElement & { gestureEvents: typeof events }).gestureEvents = events;
    const composer = editor.closest('.agent-composer')!;
    composer.addEventListener('touchmove', event => {
      const point = (event as TouchEvent).touches[0]!;
      const bounds = composer.getBoundingClientRect();
      events.push({ trusted: event.isTrusted, prevented: event.defaultPrevented, focused: document.activeElement === editor,
        x: point.clientX, y: point.clientY, outside: point.clientY < bounds.top });
    });
    return { x: box.x + box.width / 2, y: box.bottom - 16, scrollTop: editor.scrollTop, clientHeight: editor.clientHeight, scrollHeight: editor.scrollHeight };
  });
  if (!empty) {
    expect(start.scrollHeight).toBeGreaterThan(start.clientHeight);
    expect(start.scrollTop).toBeGreaterThan(0);
  }
  const shell = page.locator('.lab-shell');
  const beforeUp = (await shell.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y = start.y, x = start.x) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x, y, radiusX: 1, radiusY: 1, force: 1 }],
  });
  try {
    await touch('touchStart');
    await touch('touchMove', start.y - 20);
    await touch('touchMove', start.y - 90, start.x - 5);
    await touch('touchMove', start.y - 160, start.x + 12);
    await expect(input).toBeFocused();
    expect(await input.evaluate(element => element.scrollTop)).toBe(start.scrollTop);
    const afterUp = (await shell.boundingBox())!;
    expect(afterUp.y).toBeCloseTo(beforeUp.y, 1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Curve back diagonally without releasing or reaching the original position.
    // Each small segment must contribute to the same downward movement.
    for (let step = 1; step <= 12; step++) {
      await touch('touchMove', start.y - 160 + step * 5, start.x + 12 + step * 4);
    }
    await expect(input).not.toBeFocused();
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(shell).toHaveAttribute('data-viewport-occluded', 'false');
    const afterDismissal = await input.evaluate(element => element.scrollTop);
    await touch('touchMove', start.y + 20);
    await touch('touchMove', start.y + 40);
    await touch('touchEnd');
    expect(await input.evaluate(element => element.scrollTop)).toBe(afterDismissal);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const events = await input.evaluate(element => (element as HTMLElement & { gestureEvents: Array<{ trusted: boolean; prevented: boolean; focused: boolean; outside: boolean }> }).gestureEvents);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every(event => event.trusted && event.prevented)).toBe(true);
    expect(events.some(event => event.focused)).toBe(true);
    expect(events.some(event => event.focused && event.outside)).toBe(true);
    expect(events.some(event => !event.focused)).toBe(true);
    expect(await input.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent)).toBe(draft);
    await expect.poll(async () => (await shell.boundingBox())!.height).toBeCloseTo(844, 1);
    await testInfo.attach('trusted-composer-touch.json', { contentType: 'application/json', body: JSON.stringify({ start, beforeUp, afterUp, afterDismissal, events }, null, 2) });
  } finally { await cdp.detach(); }
});
}
