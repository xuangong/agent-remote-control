import { expect, test } from '@playwright/test';

test('holds Send to insert a newline at the selection and releases without sending', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByTestId('session-create').click();
  const input = page.getByTestId('prompt-input');
  const send = page.getByTestId('prompt-submit');
  // Line breaks are significant here, so compare rendered text instead of whitespace-normalized text.
  const expectDraft = (draft: string) => expect.poll(() => input.evaluate((element: HTMLElement) => element.innerText)).toBe(draft);
  await expect(input).toBeEnabled();
  await input.fill('First replace second');
  // Select " replace" (offsets 5..13) inside the editor's first text node.
  await input.evaluate((element: HTMLElement) => {
    element.focus();
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 13);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const mobile = testInfo.project.name.includes('mobile');
  const touch = mobile ? await page.context().newCDPSession(page) : undefined;
  const point = async () => { const box = (await send.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const start = await point();
  if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
  await expectDraft('First\n second');
  // Holding longer must not insert repeated newlines.
  await page.waitForTimeout(550);
  await expectDraft('First\n second');
  if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.mouse.up();
  await expect(input).toBeFocused();
  await input.press('X');
  await expectDraft('First\nX second');
  await expect(page.locator('.agent-message-user').filter({ hasText: 'First' })).toHaveCount(0);

  // A canceled or dragged gesture must neither send nor mutate the draft.
  const next = await point();
  if (touch) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [next] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  } else {
    await page.mouse.move(next.x, next.y); await page.mouse.down();
    await page.mouse.move(next.x - 60, next.y - 60); await page.mouse.up();
  }
  await page.waitForTimeout(550);
  await expectDraft('First\nX second');
  await expect(page.locator('.agent-message-user').filter({ hasText: 'First' })).toHaveCount(0);
  if (touch) { await touch.detach(); await send.tap(); }
  else await send.click();
  await expect(input).toHaveText('');
  await expect(page.locator('.agent-message-user').filter({ hasText: 'First' })).toHaveCount(1);
  await expect(page.locator('.agent-message-user').filter({ hasText: 'First' })).toContainText('First\nX second');
});
