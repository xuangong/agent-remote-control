// Component projects: orchard-phone-webkit, orchard-phone-chromium
import { expect, test, type Page } from '@playwright/test';

const steps = ['n', 'ni', '你', '你好'];

/** Records the writes the page makes to a field's value: a composition ends when the page writes the field while it composes. */
async function watchWrites(page: Page, selector: string) {
  await page.locator(selector).evaluate((node: HTMLInputElement & { writes?: string[]; marker?: string }) => {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    node.writes = []; node.marker = 'original';
    Object.defineProperty(node, 'value', { configurable: true, get() { return native.get!.call(this); }, set(value: string) { node.writes!.push(value); native.set!.call(this, value); } });
  });
  return () => page.locator(selector).evaluate((node: HTMLInputElement & { writes?: string[]; marker?: string }) =>
    ({ writes: node.writes!, sameNode: node.marker === 'original', focused: document.activeElement === node, value: node.value }));
}

/** What the field holds after each step of a composition, read at once. */
async function compose(page: Page, browserName: string, selector: string): Promise<string[]> {
  if (browserName === 'chromium') {
    const session = await page.context().newCDPSession(page);
    const seen: string[] = [];
    for (const text of steps) {
      await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
      seen.push(await page.locator(selector).inputValue());
    }
    await session.send('Input.insertText', { text: steps.at(-1)! });
    return seen;
  }
  // WebKit has no input method driver: replay what Safari sends, a composition whose text is replaced as it grows.
  return page.locator(selector).evaluate((node: HTMLInputElement, steps: string[]) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const seen: string[] = [];
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const step of steps) {
      setter.call(node, step);
      node.dispatchEvent(new InputEvent('input', { data: step, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
      node.dispatchEvent(new CompositionEvent('compositionupdate', { data: step, bubbles: true }));
      seen.push(node.value);
    }
    node.dispatchEvent(new CompositionEvent('compositionend', { data: steps.at(-1)!, bubbles: true }));
    return seen;
  }, steps);
}

for (const [label, selector] of [['question', 'input[name="directory-custom"]'], ['form', 'input[name="note"]']] as const) {
  test(`${label} text field composes Chinese without the page writing its value, and keeps its node and focus`, async ({ page, browserName }) => {
    test.setTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/e2e/fixtures/question-input.html');
    const field = page.locator(selector);
    await field.tap();
    const state = await watchWrites(page, selector);
    expect(await compose(page, browserName, selector)).toEqual(steps);
    // Let the owner hand the draft back, then read what the page did to the field.
    await page.waitForTimeout(50);
    expect(await state()).toEqual({ writes: [], sameNode: true, focused: true, value: '你好' });
    if (label === 'question') {
      await page.getByRole('button', { name: 'Submit response', exact: true }).click();
      expect(JSON.stringify(await page.evaluate(() => (window as unknown as { answers: unknown[] }).answers))).toContain('你好');
    }
    expect(errors).toEqual([]);
  });
}
