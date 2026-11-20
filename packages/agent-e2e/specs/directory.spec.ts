import { openSettingsPage } from './all-sessions';
import { expect, test } from '@playwright/test';

test('creates a temporary pairing key through the workbench', async ({ page }) => {
  await page.goto('/');
  // Settings > Computers, from the rail (the Me tab on a phone).
  const context = await openSettingsPage(page, 'Computers');
  await context.getByRole('button', { name: 'Pair a computer' }).click();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/v1/remote/pairings') && response.request().method() === 'POST');
  await context.getByRole('button', { name: 'Generate pairing key' }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const invitation = await response.json();
  await expect(context.getByLabel('Agent Host configuration')).toHaveValue(new RegExp(invitation.key));
  await expect(context.getByRole('button', { name: 'Copy configuration' })).toBeEnabled();
  await expect(context.getByText(/Pair before/)).toBeVisible();
});
