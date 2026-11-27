// Component projects: orchard-phone-webkit, orchard-phone-chromium, webkit-desktop
import { expect, test } from '@playwright/test';

test('typed form text and plan feedback survive a remount of the timeline', async ({ page }) => {
  test.setTimeout(30_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/e2e/fixtures/question-input.html');
  await page.locator('input[name="note"]').fill('keep this note');
  await page.getByText('Show what changes').click();
  await page.locator('.agent-plan-feedback textarea').fill('keep this feedback');
  await page.waitForTimeout(50);
  await page.getByTestId('remount').click();
  await expect(page.locator('input[name="note"]')).toHaveValue('keep this note');
  await page.getByText('Show what changes').click();
  await expect(page.locator('.agent-plan-feedback textarea')).toHaveValue('keep this feedback');
  expect(errors).toEqual([]);
});
