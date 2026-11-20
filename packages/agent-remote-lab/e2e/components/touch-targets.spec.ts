import { expect, test } from '@playwright/test';

// The touch minimum is 44 px. The composer's stop button is drawn at 32 px; under a coarse pointer
// its target, which stops a running turn, must still meet the minimum.
test('Interrupt meets the 44 px touch minimum while a turn runs', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The touch minimum applies to coarse pointers.');
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html');
  const interrupt = page.getByTestId('cancel-submit');
  await expect(interrupt).toBeVisible();
  const bounds = (await interrupt.boundingBox())!;
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.width).toBeGreaterThanOrEqual(44);
});
