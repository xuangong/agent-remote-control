import { showNewSession } from './session-navigation';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.AGENT_REMOTE_TEST_INTERACTIONS !== '1', 'Requires the deterministic interaction Provider.');

test('reviews typed interactions and recovers redacted history through the real Relay', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  const sent: Array<{ type?: string; payload?: { response?: unknown } }> = [];
  const incoming: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      try {
        const envelope = JSON.parse(String(payload));
        sent.push(envelope.type === 'message' ? envelope.message : envelope);
      } catch {}
    });
    socket.on('framereceived', ({ payload }) => incoming.push(String(payload)));
  });
  const screenshotDirectory = resolve('.tmp/interaction-capabilities', testInfo.project.name);
  await mkdir(screenshotDirectory, { recursive: true });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption('interaction-fixture');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const form = page.locator('.agent-form');
  await expect(form.getByRole('heading', { name: 'Connect a project' })).toBeVisible();
  await expect(form.getByLabel('Access token', { exact: true })).toHaveAttribute('type', 'password');
  await form.getByLabel('Access token', { exact: true }).fill('discarded-sensitive-draft');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('discarded-sensitive-draft');
  await page.reload();
  await expect(form.getByLabel('Access token', { exact: true })).toHaveValue('');
  await form.getByLabel('Contact email', { exact: true }).fill('developer@example.test');
  await form.getByLabel('Access token', { exact: true }).fill('  browser-secret  ');
  await form.getByLabel('Retry limit', { exact: true }).fill('4');
  await form.getByLabel('Share diagnostics', { exact: true }).selectOption('false');
  await form.getByLabel('Region', { exact: true }).selectOption('eu');
  await form.getByLabel('Features', { exact: true }).selectOption(['search', 'reports']);
  await page.context().setOffline(true);
  const relayUrl = `http://127.0.0.1:${process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 6016}`;
  const disconnected = await request.post(`${relayUrl}/v1/lab/interactions/disconnect`, { headers: { origin: new URL(page.url()).origin } });
  expect(disconnected.status()).toBe(204);
  await expect(form.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await expect(form).toContainText('Reconnect to respond.');
  await expect(form.getByLabel('Access token', { exact: true })).toHaveValue('  browser-secret  ');
  await expect(form.getByLabel('Region', { exact: true })).toHaveValue('eu');
  await page.screenshot({ path: resolve(screenshotDirectory, 'form-offline.png'), fullPage: true });
  await page.context().setOffline(false);
  await expect(form.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  await expect(form.getByLabel('Contact email', { exact: true })).toHaveValue('developer@example.test');
  await expect(form.getByLabel('Access token', { exact: true })).toHaveValue('  browser-secret  ');
  await expect(form.getByLabel('Retry limit', { exact: true })).toHaveValue('4');
  await expect(form.getByLabel('Share diagnostics', { exact: true })).toHaveValue('false');
  await expect(form.getByLabel('Region', { exact: true })).toHaveValue('eu');
  await expect(form.getByLabel('Features', { exact: true })).toHaveValues(['search', 'reports']);
  expect(sent.filter((message) => message.type === 'interaction_response')).toHaveLength(0);
  await form.getByRole('button', { name: 'Submit', exact: true }).click();
  expect(sent.filter((message) => message.type === 'interaction_response')).toHaveLength(0);
  await form.getByLabel('Retry limit', { exact: true }).fill('2');
  await page.screenshot({ path: resolve(screenshotDirectory, 'form-fields.png'), fullPage: true });
  await page.getByTestId('timeline').focus();
  await page.getByTestId('timeline').press('Home');
  await expect(form.getByRole('heading', { name: 'Connect a project' })).toBeInViewport();
  await page.screenshot({ path: resolve(screenshotDirectory, 'form.png'), fullPage: true });
  await form.getByRole('button', { name: 'Submit', exact: true }).click();
  const permission = page.locator('.agent-permission');
  await expect(permission.getByRole('heading', { name: 'Review requested access' })).toBeVisible();
  await expect(permission).toContainText('/workspace/project');
  await expect(permission).toContainText('api.example.test');
  await expect(permission.getByRole('button', { name: 'Allow for session' })).toHaveCount(0);
  await expect(page.locator('.agent-interaction-completed').filter({ hasText: 'Connect a project' })).toContainText('Hidden answer');
  await page.screenshot({ path: resolve(screenshotDirectory, 'permissions.png'), fullPage: true });
  await permission.getByRole('button', { name: 'Allow for turn', exact: true }).click();

  const external = page.locator('.agent-external-action');
  await expect(external.getByRole('heading', { name: 'Verify the project connection' })).toBeVisible();
  const link = external.getByRole('link', { name: 'Open example.test' });
  await expect(link).toHaveAttribute('href', 'https://example.test/verify');
  const beforeLink = sent.filter((message) => message.type === 'interaction_response').length;
  await page.context().route('https://example.test/verify', (route) => route.fulfill({ body: '<p>Fixture verification complete.</p>', contentType: 'text/html' }));
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await popup.close();
  expect(sent.filter((message) => message.type === 'interaction_response')).toHaveLength(beforeLink);
  await expect(external).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDirectory, 'external-action.png'), fullPage: true });
  await external.getByRole('button', { name: 'I have completed this', exact: true }).click();

  const policy = page.locator('.agent-tool-approval');
  await expect(policy.getByRole('heading', { name: 'Approval required' })).toBeVisible();
  await expect(policy).toContainText('Read project configuration');
  await expect(policy).toContainText('/workspace/project/**');
  await expect(policy.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0);
  await expect(policy.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.screenshot({ path: resolve(screenshotDirectory, 'policy.png'), fullPage: true });
  await policy.locator('summary').click();
  await expect(policy.getByText('Allow project reads', { exact: true })).toBeVisible();
  await policy.getByRole('button', { name: 'Apply rule', exact: true }).click();
  await expect(page.getByText('The fixture verified all four exact interaction responses.', { exact: true })).toBeVisible();
  expect(sent.filter((message) => message.type === 'interaction_response').map((message) => message.payload?.response)).toEqual([
    { kind: 'form', action: 'submit', values: { email: 'developer@example.test', token: '  browser-secret  ', retries: 2, telemetry: false, region: 'eu', features: ['search', 'reports'] } },
    { kind: 'permission_approval', decision: 'allow', scope: 'turn' },
    { kind: 'external_action', action: 'completed' },
    { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'project-read' },
  ]);
  expect(incoming.join('\n')).not.toContain('browser-secret');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('browser-secret');
  const agentId = new URL(page.url()).searchParams.get('agent')!;
  const history = await request.get(`${relayUrl}/v1/sessions/${encodeURIComponent(agentId)}/timeline?protocolVersion=1.5.0&requestId=browser-history&direction=tail&limit=100`);
  expect(history.ok()).toBe(true);
  const historyText = await history.text();
  expect(historyText).not.toContain('browser-secret');
  expect(historyText).toContain('redactedFields');
  await page.reload();
  await expect(page.getByText('The fixture verified all four exact interaction responses.', { exact: true })).toBeVisible();
  await expect(page.locator('.agent-interaction')).toHaveCount(0);
  await expect(page.locator('.agent-interaction-completed')).toHaveCount(4);
  await expect(page.getByText('Hidden answer', { exact: true })).toBeVisible();
  await page.getByText('Hidden answer', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(screenshotDirectory, 'completed-history.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
