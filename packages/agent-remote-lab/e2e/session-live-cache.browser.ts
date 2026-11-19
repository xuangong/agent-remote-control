import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { SESSION_CONNECTION_PATTERN } from '@orchardworks/agent-e2e/faults/connection-words.mjs';
import { showNewSession } from './session-navigation';

/** The text is in a conversation record of this browser's device store (IndexedDB). */
const deviceStoreHolds = (page: Page, text: string) => page.evaluate(wanted => new Promise<boolean>(resolve => {
  const opening = indexedDB.open('agent-remote-image-drafts');
  opening.onerror = () => resolve(false);
  opening.onsuccess = () => {
    const database = opening.result;
    if (!database.objectStoreNames.contains('sessions')) { database.close(); resolve(false); return; }
    const rows = database.transaction('sessions', 'readonly').objectStore('sessions').getAll();
    rows.onerror = () => { database.close(); resolve(false); };
    rows.onsuccess = () => { database.close(); resolve(JSON.stringify(rows.result).includes(wanted)); };
  };
}), text);

test('reopening during reconnect shows the stored rows, no connection word and an open editor before attach completes', async ({ page }, testInfo) => {
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
  await expect.poll(() => deviceStoreHolds(page, 'Previous completed round.')).toBe(true);
  await input.fill('Continue with new work.');
  await input.press('Enter');
  await expect(page.getByTestId('timeline')).toContainText('Latest visible reply while work continues.');
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Working');
  const sessionUrl = page.url();
  expect(connections.length).toBeGreaterThan(0);
  recovering = true;
  await Promise.all(connections.map(socket => socket.close({ code: 1012, reason: 'Fixture transport interrupted' })));
  await expect(page.locator('body')).not.toContainText(SESSION_CONNECTION_PATTERN);
  // A real document navigation invokes pagehide, as leaving the active page does.
  await page.goto('about:blank');
  let attachStarted = false;
  await page.route('**/v1/remote/attach', route => { attachStarted = true; return new Promise<void>(resolve => {
    page.once('close', () => { void route.abort().catch(() => {}); resolve(); });
  }); });
  await page.goto(sessionUrl);
  await expect.poll(() => attachStarted).toBe(true);
  await expect(page.locator('body')).not.toContainText(SESSION_CONNECTION_PATTERN);
  // The device keeps a conversation when a page is confirmed and when a turn ends, so the reopened page shows the stored round, not the work in between.
  await expect(page.getByTestId('timeline')).toContainText('Previous completed round.');
  await expect(page.getByTestId('timeline')).not.toContainText('Latest visible reply while work continues.');
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('working-cache-during-opening.png'), fullPage: true });
});
