import { showNewSession } from './session-navigation';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const readPrompt = 'Call the read tool exactly once with file_path set to live-fixture.txt. Then reply with the exact file content and stop.';
const todoPrompt = 'Call todo_write exactly once with two items: "Inspect live fixture" completed and "Report live result" in_progress. Then reply with the single token LIVE_DSH_TODO_DONE and stop.';
const generatedResourcePrompt = 'Call the write tool exactly once with file_path set to generated-proof.txt and content set to DSH_GENERATED_RESOURCE followed by one newline. Then reply with the single token LIVE_DSH_RESOURCE_READY and stop.';
const planPrompt = 'You are in plan mode. Call exit_plan_mode exactly once with the complete plan "# Browser verification plan\\n\\n1. Continue after approval." Do not call another tool. After the user approves, reply with the single token LIVE_DSH_PLAN_CONTINUED and stop.';

const mobilePlanPrompt = 'You are in plan mode. Call exit_plan_mode exactly once with the complete plan "# Mobile verification plan\n\n1. Continue after approval." Do not call another tool. After the user approves, reply with the single token LIVE_DSH_MOBILE_OK and stop.';

test.skip(process.env.DSH_REPO === undefined, 'The live DSH suite requires an explicitly configured DSH runtime.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(360_000);

test('drives live DSH messages, tools, approval, todo, and replay only through visible UI', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'The full live model path runs once on desktop.');
  const browserErrors = collectBrowserErrors(page);
  await openDshAgent(page);
  await expect(page.getByText('question available')).toBeVisible();
  await expect(page.getByText('plan approval available')).toBeVisible();
  await expect(page.getByText('tool approval available')).toBeVisible();
  await expect(page.getByText('resource read available')).toBeVisible();

  await submit(page, planPrompt);
  await expect(page.getByRole('heading', { name: 'Review proposed plan' })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole('heading', { name: 'Browser verification plan' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve and execute' }).click();
  await expect(page.locator('article.agent-tool').filter({ hasText: 'exit_plan_mode' }).filter({ hasText: 'Completed' })).toBeVisible({ timeout: 180_000 });
  await expectAssistant(page, 'LIVE_DSH_PLAN_CONTINUED');
  await expect(page.getByRole('heading', { name: 'Review proposed plan' })).toHaveCount(0);

  await submit(page, readPrompt);
  const readTool = page.locator('article.agent-tool').filter({ hasText: 'read' }).filter({ hasText: 'live-fixture.txt' });
  await expect(readTool.filter({ hasText: 'Completed' })).toBeVisible({ timeout: 180_000 });
  await expectAssistant(page, 'live-dsh-fixture-content');

  await submit(page, todoPrompt);
  const todo = page.locator('article.agent-todo').filter({ hasText: 'Inspect live fixture' });
  await expect(todo).toContainText('Report live result', { timeout: 180_000 });
  await expect(todo).toContainText('In progress');
  await expectAssistant(page, 'LIVE_DSH_TODO_DONE');

  await submit(page, generatedResourcePrompt);
  const writeTool = page.locator('article.agent-tool').filter({ hasText: 'write' }).filter({ hasText: 'generated-proof.txt' });
  await expect(writeTool.filter({ hasText: 'Completed' })).toBeVisible({ timeout: 180_000 });
  await expectAssistant(page, 'LIVE_DSH_RESOURCE_READY');
  const generatedResource = resourceRow(page, 'generated-proof.txt');
  await expect(generatedResource).toContainText('Available', { timeout: 30_000 });

  const approvalCommand = `printf approval-ok > ${testInfo.outputPath('approval-proof.txt')}`;
  const approvalPrompt = `Call bash to run this exact command without escalation first: ${approvalCommand}. When the workspace sandbox denies it, retry the exact same command with sandbox_permissions set to danger-full-access and justification set to "Write the requested Playwright proof artifact outside the Agent workspace." After I approve and the retry completes, reply with the single token LIVE_DSH_APPROVAL_DONE and stop.`;
  await submit(page, approvalPrompt);
  const approval = page.locator('.agent-tool-approval').filter({ hasText: 'bash' });
  await expect(approval).toBeVisible({ timeout: 180_000 });
  await approval.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.locator('article.agent-tool').filter({ hasText: 'bash' }).filter({ hasText: 'Completed' })).toBeVisible({ timeout: 180_000 });
  await expectAssistant(page, 'LIVE_DSH_APPROVAL_DONE');

  await page.getByTestId('playback-stop-reader').click();
  await expect(page.getByText('Provider resource reader stopped.')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('connection-status')).toHaveText('ready', { timeout: 30_000 });
  await loadAllHistory(page);
  await expect(page.getByRole('article', { name: 'Assistant message' }).filter({ hasText: 'LIVE_DSH_APPROVAL_DONE' })).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'Assistant message' }).filter({ hasText: 'LIVE_DSH_PLAN_CONTINUED' })).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: planPrompt })).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: readPrompt })).toHaveCount(1);
  await expect(page.locator('article.agent-error')).toHaveCount(0);
  const reloadedResource = resourceRow(page, 'generated-proof.txt');
  await expect(reloadedResource).toContainText('Available');
  await reloadedResource.getByRole('button', { name: 'Load resource' }).click();
  const downloadEvent = page.waitForEvent('download');
  await reloadedResource.getByRole('link', { name: 'Download resource' }).click();
  expect(await readFile(await (await downloadEvent).path() as string, 'utf8')).toBe('DSH_GENERATED_RESOURCE\n');
  await expect(page.getByTestId('session-status')).not.toHaveText('failed');
  expect(browserErrors.console).toEqual([]);
  expect(browserErrors.page).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('live-dsh-visible.png'), fullPage: true });
});

test('keeps the live DSH create, message, and reattach path usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile', 'The mobile smoke runs only in the mobile project.');
  const browserErrors = collectBrowserErrors(page);
  await openDshAgent(page);
  await submit(page, mobilePlanPrompt);
  await expect(page.getByRole('heading', { name: 'Review proposed plan' })).toBeVisible({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Approve and execute' }).click();
  await expectAssistant(page, 'LIVE_DSH_MOBILE_OK');
  await page.reload();
  await expect(page.getByTestId('connection-status')).toHaveText('ready', { timeout: 30_000 });
  await loadAllHistory(page);
  await expectAssistant(page, 'LIVE_DSH_MOBILE_OK');
  await expect(page.locator('article.agent-error')).toHaveCount(0);
  expect(browserErrors.console).toEqual([]);
  expect(browserErrors.page).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('live-dsh-mobile-visible.png'), fullPage: true });
});

async function openDshAgent(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agent conversations' })).toBeVisible();
  await expect(page.getByTestId('provider-select').locator('option')).toHaveText(['DeepSeek Harness', 'Codex (fixture)']);
  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption({ label: 'DeepSeek Harness' });
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expect(page.getByTestId('connection-status')).toHaveText('ready', { timeout: 30_000 });
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
  await expect(page.getByText('send message available')).toBeVisible();
  await expect(page.getByTestId('session-status')).not.toHaveText('failed');
}

function resourceRow(page: Page, locator: string) {
  return page.locator('.agent-resources li').filter({ hasText: locator });
}

async function submit(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(prompt);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByText('Message sent through the Relay.')).toBeVisible();
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: prompt.split('\n')[0] })).toBeVisible({ timeout: 30_000 });
}

async function expectAssistant(page: Page, text: string): Promise<void> {
  const messageBodies = page.getByRole('article', { name: 'Assistant message' }).locator('.agent-markdown');
  await expect.poll(async () => (await messageBodies.allTextContents()).join(''), { timeout: 180_000 }).toContain(text);
  await expect(page.getByTestId('session-status')).toHaveText('idle', { timeout: 30_000 });
}

async function loadAllHistory(page: Page): Promise<void> {
  const loadOlder = page.getByRole('button', { name: 'Load earlier activity' });
  for (let pageIndex = 0; pageIndex < 100 && await loadOlder.isVisible(); pageIndex += 1) {
    try {
      await loadOlder.click({ timeout: 10_000 });
    } catch (error) {
      if (await loadOlder.count() > 0) throw error;
    }
  }
  await expect(loadOlder).toHaveCount(0);
}

function collectBrowserErrors(page: Page): { console: string[]; page: string[] } {
  const errors = { console: [] as string[], page: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') errors.console.push(message.text()); });
  page.on('pageerror', (error) => errors.page.push(error.message));
  return errors;
}
