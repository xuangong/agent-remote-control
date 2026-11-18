import { expect, test } from '@playwright/test';

test('reviews long commands and rules without expanding completed approval history', async ({ page }, testInfo) => {
  test.setTimeout(30_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/e2e/fixtures/tool-approval.html');
  const approval = page.locator('.agent-tool-approval');
  await expect(approval.getByRole('heading', { name: 'Approval required' })).toBeVisible();
  await expect(approval.locator('pre')).toContainText('cmd.exe');
  await expect(approval.getByRole('button', { name: 'Apply rule', exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('approval.png') });

  await approval.locator('summary').click();
  const apply = approval.getByRole('button', { name: 'Apply rule', exact: true });
  await expect(apply).toBeVisible();
  await expect(apply).toHaveAccessibleDescription(/Allow command prefix/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('approval-rules.png') });
  await apply.click();

  const receipt = page.locator('.agent-tool-approval-completed');
  const toggle = receipt.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('Rule applied');
  await expect(receipt.locator('pre')).toHaveCount(0);
  expect((await receipt.boundingBox())!.height).toBeLessThan(60);
  await page.screenshot({ path: testInfo.outputPath('approval-completed.png') });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(receipt).toContainText('Working directory');
  await expect(receipt).toContainText('Allow command prefix');
  await expect(receipt.locator('pre')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('approval-receipt.png') });
  expect(errors).toEqual([]);
});
