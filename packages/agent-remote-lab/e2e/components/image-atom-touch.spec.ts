// Component projects: webkit-mobile-viewport
import { expect, test, type Locator } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('drags an image atom without opening its preview and still previews on a tap', async ({ page, browserName, hasTouch }) => {
  test.skip(!hasTouch, 'The preview tap needs a touch screen; chromium-mobile and webkit-mobile-viewport run this.');
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 420, offsetTop: 160, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await page.goto('/e2e/fixtures/image-input.html');
  const input = page.getByTestId('prompt-input');
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
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
