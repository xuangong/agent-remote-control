import { expect, test } from '@playwright/test';
import type { VscodeTunnelSnapshot } from '@agent-remote-controller/agent-remote-protocol';

test('authorizes one Host tunnel, opens the workspace and removes stale links', async ({ page }, testInfo) => {
  let state: VscodeTunnelSnapshot = { status: 'stopped', processAlive: false, revision: 0 };
  await page.route('**/v1/remote/hosts/desktop/vscode-tunnel**', async route => {
    const request = route.request();
    if (request.url().endsWith('/start')) {
      expect(request.postDataJSON()).toEqual({ acceptLicense: true });
      state = { status: 'awaiting_auth', processAlive: true, revision: 1, authorization: { url: 'https://github.com/login/device', code: 'ABCD-1234' } };
    } else if (request.url().endsWith('/stop')) state = { status: 'stopped', processAlive: false, revision: 3 };
    await route.fulfill({ json: state, headers: { 'cache-control': 'no-store' } });
  });
  await page.goto('/e2e/fixtures/vscode-tunnel.html');
  const panel = page.getByRole('region', { name: 'Host VS Code tunnel' });
  await expect(panel.getByRole('button', { name: 'Start tunnel' })).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Start tunnel' }).click();
  await expect(panel.locator('code')).toHaveText('ABCD-1234');
  await expect(panel.getByRole('link', { name: /sign-in/ })).toHaveAttribute('href', 'https://github.com/login/device');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('vscode-sign-in.png'), fullPage: true });
  state = { status: 'connected', processAlive: true, tunnelName: 'my-mac', revision: 2 };
  await expect(page.locator('a[data-vscode-workspace]')).toHaveAttribute('href', 'https://vscode.dev/tunnel/my-mac/Users/me/My%20project%231');
  await expect(panel.locator('code')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('vscode-connected.png'), fullPage: true });
  state = { status: 'exited', processAlive: false, signal: 'SIGKILL', revision: 3 };
  await expect(page.locator('a[data-vscode-workspace]')).toHaveCount(0);
  await expect(panel.getByText(/Stopped by SIGKILL/)).toBeVisible();
  await panel.getByRole('button', { name: 'Start tunnel' }).click();
  await expect(panel.locator('code')).toHaveText('ABCD-1234');
  await panel.getByRole('button', { name: 'Stop tunnel' }).click();
  await expect(panel.locator('code')).toHaveCount(0);
  await expect(panel.getByRole('status')).toContainText('Stopped');
});
