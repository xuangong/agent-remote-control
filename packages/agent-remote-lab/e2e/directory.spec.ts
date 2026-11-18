import { openSessionsPage } from './all-sessions';
import { expect, test } from '@playwright/test';

test('creates a temporary pairing key through the workbench', async ({ page }, testInfo) => {
  await page.goto('/');
  const compact = testInfo.project.name === 'chromium-mobile';
  // Desktop shows Hosts on the All sessions page and settings on the Settings page, both opened from the sidebar.
  const context = compact ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-sessions-page');
  if (!compact) await openSessionsPage(page);
  await expect(context.getByRole('region', { name: 'Remote Hosts' })).toBeVisible();
  if (compact) await context.getByRole('button', { name: 'Settings', exact: true }).click();
  else await openSessionsPage(page, 'Settings');
  await context.getByRole('button', { name: 'Pair Agent Host' }).click();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/v1/remote/pairings') && response.request().method() === 'POST');
  await context.getByRole('button', { name: 'Generate pairing key' }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const invitation = await response.json();
  await expect(context.getByLabel('Agent Host configuration')).toHaveValue(new RegExp(invitation.key));
  await expect(context.getByRole('button', { name: 'Copy configuration' })).toBeEnabled();
  await expect(context.getByText(/Pair before/)).toBeVisible();
});
