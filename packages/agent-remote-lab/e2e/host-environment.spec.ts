import { expect, test } from '@playwright/test';
import { showNewSession } from './session-navigation';

test('filters execution environments without confusing same-name Hosts or overflowing mobile layout', async ({ page }, testInfo) => {
  const baseEnvironment = { detectedAt: Date.now(), os: { platform: 'linux', name: 'Ubuntu 24.04 LTS', arch: 'arm64', release: '6.8.0' },
    wsl: false, container: true, shell: { name: 'bash', source: 'account' }, shells: [],
    browsers: [{ id: 'chromium', name: 'Chromium', status: 'found' }], vscode: { status: 'not-found' } };
  const hosts = [{ id: 'linux', name: 'My Host', online: true, environment: baseEnvironment, providers: [{ providerId: 'codex', displayName: 'Codex' }] },
    { id: 'mac', name: 'My Host', online: true, environment: { ...baseEnvironment, os: { ...baseEnvironment.os, platform: 'darwin', name: 'macOS' },
      container: false, shell: { name: 'zsh', source: 'account' }, browsers: [], vscode: { status: 'found' } }, providers: [{ providerId: 'codex', displayName: 'Codex' }] }];
  await page.route('**/v1/remote/hosts', route => route.fulfill({ json: { hosts } }));
  await page.route('**/v1/remote/hosts/*/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/previews') ? { registrations: [], revision: 0, epoch: 'fixture' }
      : path.endsWith('/vscode-tunnel') ? { status: 'unavailable', processAlive: false, revision: 0 }
      : { items: [], workspaces: [], models: [], revision: '1', nextCursor: null };
    return route.fulfill({ json });
  });
  await page.goto('/');
  await showNewSession(page);
  const context = testInfo.project.name === 'chromium-mobile' ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
  const search = context.getByRole('searchbox', { name: 'Find an execution environment' });
  await search.fill('linux chromium');
  const selector = context.getByLabel('Connected Host');
  await expect(selector.locator('option:enabled')).toHaveCount(2); // Prompt plus one match.
  await selector.selectOption('linux');
  await expect(context.getByTestId('provider-select')).toHaveValue(JSON.stringify(['linux', 'codex']));
  await expect(context.getByLabel('Host environment')).toContainText('Ubuntu 24.04 LTS');
  await search.fill('mac zsh vscode');
  await expect(selector).toHaveValue('linux');
  await expect(selector.locator('option:enabled')).toHaveCount(1);
  await selector.selectOption('mac');
  await expect(context.getByTestId('provider-select')).toHaveValue(JSON.stringify(['mac', 'codex']));
  await expect(context.getByLabel('Host environment')).toContainText('VS Code');
  await search.fill('firefox');
  await expect(context.getByRole('status').filter({ hasText: 'No matching Hosts' })).toBeVisible();
  await expect(selector).toHaveValue('mac');
  await search.fill('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('host-environment.png') });
});
