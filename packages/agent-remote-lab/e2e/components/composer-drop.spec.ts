// Component projects: webkit-desktop
import { expect, test, type Page } from '@playwright/test';

// Files dropped on the composer (I5d) join the draft as the "+" menu adds them, by its availability; what the conversation cannot take
// is said once, above the input. The fixture's session takes images and no other files.
test.skip(({ isMobile }) => isMobile, 'Dragging files in from the desktop is the desktop\'s.');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=';

/** Drags files over the composer and, unless `leave`, drops them there; the events a browser sends for a drag from the desktop. */
async function drag(page: Page, files: readonly { name: string; type: string; base64: string }[], end: 'drop' | 'leave' | 'none' = 'drop') {
  await page.locator('.agent-composer-capsule').evaluate((capsule, { files, end }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))], file.name, { type: file.type }));
    const send = (type: string, target: Element) => target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    send('dragenter', capsule); send('dragover', capsule);
    if (end === 'drop') send('drop', capsule);
    if (end === 'leave') send('dragleave', capsule);
  }, { files, end });
}

test.beforeEach(async ({ page }) => { await page.goto('/e2e/fixtures/image-input.html'); await expect(page.getByTestId('prompt-input')).toBeVisible(); });

test('a dropped image joins the draft after its text and is sent with it; a file the session does not take is said once', async ({ page }) => {
  const editor = page.getByTestId('prompt-input');
  await editor.fill('Look at this ');
  await drag(page, [{ name: 'pixel.png', type: 'image/png', base64: png }]);
  await expect(editor.locator('[data-image-id]')).toHaveAttribute('data-state', 'ready');
  await expect(editor).toHaveText('Look at this [image #1]');
  await drag(page, [{ name: 'spec.pdf', type: 'application/pdf', base64: 'JVBERi0xLjQK' }]);
  await expect(page.getByText('Only PNG, JPEG and WebP images can be added here.')).toBeVisible();
  await expect(editor.locator('[data-image-id]')).toHaveCount(1);
  await page.getByTestId('prompt-submit').click();
  const parts = JSON.parse(await page.getByTestId('sent-content').innerText());
  expect(parts.map((part: { type: string }) => part.type)).toEqual(['text', 'image']);
});

test('the composer shows where dragged files will land, and lets go when they leave', async ({ page }) => {
  const composer = page.locator('.agent-composer');
  await drag(page, [{ name: 'pixel.png', type: 'image/png', base64: png }], 'none');
  await expect(composer).toHaveAttribute('data-drop-target');
  await drag(page, [{ name: 'pixel.png', type: 'image/png', base64: png }], 'leave');
  await expect(composer).not.toHaveAttribute('data-drop-target');
  // Text dragged from elsewhere is the editor's own, as before.
  await page.locator('.agent-composer-capsule').evaluate(capsule => {
    const transfer = new DataTransfer(); transfer.setData('text/plain', 'dragged words');
    capsule.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await expect(composer).not.toHaveAttribute('data-drop-target');
});
