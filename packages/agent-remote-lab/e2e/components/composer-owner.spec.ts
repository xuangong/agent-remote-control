import { expect, test } from '@playwright/test';

// The editor belongs to its draft owner, not to the session behind it: when a native confirmation moves the conversation from A to B,
// the person's cursor, selection and focus stay where they were.
test('keeps the editor, its focus and its selection when the session behind the draft owner moves from A to B', async ({ page }) => {
  await page.goto('/e2e/fixtures/composer-owner.html');
  const editor = page.getByTestId('prompt-input');
  await expect(editor).toHaveText('Keep this focused selection');
  const original = await editor.elementHandle();
  await editor.focus();
  await editor.evaluate(node => {
    const text = node.firstChild!, range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 9);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  const selection = () => page.evaluate(() => ({ text: String(window.getSelection()), anchor: window.getSelection()?.anchorOffset, focus: window.getSelection()?.focusOffset }));
  expect(await selection()).toEqual({ text: 'ep this', anchor: 2, focus: 9 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:move-session', { detail: 'B' })));
  await expect(page.locator('html')).toHaveAttribute('data-session', 'B');
  expect(await editor.evaluate((node, prior) => node === prior, original)).toBe(true);
  await expect(editor).toBeFocused();
  expect(await selection()).toEqual({ text: 'ep this', anchor: 2, focus: 9 });
  await expect(editor).toHaveText('Keep this focused selection');
});
