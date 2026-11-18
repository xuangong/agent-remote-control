import { expect, test } from '@playwright/test';
test('confirms one compatible Host and explains rollback without overflowing mobile', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/controller-updates.html');
  await page.getByRole('button', { name: /Controller updates/ }).click();
  await expect(page.getByText('Offline laptop')).toBeVisible();
  await page.getByRole('button', { name: 'Update Host', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm Controller update' })).toContainText('Update 1 online Host');
  await page.getByRole('button', { name: 'Confirm update', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('previous version was restored');
  await expect(page.getByRole('button', { name: 'Retry update' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('controller-rollback.png'), fullPage: true });
});
