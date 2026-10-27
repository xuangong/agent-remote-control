import { expect, test, type Locator, type Page } from '@playwright/test';
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
    // A floating control keeps its spot in the visible area, which the keyboard pans.
    const position = () => root.evaluate(element => {
      const style = getComputedStyle(element);
      return { x: parseFloat(style.left) - window.visualViewport!.offsetLeft, y: parseFloat(style.top) - window.visualViewport!.offsetTop, width: parseFloat(style.width) };
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

test('keeps floating controls the keyboard covers apart and returns them when it closes', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    localStorage.setItem('agent-remote:window-position', JSON.stringify({ x: 260, y: 600 }));
    localStorage.setItem('agent-remote:ask-position', JSON.stringify({ x: 260, y: 700 }));
  });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const input = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.fill('/ask');
  await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-submit')).toBeEnabled();
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Ask about this session', exact: true })).toBeEnabled();
  const boxes = () => page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const top = parseFloat(getComputedStyle(element).top) - window.visualViewport!.offsetTop;
      return { top, bottom: top + element.offsetHeight };
    };
    return { window: box('.lab-window-floating'), ask: box('.lab-ask-floating') };
  });
  await expect.poll(async () => (await boxes()).window.top).toBe(600);
  expect((await boxes()).ask.top).toBe(700);

  await focusWithKeyboard(page, input);
  await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'true');
  await expect.poll(async () => (await boxes()).ask.bottom).toBe(420 - 12);
  const covered = await boxes();
  // The lower control takes the bottom of the visible area; the one above keeps clear of it.
  expect(covered.window.bottom + 8).toBeLessThanOrEqual(covered.ask.top);
  expect(covered.window.top).toBeGreaterThanOrEqual(12);
  await page.screenshot({ path: testInfo.outputPath('keyboard-floating-controls.png') });

  // Standalone WebKit can expose the final keyboard bounds after its viewport events.
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 380, offsetTop: 200 });
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(async () => (await boxes()).ask.bottom).toBe(380 - 12);
  const settled = await boxes();
  expect(settled.window.bottom + 8).toBeLessThanOrEqual(settled.ask.top);

  await closeKeyboardViewport(page);
  await expect.poll(async () => (await boxes()).window.top).toBe(600);
  expect((await boxes()).ask.top).toBe(700);
});

test('a tap that opens the keyboard asks the browser not to pan the page and keeps editing', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'The shell adapts only coarse pointers to the software keyboard.');
  await page.addInitScript(() => {
    const focus = HTMLElement.prototype.focus;
    const refocused: string[] = [];
    Object.assign(window, { refocused });
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      if (options?.preventScroll && this === document.activeElement) refocused.push(this.dataset.testid ?? this.tagName);
      return focus.call(this, options);
    };
  });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const input = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.fill('Keep this draft');
  await input.blur();
  await page.evaluate(() => { (window as unknown as { refocused: string[] }).refocused.length = 0; });
  await input.tap();
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { refocused: string[] }).refocused)).toEqual(['prompt-input']);
  await page.keyboard.press('End');
  await page.keyboard.type(' and type');
  await expectDraft(input, 'Keep this draft and type');
});

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

async function focusWithKeyboard(page: Page, input: Locator) {
  await input.focus();
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 420, offsetTop: 160 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(input).toBeFocused();
  // The shell applies keyboard bounds in its next animation frame; measure controls after it.
  await expect(page.locator('.lab-shell')).toHaveCSS('top', '160px');
}

async function closeKeyboardViewport(page: Page) {
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
}

async function expectDraft(input: Locator, draft: string) {
  await expect.poll(() => input.evaluate(element => element instanceof HTMLTextAreaElement ? element.value
    : Array.from(element.childNodes, node => node.nodeName === 'BR' && !(node as Element).classList.contains('ProseMirror-trailingBreak')
      ? '\n' : node.textContent ?? '').join(''))).toBe(draft);
}

async function syntheticControlDrag(control: Locator) {
  return control.evaluate(element => {
    const editor = document.activeElement;
    const dispatch = (type: string, y: number) => {
      const touch = { identifier: 1, target: element, screenX: 120, screenY: y, clientX: 120, clientY: y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] } });
      return element.dispatchEvent(event);
    };
    dispatch('touchstart', 300);
    const up = dispatch('touchmove', 270);
    const focusedAfterUp = document.activeElement === editor;
    const down = dispatch('touchmove', 285);
    const blurred = document.activeElement !== editor;
    const closing = dispatch('touchmove', 310);
    const end = dispatch('touchend', 310);
    const click = element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    return { up, focusedAfterUp, down, blurred, closing, end, click };
  });
}

test('applies keyboard-dismiss dragging to controls while preserving their next activation', async ({ page, browserName }) => {
  const draft = 'A control drag must not submit this draft';
  const input = await openFocusedComposer(page, draft);
  const view = page.locator('.lab-primary-conversation');
  const controls = [view.getByTestId('session-model-button'), view.getByRole('button', { name: 'Hide message input', exact: true }), view.getByTestId('prompt-submit')];
  for (const [index, control] of controls.entries()) {
    await focusWithKeyboard(page, input);
    await expect(control).toBeVisible();
    expect(await syntheticControlDrag(control)).toEqual({ up: false, focusedAfterUp: true, down: false, blurred: true, closing: false, end: false, click: false });
    await closeKeyboardViewport(page);
    await expect(input).toBeVisible();
    await expectDraft(input, draft);
    await expect(view.locator('.agent-session-panel:visible')).toHaveCount(0);
    await expect(view.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(0);
    if (index === 2 && browserName === 'webkit') {
      // Linux WebKit suppresses click after Send's prevented pointerdown even
      // with the unchanged hook. Verify keyboard activation here; Chromium
      // verifies a real follow-up tap, including after a native drag below.
      await control.focus();
      await control.press('Enter');
    } else await control.tap();
    if (index === 0) {
      await expect(view.getByRole('region', { name: 'Model settings' })).toBeVisible();
      await view.getByRole('button', { name: 'Close session controls' }).tap();
    } else if (index === 1) {
      await expect(input).toBeHidden();
      await view.getByRole('button', { name: 'Show message input', exact: true }).tap();
      await expect(input).toBeVisible();
    } else {
      await expectDraft(input, '');
      await expect(view.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(1);
    }
  }
});

test('owns native drags starting on toolbar and outer collapse controls', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Trusted touch injection uses Chromium CDP. WebKit covers the control event contract.');
  const draft = 'Keep the composer open and its controls inactive during a drag';
  const input = await openFocusedComposer(page, draft);
  const view = page.locator('.lab-primary-conversation');
  const cdp = await page.context().newCDPSession(page);
  const observations = [];
  try {
    for (const control of [view.getByTestId('session-model-button'), view.getByRole('button', { name: 'Hide message input', exact: true }), view.getByTestId('prompt-submit')]) {
      await focusWithKeyboard(page, input);
      await expect(control).toBeVisible();
      const start = await control.evaluate(element => {
        const boundary = element.closest('.lab-composer-input-shell')!;
        const events: Array<{ trusted: boolean; prevented: boolean }> = [];
        (element as HTMLElement & { gestureEvents: typeof events }).gestureEvents = events;
        boundary.addEventListener('touchmove', event => events.push({ trusted: event.isTrusted, prevented: event.defaultPrevented }));
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y = start.y) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x: start.x, y, radiusX: 1, radiusY: 1, force: 1 }],
      });
      await touch('touchStart');
      await touch('touchMove', start.y - 30);
      await touch('touchMove', start.y - 70);
      await expect(input).toBeFocused();
      await touch('touchMove', start.y - 55);
      await expect(input).not.toBeFocused();
      await closeKeyboardViewport(page);
      await touch('touchMove', start.y + 10);
      await touch('touchEnd');
      await expect(input).toBeVisible();
      await expectDraft(input, draft);
      await expect(view.locator('.agent-session-panel:visible')).toHaveCount(0);
      await expect(view.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const events = await control.evaluate(element => (element as HTMLElement & { gestureEvents: Array<{ trusted: boolean; prevented: boolean }> }).gestureEvents);
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.every(event => event.trusted && event.prevented)).toBe(true);
      observations.push({ control: await control.getAttribute('aria-label'), start, events });
    }
    await testInfo.attach('trusted-control-touch.json', { contentType: 'application/json', body: JSON.stringify(observations, null, 2) });
  } finally { await cdp.detach(); }
});

test('cancels the Send hold after a small native drag but preserves a stationary hold and tap', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Trusted pointer and touch ordering requires Chromium CDP.');
  const draft = 'Small movement is a drag';
  const input = await openFocusedComposer(page, draft);
  const view = page.locator('.lab-primary-conversation');
  const send = view.getByTestId('prompt-submit');
  const start = await send.evaluate(element => {
    const events: Array<{ type: string; trusted: boolean; prevented: boolean; x?: number; y?: number }> = [];
    (element as HTMLElement & { gestureEvents: typeof events }).gestureEvents = events;
    const boundary = element.closest('.lab-composer-input-shell')!;
    for (const type of ['pointerdown', 'pointermove', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'click']) {
      boundary.addEventListener(type, event => {
        const point = 'touches' in event ? (event as TouchEvent).touches[0] : event as PointerEvent;
        events.push({ type: event.type, trusted: event.isTrusted, prevented: event.defaultPrevented, x: point?.clientX, y: point?.clientY });
      });
    }
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y = start.y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x: start.x, y, radiusX: 1, radiusY: 1, force: 1 }],
  });
  try {
    await touch('touchStart');
    await touch('touchMove', start.y - 6);
    // Deliberately cross the hold deadline without further movement.
    await page.waitForTimeout(650);
    const events = await send.evaluate(element => (element as HTMLElement & { gestureEvents: unknown[] }).gestureEvents);
    await testInfo.attach('small-send-drag.json', { contentType: 'application/json', body: JSON.stringify({ start, events, html: await input.evaluate(element => element.outerHTML) }, null, 2) });
    await expectDraft(input, draft);
    await touch('touchMove', start.y - 40);
    await touch('touchMove', start.y - 25);
    await expect(input).not.toBeFocused();
    await touch('touchEnd');
    await expectDraft(input, draft);
    await expect(view.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(0);
    await focusWithKeyboard(page, input);
    const held = (await send.boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: held.x + held.width / 2, y: held.y + held.height / 2 }] });
    await expectDraft(input, `${draft}\n`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expectDraft(input, `${draft}\n`);
    await expect(view.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(0);
    // A slight tremor is still a tap, rather than a deliberate drag.
    const tapped = (await send.boundingBox())!;
    const point = { id: 1, x: tapped.x + tapped.width / 2, y: tapped.y + tapped.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expectDraft(input, '');
    await expect(view.locator('.agent-message-user').filter({ hasText: draft })).toHaveCount(1);
  } finally { await cdp.detach(); }
});

test('drags an image atom without opening its preview and still previews on a tap', async ({ page, browserName }) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 420, offsetTop: 160, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await page.goto('/e2e/fixtures/image-input.html');
  const input = page.getByTestId('prompt-input');
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'Add images' }).click();
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'pixel.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64'),
  });
  const atom = input.locator('[data-image-id]');
  await expect(atom).toBeVisible();
  await input.focus();
  if (browserName === 'chromium') {
    const box = (await atom.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y = box.y + box.height / 2) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x: box.x + box.width / 2, y }],
    });
    try {
      await touch('touchStart');
      await touch('touchMove', box.y - 40);
      await expect(input).toBeFocused();
      await touch('touchMove', box.y - 25);
      await expect(input).not.toBeFocused();
      await touch('touchEnd');
    } finally { await cdp.detach(); }
  } else {
    expect(await syntheticControlDrag(atom)).toEqual({ up: false, focusedAfterUp: true, down: false, blurred: true, closing: false, end: false, click: false });
  }
  await expect(page.getByRole('dialog', { name: 'Image preview' })).toHaveCount(0);
  await expect(input).toHaveText('[image #1]');
  await expect(page.getByTestId('sent-content')).toHaveText('[]');
  await atom.tap();
  await expect(page.getByRole('dialog', { name: 'Image preview' })).toBeVisible();
});

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
    const composer = editor.closest('.lab-composer-input-shell')!;
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
