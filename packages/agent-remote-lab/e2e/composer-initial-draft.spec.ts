import { expect, test } from '@playwright/test';
import { showNewSession } from './session-navigation';

test('retains the first command entered after creating a source session', async ({ page }) => {
  await page.goto('/');
  await showNewSession(page);
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await page.getByTestId('session-create').click();
  expect((await created).ok()).toBe(true);
  const primary = page.locator('.lab-primary-conversation > .lab-session-view');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(page).toHaveTitle('New session · Agent Remote Control');
  await primary.getByTestId('prompt-input').fill('/ask');
  await expect(primary.getByTestId('prompt-input')).toHaveText('/ask');
  await expect(primary.getByTestId('prompt-submit')).toBeEnabled();
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(page.getByRole('button', { name: 'Ask about this session', exact: true })).toBeVisible();
});
