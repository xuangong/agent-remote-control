import { expect, test, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';

async function signIn(page: Page, subject = 'alice') {
  await page.getByRole('link', { name: 'Sign in through gateway' }).click();
  await page.getByRole('link', { name: `Sign in as ${subject}` }).click();
}

test('QR and copied URLs open the same session across authenticated devices without browser storage', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Uses separate desktop and mobile contexts.');
  const f = await sessionLinkFixture();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await browser.newContext();
  const outsider = await browser.newContext();
  try {
    await page.goto(f.url);
    await signIn(page);
    await page.getByLabel('Connected Host').selectOption(f.hostId);
    await page.getByTestId('session-create').click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    await page.getByTestId('prompt-input').fill('Cross-device conversation marker');
    await page.getByTestId('prompt-submit').click();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Cross-device conversation marker');
    const original = page.url();
    expect(new URL(original).searchParams.get('host')).toBe(f.hostId);
    expect(new URL(original).searchParams.get('session')).toBeTruthy();
    await page.getByRole('button', { name: 'Share session link' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open session on another device' });
    await expect(dialog.getByLabel('Session URL')).toHaveValue(original);
    const qr = dialog.getByAltText('Session QR code');
    await expect(qr).toBeVisible();
    const pixels = await qr.evaluate(async (element: HTMLImageElement) => {
      await element.decode();
      const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0);
      return { data: [...context.getImageData(0, 0, canvas.width, canvas.height).data], width: canvas.width, height: canvas.height };
    });
    expect(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data).toBe(original);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy link' }).click();
    await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
    await page.screenshot({ path: testInfo.outputPath('session-qr.png') });
    await dialog.getByRole('button', { name: 'Close session link' }).click();

    const mobile = await phone.newPage();
    await mobile.goto(original);
    await signIn(mobile);
    await expect(mobile.getByTestId('prompt-input')).toBeEnabled();
    await expect(mobile.locator('.agent-message-assistant').last()).toContainText('Cross-device conversation marker');
    expect(mobile.url()).toBe(original);
    await mobile.getByRole('button', { name: 'Share session link' }).click();
    await expect(mobile.getByAltText('Session QR code')).toBeVisible();
    await mobile.screenshot({ path: testInfo.outputPath('session-qr-mobile.png') });
    await mobile.getByRole('button', { name: 'Close session link' }).click();
    await mobile.getByTestId('prompt-input').fill('Reply from phone');
    await mobile.getByTestId('prompt-submit').click();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Reply from phone');

    const computer = await desktop.newPage();
    await computer.goto(mobile.url());
    await signIn(computer);
    await expect(computer.getByTestId('prompt-input')).toBeEnabled();
    await expect(computer.locator('.agent-message-assistant').last()).toContainText('Reply from phone');

    f.setSubject('bob');
    const denied = await outsider.newPage();
    await denied.goto(original);
    await signIn(denied, 'bob');
    await expect(denied.getByRole('alert').first()).toBeVisible();
    await expect(denied.locator('.agent-message-user')).toHaveCount(0);
  } finally { await phone.close(); await desktop.close(); await outsider.close(); await f.close(); }
});

test('the address bar tracks a side session and opens it on a fresh device', async ({ page, browser }) => {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const root = page.locator('.lab-primary-conversation');
  await expect(root.getByTestId('prompt-input')).toBeEnabled();
  const source = page.url();
  await root.getByTestId('prompt-input').fill('/side Side link marker');
  await root.getByTestId('prompt-input').press('Enter');
  const side = page.locator('.lab-side-conversation');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Side link marker');
  const target = page.url();
  expect(target).not.toBe(source);
  const other = await browser.newContext();
  try {
    const receiving = await other.newPage();
    await receiving.goto(target);
    await expect(receiving.getByTestId('prompt-input')).toBeEnabled();
    await expect(receiving.locator('.agent-message-assistant').last()).toContainText('Side link marker');
    expect(new URL(receiving.url()).searchParams.get('session')).toBe(new URL(target).searchParams.get('session'));
  } finally { await other.close(); }
});
