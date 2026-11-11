import { expect, test } from '@playwright/test';
import { selectConnectedHost } from './all-sessions';
import jsQR from 'jsqr';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';
import { clickSessionAction } from './session-actions';

test('shares a decodable QR without fetching more scripts from an older open page', async ({ page }, info) => {
  test.setTimeout(60000);
  const fixture = await sessionLinkFixture();
  try {
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: 'Sign in as alice' }).click();
    await selectConnectedHost(page, fixture.hostId);
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    await expect(page).toHaveURL(/[?&]session=/);
    // The shared link names the session, not the sharer's Window (?window=<id>).
    const address = new URL(page.url()); address.searchParams.delete('window');
    const original = address.href;
    const lateScripts: string[] = [];
    await page.route('**/assets/*.js', route => {
      lateScripts.push(route.request().url());
      return route.fulfill({ status: 404, body: 'Asset no longer available' });
    });
    // Share sits among the view's session actions, which may keep it behind "More session actions".
    await clickSessionAction(page.locator('.lab-primary-conversation'), 'Share session link');
    const dialog = page.getByRole('dialog', { name: 'Share session', exact: true });
    const qr = dialog.getByAltText('Session QR code');
    await expect(qr).toBeVisible();
    expect(lateScripts).toEqual([]);
    const pixels = await qr.evaluate(async (image: HTMLImageElement) => {
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return { data: [...context.getImageData(0, 0, canvas.width, canvas.height).data], width: canvas.width, height: canvas.height };
    });
    expect(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data).toBe(original);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('session-qr.png') });
  } finally { await fixture.close(); }
});
