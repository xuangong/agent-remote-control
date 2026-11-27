// Component projects: orchard-phone-webkit, orchard-phone-chromium, webkit-desktop
import { expect, test, type Page } from '@playwright/test';

const steps = ['n', 'ni', '你', '你好'];
const field = (rich: boolean) => rich ? '.ProseMirror' : 'textarea';

/** Counts the compositions the page ends on its own: only the test ends one, after the last step. */
async function watchComposition(page: Page, selector: string) {
  await page.locator(selector).evaluate((node: HTMLElement & { ends?: number; writes?: string[] }) => {
    node.ends = 0; node.writes = [];
    node.addEventListener('compositionend', () => { node.ends!++; });
    if (node instanceof HTMLTextAreaElement) {
      const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
      Object.defineProperty(node, 'value', { configurable: true, get() { return native.get!.call(this); }, set(value: string) { node.writes!.push(value); native.set!.call(this, value); } });
    }
  });
  return () => page.locator(selector).evaluate((node: HTMLElement & { ends?: number; writes?: string[] }) =>
    ({ ends: node.ends, writes: node.writes, focused: document.activeElement === node || node.contains(document.activeElement) }));
}

const textOf = (page: Page, selector: string) => page.locator(selector).evaluate((node: HTMLElement) => node instanceof HTMLTextAreaElement ? node.value : node.textContent ?? '');

for (const rich of [false, true]) {
  test(`${rich ? 'rich editor' : 'plain composer'} composes Chinese while its owner hands the draft back late`, async ({ page, browserName, hasTouch }) => {
    test.skip(rich && browserName !== 'chromium', 'WebKit has no input method driver, and a replayed composition cannot drive the editor');
    test.setTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/e2e/fixtures/composer-lagging.html${rich ? '?rich' : ''}`);
    const selector = field(rich);
    if (hasTouch) await page.locator(selector).tap(); else await page.locator(selector).click();
    const state = await watchComposition(page, selector);
    const seen: string[] = [];
    if (browserName === 'chromium') {
      const session = await page.context().newCDPSession(page);
      for (const text of steps) {
        await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        // Shorter than the owner's delay, so the next step arrives before the owner has handed back the last one.
        await page.waitForTimeout(12);
        seen.push(await textOf(page, selector));
      }
      await page.waitForTimeout(80);
      seen.push(await textOf(page, selector));
      await session.send('Input.insertText', { text: steps.at(-1)! });
    } else {
      // Safari's composition: the text is replaced as it grows, each step an input event of the composition.
      seen.push(...await page.locator(selector).evaluate(async (node: HTMLTextAreaElement, steps: string[]) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        const seen: string[] = [];
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        for (const step of steps) {
          setter.call(node, step);
          node.dispatchEvent(new InputEvent('input', { data: step, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
          node.dispatchEvent(new CompositionEvent('compositionupdate', { data: step, bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 12));
          seen.push(node.value);
        }
        await new Promise(resolve => setTimeout(resolve, 80));
        seen.push(node.value);
        node.dispatchEvent(new CompositionEvent('compositionend', { data: steps.at(-1)!, bubbles: true }));
        return seen;
      }, steps));
    }
    expect(seen).toEqual([...steps, '你好']);
    const after = await state();
    expect(after.writes ?? []).toEqual([]);
    expect(after.focused).toBe(true);
    expect(after.ends).toBeLessThanOrEqual(1);
    await page.waitForTimeout(80);
    expect(await textOf(page, selector)).toBe('你好');
    expect(errors).toEqual([]);
  });
}
