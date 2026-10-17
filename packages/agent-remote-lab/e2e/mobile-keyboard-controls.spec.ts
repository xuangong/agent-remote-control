import { expect, test } from '@playwright/test';
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

test('pulls down a focused composer to dismiss the keyboard while preserving its draft', async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const input = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  const draft = 'Keep this draft while dismissing the keyboard';
  await input.fill(draft);
  await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-submit')).toBeEnabled();
  await input.focus();
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 420, offsetTop: 160 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.lab-shell')).toHaveAttribute('data-viewport-occluded', 'true');
  await expect(input).toBeFocused();
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
