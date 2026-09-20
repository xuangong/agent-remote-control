import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html');
  if ((page.viewportSize()?.width ?? 1280) <= 1180) {
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    await page.getByLabel('Header', { exact: true }).check();
    await page.getByRole('button', { name: 'View options', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Share session link' }).click();
}

async function camera(page: Page, delayed = false) {
  await page.evaluate(delayed => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 320;
    canvas.getContext('2d')!.fillRect(0, 0, 320, 320);
    const stream = canvas.captureStream(5);
    Object.assign(window, { scanStream: stream, cameraRequested: false });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
      Object.assign(window, { cameraRequested: true });
      return delayed ? new Promise(resolve => Object.assign(window, { allowCamera: () => resolve(stream) })) : Promise.resolve(stream);
    } });
  }, delayed);
  if (!await page.getByRole('button', { name: 'Scan session QR code', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Scan session QR code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { cameraRequested: boolean }).cameraRequested)).toBe(true);
}

async function ended(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { scanStream: MediaStream }).scanStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
}

test('keeps the transfer compact and releases active or late camera access when closing', async ({ page }, info) => {
  await setup(page);
  const dialog = page.getByRole('dialog', { name: 'Share session', exact: true });
  await expect(dialog.getByAltText('Session QR code')).toBeVisible();
  const body = dialog.locator('.lab-session-transfer-body');
  expect(await body.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('share-session.png') });
  await dialog.getByRole('button', { name: 'Close session link' }).click();
  if (!await page.getByRole('button', { name: 'Scan session QR code', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Scan session QR code', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('discover-scan.png') });
  await camera(page);
  const scanner = page.getByRole('dialog', { name: 'Scan session', exact: true });
  await expect(scanner.getByText('Point your camera at a session QR code.')).toBeVisible();
  await scanner.getByRole('button', { name: 'Close scanner' }).click();
  await ended(page);
  await camera(page, true);
  await scanner.getByRole('button', { name: 'Close scanner' }).click();
  await page.evaluate(() => (window as unknown as { allowCamera(): void }).allowCamera());
  await ended(page);
});

test('pauses the camera on backgrounding and explains denied permission', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Close session link' }).click();
  await camera(page);
  await expect(page.getByText('Point your camera at a session QR code.')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await ended(page);
  await expect(page.getByRole('button', { name: 'Resume camera' })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
  });
  await page.getByRole('button', { name: 'Resume camera' }).click();
  await expect(page.getByRole('alert')).toContainText('Camera access was denied');
});

test('rejects a foreign QR link without leaving the current session', async ({ page }) => {
  await setup(page);
  const original = page.url();
  await page.getByRole('button', { name: 'Close session link' }).click();
  await camera(page);
  await page.getByText('Paste a session link', { exact: true }).click();
  await page.getByLabel('Session link', { exact: true }).fill('https://other.example/?host=host&provider=codex&session=one');
  await page.getByRole('button', { name: 'Open session', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('another site');
  await ended(page);
  expect(page.url()).toBe(original);
  await expect(page.getByRole('button', { name: 'Scan again' })).toBeVisible();
});


test('opens the shared scanner from the mobile title without opening the sidebar', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'), 'The title shortcut is mobile navigation.');
  await setup(page);
  await page.getByRole('button', { name: 'Close session link' }).click();
  await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
    value: async () => { throw new DOMException('Denied', 'NotAllowedError'); } }));
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  const shortcut = page.getByRole('button', { name: 'Scan to open', exact: true });
  await expect(shortcut).toHaveCSS('white-space', 'nowrap');
  const heading = await page.locator('.lab-title-favorites h2').boundingBox();
  const action = await shortcut.boundingBox();
  expect(Math.abs(heading!.y + heading!.height / 2 - action!.y - action!.height / 2)).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath('favorites-scan.png') });
  await page.getByRole('button', { name: 'Scan to open', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Scan session', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Context', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Close scanner' }).click();
  await expect(page.getByRole('button', { name: 'Favorites', exact: true })).toBeFocused();
});
