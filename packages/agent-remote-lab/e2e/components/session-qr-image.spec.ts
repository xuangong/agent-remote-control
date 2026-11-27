// Component projects: webkit-desktop
import QRCode from 'qrcode';
import { expect, test, type Page } from '@playwright/test';
import { openSessionsPage } from '../all-sessions.js';

/** A screenshot of a terminal's QR code: black modules on white, with the quiet zone, as `session link --qr` draws it. */
const screenshot = (text: string) => QRCode.toBuffer(text, { type: 'png', margin: 4, width: 420, errorCorrectionLevel: 'M' });

async function openScanner(page: Page) {
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?switching&control');
  await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError'); } }));
  const scan = page.getByRole('button', { name: 'Scan session QR code', exact: true });
  if (!await scan.isVisible()) {
    if ((page.viewportSize()?.width ?? 1280) > 1180) await openSessionsPage(page);
    else await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  }
  await scan.click();
  const dialog = page.getByRole('dialog', { name: 'Scan session', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Pastes an image as the browser does: a paste event carrying the file. */
async function pasteImage(page: Page, bytes: Buffer, type = 'image/png') {
  await page.evaluate(({ data, type }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'qr', { type }));
    document.querySelector('dialog[open] button')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { data: bytes.toString('base64'), type });
}

test('reads the session link from a pasted screenshot of its QR code and opens the session', async ({ page }) => {
  const dialog = await openScanner(page);
  const link = `${new URL(page.url()).origin}/?host=host&provider=recorded&session=recorded-session`;
  await pasteImage(page, await screenshot(link));
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert').filter({ hasText: 'QR' })).toHaveCount(0);
});

test('reads the session link from a dropped screenshot', async ({ page }) => {
  const dialog = await openScanner(page);
  const link = `${new URL(page.url()).origin}/?host=host&provider=recorded&session=recorded-session&as=bot`;
  const data = (await screenshot(link)).toString('base64');
  await page.evaluate(data => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'qr.png', { type: 'image/png' }));
    for (const type of ['dragover', 'drop']) document.querySelector('dialog[open]')!.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, data);
  // A link that asks for a bot is confirmed first: the scanner closes and the question opens.
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Make a session a bot' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make bot' })).toBeVisible();
});

test('says there is no QR code in an image without one', async ({ page }) => {
  const dialog = await openScanner(page);
  const blank = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 300; const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, 300, 300); return canvas.toDataURL('image/png').split(',')[1]!; });
  await pasteImage(page, Buffer.from(blank, 'base64'));
  await expect(dialog.getByRole('alert')).toContainText('No QR code was found in this image');
  await expect(dialog).toBeVisible();
});

test('says a QR code that is not a session link of this site opens nothing', async ({ page }) => {
  const dialog = await openScanner(page);
  await pasteImage(page, await screenshot('https://other.example/?host=host&provider=codex&session=one'));
  await expect(dialog.getByRole('alert')).toContainText('another site');
  await expect(dialog).toBeVisible();
});

test('a link that asks for a bot is confirmed before anything opens, and leaves the address', async ({ page }) => {
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?switching&control&host=host&provider=recorded&session=linked-session&as=bot&name=Reuse%20test');
  const dialog = page.getByRole('dialog', { name: 'Make a session a bot' });
  await expect(dialog.getByRole('heading', { name: 'Make Reuse test a bot?' })).toBeVisible();
  await expect(dialog.getByLabel('Bot name')).toHaveValue('Reuse test');
  // The address no longer names the session, so a reload or the app's own navigation cannot open it before the answer.
  const address = new URL(page.url());
  for (const key of ['as', 'name']) expect(address.searchParams.has(key)).toBe(false);
  expect(address.searchParams.get('session')).not.toBe('linked-session');
  expect(await page.getByText('Conversation for linked-session').count()).toBe(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.getByText('Conversation for linked-session').count()).toBe(0);
});
