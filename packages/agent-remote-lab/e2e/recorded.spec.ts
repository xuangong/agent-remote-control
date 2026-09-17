import { showNewSession } from './session-navigation';
import { toggleViewPanel } from './view-options';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('sends a multiline conversation through the Relay and returns focus to an empty composer', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption({ label: 'Recorded semantic Provider' });
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const input = page.getByTestId('prompt-input');
  const timeline = page.getByTestId('timeline');
  const expectLatest = async (): Promise<void> => {
    await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('button', { name: 'Back to latest' })).toHaveCount(0);
  };
  await expect(input).toBeEnabled();
  await expect(timeline.locator('.agent-timeline-entry')).toHaveCount(6);
  await expectLatest();
  await input.fill('Help me improve the conversation experience.');
  await input.press('Shift+Enter');
  await input.press('Shift+Enter');
  await input.pressSequentially('Keep the **shared React components**, and make protocol details easy to inspect.');
  await expect(input).toHaveValue('Help me improve the conversation experience.\n\nKeep the **shared React components**, and make protocol details easy to inspect.');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(page.locator('.agent-message-user').filter({ hasText: 'Help me improve the conversation experience.' })).toContainText('shared React components');
  await expect(page.locator('.agent-message-assistant').filter({ hasText: 'Recorded reply: Help me improve' })).toContainText('shared React components');
  await expectLatest();
  await input.fill('Keep the conversation readable while the Agent works.\n\nShow concise tool summaries, preserve my place when I read earlier messages, and let me return to the latest reply.');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(page.locator('.agent-message-assistant').filter({ hasText: 'Recorded reply: Keep the conversation readable' })).toContainText('return to the latest reply.');
  await expectLatest();
  expect(browserErrors.console).toEqual([]);
  expect(browserErrors.page).toEqual([]);
});

test('covers recorded Snapshot, Timeline, interactions, replacement, and durable resources through the UI', async ({ page }, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');
  await expect(page.locator('.lab-app-bar')).toBeHidden();
  await showNewSession(page);
  const context = contextRail(page, testInfo);
  await expect(context.locator('.lab-provider-controls .lab-eyebrow')).toHaveText('New session');
  await expect(context.getByTestId('provider-select')).toBeVisible();
  await expect(context.getByRole('button', { name: 'Open session' })).toBeVisible();
  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption({ label: 'Recorded semantic Provider' });
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  if (isCompact(testInfo)) await expect(context).toHaveCount(0);
  await toggleViewPanel(page, 'Header');
  const summary = page.getByTestId('connection-summary');
  await expect(summary).toContainText('Recorded semantic Provider');
  await expect(summary).toContainText('Ready');
  await expect(summary.locator('code')).toHaveText(new URL(page.url()).searchParams.get('agent')!);
  await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible();
  await expect(page.getByLabel('Agent timeline')).toBeVisible();
  await expect(page.getByLabel('Live provider controls')).toBeVisible();
  await expect(page.getByTestId('prompt-input')).toBeVisible();
  await expect(page.getByTestId('timeline').locator('.agent-timeline-entry')).toHaveCount(6);

  await page.getByRole('tab', { name: 'Trace' }).click();
  const trace = page.getByTestId('trace-view');
  await expect(trace.getByRole('heading', { name: 'Normalized Timeline trace' })).toBeVisible();
  await expect(trace.getByText(/normalized Timeline received by the Web client/)).toBeVisible();
  await expect(trace.getByText(/Provider-native and raw wire frames are not retained/)).toBeVisible();
  await expect(trace.locator('.lab-trace-list > li')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Workbench' }).click();

  const inspector = await openInspector(page, testInfo);
  await expect(inspector.getByText('Agent Snapshot')).toBeVisible();
  await expect(inspector.getByText('Timeline synchronization')).toBeVisible();
  await expect(inspector.getByText('Declared capabilities')).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Client diagnostics' })).toBeVisible();
  await expect(inspector.getByTestId('connection-status')).toHaveText('Ready');
  await expect(inspector.getByTestId('session-status')).toHaveText('idle');
  await expect(inspector.getByTestId('timeline-epoch')).not.toHaveText('—');
  await expect(inspector.getByText('send message available')).toBeVisible();
  await expect(inspector.getByText('question available')).toBeVisible();
  if (isCompact(testInfo)) {
    await inspector.getByRole('button', { name: 'Close Replica Inspector' }).click();
    await expect(inspector).toHaveCount(0);
  }
  const fixtureControls = await openContextForFixture(page, testInfo);
  await expect(fixtureControls.getByLabel('Lab scenario controls')).toBeVisible();
  if (isCompact(testInfo)) await page.getByRole('button', { name: 'Close Context' }).click();

  await expect(page.getByTestId('timeline').locator('.agent-timeline-entry')).toHaveCount(6);
  await expect(page.getByText('Recorded history 1')).toBeVisible();

  const availableResource = resourceRow(page, 'artifacts/lab-proof.txt');
  await expect(availableResource).toContainText('Available');
  await availableResource.getByRole('button', { name: 'Load resource' }).click();
  const firstDownload = page.waitForEvent('download');
  await availableResource.getByRole('link', { name: 'Download resource' }).click();
  expect(await readFile(await (await firstDownload).path() as string, 'utf8')).toBe('BORgee Agent Remote durable resource\n');
  await expect(resourceRow(page, 'artifacts/missing.txt')).toContainText('Unavailable');

  await (await openContextForFixture(page, testInfo)).getByTestId('playback-advance').click();
  await expect(page.getByText('Recorded observation advanced.')).toBeVisible();
  if (isCompact(testInfo)) await page.getByRole('button', { name: 'Close Context' }).click();
  await expect(page.getByText('Live recorded output.')).toBeVisible();
  await expect(page.locator('article.agent-tool').filter({ hasText: 'read' }).filter({ hasText: 'Completed' })).toBeVisible();
  await expect(page.locator('article.agent-todo').filter({ hasText: 'Report result' })).toBeVisible();

  await page.getByLabel('Stable (Recommended)').check();
  await page.getByRole('button', { name: 'Submit response' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow for session' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Allow once' }).click();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByText('All recorded interactions resolved.')).toBeVisible();

  await (await openContextForFixture(page, testInfo)).getByTestId('playback-rehydrate').click();
  await expect(page.getByText('Recorded Timeline rehydrated.')).toBeVisible();
  if (isCompact(testInfo)) await page.getByRole('button', { name: 'Close Context' }).click();
  await expect(page.getByText('Authoritative rehydrated Timeline.')).toBeVisible();
  await expect(page.getByText('Recorded history 1')).toHaveCount(0);
  await expect(resourceRow(page, 'artifacts/lab-proof.txt')).toContainText('Available');

  await (await openContextForFixture(page, testInfo)).getByTestId('playback-stop-reader').click();
  await expect(page.getByText('Provider resource reader stopped.')).toBeVisible();
  if (isCompact(testInfo)) await page.getByRole('button', { name: 'Close Context' }).click();
  await page.reload();
  await expect(page.getByTestId('connection-summary')).toContainText('Ready');
  const reloadedResource = resourceRow(page, 'artifacts/lab-proof.txt');
  await reloadedResource.getByRole('button', { name: 'Load resource' }).click();
  const secondDownload = page.waitForEvent('download');
  await reloadedResource.getByRole('link', { name: 'Download resource' }).click();
  expect(await readFile(await (await secondDownload).path() as string, 'utf8')).toBe('BORgee Agent Remote durable resource\n');

  expect(browserErrors.console).toEqual([]);
  expect(browserErrors.page).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('recorded-visible.png'), fullPage: true });
});

function resourceRow(page: Page, locator: string) {
  return page.locator('.agent-resources li').filter({ hasText: locator });
}

function isCompact(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'chromium-mobile';
}

function contextRail(page: Page, testInfo: TestInfo): Locator {
  return isCompact(testInfo) ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
}

async function openContextForFixture(page: Page, testInfo: TestInfo): Promise<Locator> {
  if (isCompact(testInfo)) {
    await toggleViewPanel(page, 'Sidebar');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  } else await page.getByRole('button', { name: 'Sidebar settings', exact: true }).click();
  return contextRail(page, testInfo);
}

async function openInspector(page: Page, testInfo: TestInfo): Promise<Locator> {
  await toggleViewPanel(page, 'Replica Inspector');
  return isCompact(testInfo) ? page.getByRole('dialog', { name: 'Replica Inspector' }) : page.locator('#lab-inspector');
}

function collectBrowserErrors(page: Page): { console: string[]; page: string[] } {
  const errors = { console: [] as string[], page: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') errors.console.push(`${message.text()} (${message.location().url})`); });
  page.on('pageerror', (error) => errors.page.push(error.message));
  return errors;
}
