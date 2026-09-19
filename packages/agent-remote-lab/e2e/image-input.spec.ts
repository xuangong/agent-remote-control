import { expect, test, type Page } from '@playwright/test';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');
async function upload(page: Page) {
  await page.getByRole('button', { name: 'Add images' }).click();
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
}
test.beforeEach(async ({ page }) => { await page.goto('/e2e/fixtures/image-input.html'); await expect(page.getByTestId('prompt-input')).toBeVisible(); });

test('preserves inline order, atomic deletion and undo, then sends image content', async ({ page }, info) => {
  const editor = page.getByTestId('prompt-input');
  await editor.fill('Before '); await editor.press('End');
  await upload(page);
  await expect(editor.locator('[data-image-id]')).toHaveAttribute('data-state', 'ready');
  await editor.press('End'); await editor.pressSequentially(' after');
  await expect(editor).toHaveText('Before [image #1] after');
  await editor.locator('[data-image-id]').click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(editor.locator('[data-image-id]')).toHaveCount(0);
  await editor.press('ControlOrMeta+z');
  await expect(editor.locator('[data-image-id]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('image-inline.png') });
  await page.getByTestId('prompt-submit').click();
  const parts = JSON.parse(await page.getByTestId('sent-content').innerText());
  expect(parts.map((part: { type: string }) => part.type)).toEqual(['text', 'image', 'text']);
  expect(parts[0].text).toBe('Before '); expect(parts[2].text).toBe(' after');
});

test('keeps tags through reconnect, session switch and a full page reload', async ({ page }) => {
  const editor = page.getByTestId('prompt-input');
  await upload(page); await expect(editor.locator('[data-image-id]')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Toggle connection' }).click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.press('End'); await editor.pressSequentially('draft offline');
  await expect(page.getByTestId('prompt-submit')).toBeDisabled();
  await page.getByRole('button', { name: 'Switch session' }).click();
  await expect(editor.locator('[data-image-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch session' }).click();
  await expect(editor).toContainText('draft offline');
  await page.reload();
  await expect(editor).toContainText('draft offline');
  await expect(editor.locator('[data-image-id]')).toHaveAttribute('data-state', 'ready');
});

test('pastes an image atom and leaves a failed upload visible until explicit retry', async ({ page }) => {
  await page.getByRole('button', { name: 'Toggle upload failure' }).click();
  const editor = page.getByTestId('prompt-input');
  await editor.evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  await expect(editor.locator('[data-image-id]')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('prompt-submit')).toBeDisabled();
  await page.getByRole('button', { name: 'Toggle upload failure' }).click();
  await editor.locator('[data-image-id]').click();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(editor.locator('[data-image-id]')).toHaveAttribute('data-state', 'ready');
  await page.getByTestId('prompt-submit').click();
  expect(JSON.parse(await page.getByTestId('sent-content').innerText()).map((part: { type: string }) => part.type)).toEqual(['image']);
});
