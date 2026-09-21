import { expect, test } from '@playwright/test';

for (const purpose of ['host-only', 'gateway-setup'] as const) {
  test(`creates and revokes a ${purpose} invitation without retaining its secret`, async ({ page }, testInfo) => {
    const records: Array<{ id: string; purpose: string; createdAt: string; expiresAt: string; status: string }> = [];
    await page.route('**/v1/remote/pairings', async route => {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ purpose });
        const record = { id: 'new-invitation', purpose, createdAt: '2026-09-21T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', status: 'unused' };
        records.push(record);
        await route.fulfill({ json: { ...record, key: 'one-time-pairing-secret', serverUrl: 'https://relay.example' } });
      } else await route.fulfill({ json: { pairings: records, availablePurposes: ['host-only', 'gateway-setup'] } });
    });
    await page.route('**/v1/remote/pairings/new-invitation/revoke', async route => {
      expect(route.request().method()).toBe('POST');
      records[0]!.status = 'revoked';
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    const compact = testInfo.project.name === 'chromium-mobile';
    const context = compact ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
    await context.getByRole('button', { name: compact ? 'Settings' : 'Sidebar settings', exact: true }).click();
    await context.getByRole('button', { name: 'Pair Agent Host', exact: true }).click();
    await expect(context.getByLabel('Pairing purpose', { exact: true })).toHaveValue('host-only');
    if (purpose === 'gateway-setup') await context.getByLabel('Pairing purpose', { exact: true }).selectOption(purpose);
    await context.getByRole('button', { name: 'Generate pairing key', exact: true }).click();
    await expect(context.getByLabel('Agent Host configuration')).toHaveValue(/one-time-pairing-secret/);
    const history = context.getByRole('region', { name: 'Pairing key history', exact: true });
    await expect(history.getByText('Unused', { exact: true })).toBeVisible();
    await expect(history).not.toContainText('one-time-pairing-secret');
    await history.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await history.getByRole('button', { name: 'Confirm key revocation', exact: true }).click();
    await expect(history.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(context.getByLabel('Agent Host configuration')).toHaveCount(0);
  });
}
