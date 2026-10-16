import { expect, test, type WebSocketRoute } from '@playwright/test';
import { showNewSession } from './session-navigation';

test('reopening during reconnect shows the latest working messages before attach completes', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const connections: WebSocketRoute[] = [];
  let recovering = false;
  await page.routeWebSocket(/\/v1\/(session-channel|sessions\/.+\/events)/, socket => {
    if (recovering) return;
    socket.connectToServer();
    connections.push(socket);
  });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const input = page.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await expect(page.getByTestId('timeline')).toContainText('Previous completed round.');
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
    .some(([key, value]) => key.includes(':workspace:') && value.includes('Previous completed round.')))).toBe(true);
  await input.fill('Continue with new work.');
  await input.press('Enter');
  await expect(page.getByTestId('timeline')).toContainText('Latest visible reply while work continues.');
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Working');
  const sessionUrl = page.url();
  expect(connections.length).toBeGreaterThan(0);
  recovering = true;
  await Promise.all(connections.map(socket => socket.close({ code: 1012, reason: 'Fixture transport interrupted' })));
  await expect(page.getByText('Timeline synchronization is reconnecting.', { exact: true })).toBeVisible();
  // A real document navigation invokes pagehide, as leaving the active page does.
  await page.goto('about:blank');
  let attachStarted = false;
  await page.route('**/v1/remote/attach', route => { attachStarted = true; return new Promise<void>(resolve => {
    page.once('close', () => { void route.abort().catch(() => {}); resolve(); });
  }); });
  await page.goto(sessionUrl);
  await expect.poll(() => attachStarted).toBe(true);
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Opening session');
  await expect(page.getByTestId('timeline')).toContainText('Latest visible reply while work continues.');
  await expect(page.getByTestId('timeline')).toContainText('Continue with new work.');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('working-cache-during-opening.png'), fullPage: true });
});
