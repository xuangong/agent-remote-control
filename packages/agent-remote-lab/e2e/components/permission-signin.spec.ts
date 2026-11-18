import { expect, test } from '@playwright/test';

test('permission recovery offers a visible sign-in action inside the panel and returns to the session', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/permission-signin.html?host=studio&provider=codex&session=native-one&redirect=https://evil.example');
  await page.getByTestId('session-permissions-button').click();
  const panel = page.getByRole('region', { name: 'Permission settings' });
  await panel.getByLabel('Sandbox', { exact: true }).selectOption('dangerFullAccess');
  const signIn = panel.getByRole('link', { name: 'Sign in again', exact: true });
  await expect(signIn).toBeInViewport();
  await expect(signIn).toHaveAttribute('href', '/auth/login?reauthenticate=1&host=studio&provider=codex&session=native-one');
  expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(panel.getByLabel('Sandbox', { exact: true })).toHaveValue('readOnly');
  await expect(page.getByTestId('prompt-input')).toHaveValue('Keep my draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('permission-signin.png') });
  await page.route('**/auth/login?**', route => route.fulfill({ contentType: 'text/html', body: '<p>Sign-in started</p>' }));
  await signIn.click();
  await expect(page.getByText('Sign-in started')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('agent-remote-sign-in-return'))).toBe('/?host=studio&provider=codex&session=native-one');
});
