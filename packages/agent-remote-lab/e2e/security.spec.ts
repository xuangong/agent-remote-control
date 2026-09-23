import { test, expect } from '@playwright/test';

test('security supports narrow screens, keyboard return, draft preservation and explicit all-browser sign-out', async ({ page }, testInfo) => {
  const mutations: string[] = [];
  const now = Date.now();
  await page.route('**/auth/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/status') return route.fulfill({ json: { basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: now + 120000 } });
    if (path === '/auth/sessions') return route.fulfill({ json: { sessions: [{ id: 'current', label: 'Chrome on this device', createdAt: now, lastSeenAt: now, expiresAt: now + 3600000, current: true }, { id: 'other', label: 'Safari on Mac', createdAt: now, lastSeenAt: now, expiresAt: now + 3600000, current: false }], authenticatedAt: now, recentAuthentication: true } });
    if (path === '/auth/audit') return route.fulfill({ json: { events: [{ id: 'one', at: now, action: 'device_rotated', outcome: 'success', hostId: 'studio' }] } });
    mutations.push(path); return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/e2e/fixtures/security.html');
  await page.getByLabel('Message draft').fill('Keep this draft');
  await page.getByRole('button', { name: 'Open side conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const entry = page.getByRole('region', { name: 'Controller settings' }).getByRole('button', { name: 'Security', exact: true });
  await entry.click();
  const security = page.getByRole('main', { name: 'Security' });
  await expect(security.getByRole('heading', { name: 'Security', exact: true })).toBeFocused();
  await expect(page.getByLabel('Message draft')).toBeHidden();
  await expect(security.getByText('Safari on Mac', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('security.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(entry).toBeFocused();
  await expect(page.getByLabel('Message draft')).toHaveValue('Keep this draft');
  await expect(page.getByText('Side conversation remains open')).toBeVisible();
  await entry.click();
  await security.getByRole('button', { name: 'Sign out all browsers', exact: true }).click();
  expect(mutations).toEqual([]);
  await security.getByRole('button', { name: 'Confirm sign out' }).click();
  await expect(page.getByLabel('Message draft')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in through gateway' })).toBeVisible();
  expect(mutations).toEqual(['/auth/sessions/revoke-all']);
});

test('rotation reauthentication preserves only the canonical session target and never replays', async ({ page }) => {
  let rotations = 0;
  await page.route('**/auth/status', route => route.fulfill({ json: { basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 120000 } }));
  await page.route('**/v1/remote/hosts/studio/rotate', route => { rotations++; return route.fulfill({ status: 403, json: { code: 'reauthentication_required', loginUrl: 'https://evil.example/steal' } }); });
  await page.goto('/e2e/fixtures/security.html?host=studio&provider=codex&session=native-one&redirect=https://evil.example');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate credential' }).click();
  await page.getByRole('button', { name: 'Confirm rotation' }).click();
  const signIn = page.getByRole('link', { name: 'Sign in again' });
  await expect(signIn).toHaveAttribute('href', '/auth/login?reauthenticate=1&host=studio&provider=codex&session=native-one');
  expect(rotations).toBe(1);
  await page.route('**/auth/login?**', route => route.fulfill({ contentType: 'text/html', body: '<p>Fresh login</p>' }));
  await signIn.click();
  expect(await page.evaluate(() => sessionStorage.getItem('agent-remote-sign-in-return'))).toBe('/?host=studio&provider=codex&session=native-one');
  expect(rotations).toBe(1);
});


test('daemon restart requires Host confirmation and fits the settings panel', async ({ page }, testInfo) => {
  const revision = '00000000-0000-4000-8000-000000000001';
  let writes = 0;
  let status: Record<string, unknown> = { revision, phase: 'idle', updatedAt: 0 };
  await page.route('**/auth/status', route => route.fulfill({ json: { basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 120000 } }));
  await page.route('**/v1/remote/hosts/studio/codex-daemon', route => {
    if (route.request().method() === 'POST') {
      writes++;
      const intent = route.request().postDataJSON();
      expect(intent.revision).toBe(revision);
      status = { revision: '00000000-0000-4000-8000-000000000002', operationId: intent.operationId, phase: 'restarting', updatedAt: 1 };
    }
    return route.fulfill({ json: status });
  });
  await page.goto('/e2e/fixtures/security.html?daemon-control');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Restart Codex daemon', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Confirm Codex daemon restart' });
  await expect(confirmation).toContainText('Studio Mac');
  await expect(confirmation).toContainText('including local CLI sessions');
  await expect(confirmation).toContainText('Running tasks will be interrupted');
  expect(writes).toBe(0);
  await confirmation.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('daemon-confirmation.png'), fullPage: true });
  await confirmation.getByRole('button', { name: 'Confirm restart', exact: true }).click();
  await expect(page.getByText('Restarting Codex daemon…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart Codex daemon', exact: true })).toBeDisabled();
  status = { ...status, phase: 'ready', updatedAt: 2 };
  await expect(page.getByText('Restart completed.', { exact: false })).toBeVisible();
  expect(writes).toBe(1);
  await expect(page.getByLabel('Message draft')).toHaveValue('Unsent draft');
});
