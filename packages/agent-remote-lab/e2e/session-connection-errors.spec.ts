import { expect, test } from '@playwright/test';

for (const scenario of [
  { code: 'session_attach_timeout', status: 504, role: 'status', text: 'may still be opening' },
  { code: 'native_history_timeout', status: 503, role: 'alert', text: 'reading session history' },
] as const) {
  test(`explains ${scenario.code} and clears it when the same session opens`, async ({ page }, testInfo) => {
    let attempts = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/v1/remote/attach', async route => {
      if (++attempts > 1) return route.continue();
      await route.fulfill({ status: scenario.status, contentType: 'application/json', body: JSON.stringify({
        code: scenario.code, error: 'Fixture failure', requestId: 'diagnostic-request-1',
      }) });
    });
    await page.goto('/');
    const context = testInfo.project.name === 'chromium-mobile' ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
    const session = context.getByRole('region', { name: 'Discover sessions' }).locator('.lab-session-row').first();
    await session.click();
    const notice = page.locator('.lab-session-notice');
    await expect(notice.getByRole(scenario.role)).toContainText(scenario.text);
    await expect(notice).not.toContainText('Retrying automatically');
    const toast = page.locator('.lab-toast').filter({ hasText: 'Session connection' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(scenario.text);
    await page.screenshot({ path: testInfo.outputPath('notification.png'), fullPage: true });
    await toast.getByRole('button', { name: 'Dismiss notification: Session connection' }).click();
    await expect(toast).toHaveCount(0);
    await notice.getByText('Connection details', { exact: true }).click();
    await expect(notice).toContainText(scenario.code);
    await expect(notice).toContainText('diagnostic-request-1');
    await expect(notice).toContainText(String(scenario.status));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('connection-details.png'), fullPage: true });
    await session.click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    await expect(notice).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
  });
}
