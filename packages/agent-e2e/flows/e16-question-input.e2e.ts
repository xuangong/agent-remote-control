// E16, typing into a question: the real page, Relay and Controller, with a scripted session that asks a question with a free-text answer.
// The person composes Chinese with an input method in the answer field; the field keeps its node and focus, shows the composed text, and the
// answer that reaches the session carries it.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ turns: text => text.includes('Ask me') ? [{ question: 'Which folder?', options: ['Project'] }, { reply: 'Folder noted.' }] : undefined,
    sessions: { asker: { title: 'Asker', history: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hello, how can I help?' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const steps = ['n', 'ni', '你', '你好'];

/** Counts the writes the page makes to the field's value: a composition ends when the page writes the field while it composes. */
async function watchWrites(page: Page, selector: string): Promise<() => Promise<string[]>> {
  await page.locator(selector).evaluate((node: HTMLInputElement & { writes?: string[] }) => {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    node.writes = [];
    Object.defineProperty(node, 'value', { configurable: true, get() { return native.get!.call(this); }, set(value: string) { node.writes!.push(value); native.set!.call(this, value); } });
  });
  return () => page.locator(selector).evaluate((node: HTMLInputElement & { writes?: string[] }) => node.writes!);
}

/** What the field holds after each step of a composition, read at once: a page that writes the field's value while it composes shows an older text. */
async function composeChinese(page: Page, selector: string): Promise<string[]> {
  if (process.env.E2E_BROWSER === 'webkit') {
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
  const session = await page.context().newCDPSession(page);
  const seen: string[] = [];
  for (const text of steps) {
    await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    seen.push(await page.locator(selector).inputValue());
  }
  await session.send('Input.insertText', { text: steps.at(-1)! });
  return seen;
}

it('E16: composed Chinese goes into the answer field of a question and reaches the session', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('asker'), { mobile: true, viewport: { width: 390, height: 844 } });
  await page.locator('[data-testid="prompt-input"]').click();
  await page.keyboard.type('Ask me');
  await page.locator('[data-testid="prompt-submit"]').click();
  const field = page.locator('input[name="choice-custom"]');
  await field.waitFor({ timeout: 20_000 });
  await field.tap();
  await field.evaluate((node: HTMLInputElement & { marker?: string }) => { node.marker = 'original'; });
  const writes = await watchWrites(page, 'input[name="choice-custom"]');
  expect(await composeChinese(page, 'input[name="choice-custom"]')).toEqual(steps);
  expect(await writes()).toEqual([]);
  const state = await page.evaluate(() => {
    const node = document.querySelector<HTMLInputElement & { marker?: string }>('input[name="choice-custom"]');
    return { sameNode: node?.marker === 'original', focused: document.activeElement === node, value: node?.value };
  });
  expect(state).toEqual({ sameNode: true, focused: true, value: '你好' });
  await page.getByRole('button', { name: /submit|answer|send/i }).filter({ hasNot: page.locator('[data-testid="prompt-submit"]') }).first().click();
  await showsText(page, 'Folder noted.');
  await context.close();
});
