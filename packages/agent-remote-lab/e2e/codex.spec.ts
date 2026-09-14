import { showNewSession } from './session-navigation';
import { expect, test, type Page } from '@playwright/test';

const prompt = 'Ask me to confirm the shared Agent Remote path, then continue after my answer.';
const completion = 'CODEX_BROWSER_CONTINUATION_OK';

test.skip(process.env.BORGEE_CODEX_TEST_EXECUTABLE === undefined, 'The real Codex app-server executable was not selected.');
test.setTimeout(180_000);

test('discovers native commands and continues model and permission menus through Provider interactions', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await page.goto('/');
  await selectCodexHost(page);
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expectReady(page);
  const input = page.getByTestId('prompt-input');
  await input.fill('/');
  await expect(page.getByRole('option').filter({ hasText: '/remote-fixture-skill' })).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: '/prompts:remote-fixture-prompt' })).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: '/compact' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('native-command-directory.png'), fullPage: true });
  await page.getByRole('option').filter({ hasText: /^\/model/ }).click();
  await expect(page.getByText('Choose model', { exact: true })).toBeVisible();
  await page.reload();
  await expectReady(page);
  await expect(page.getByText('Choose model', { exact: true })).toBeVisible();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit response' }).click();
  await expect(page.getByText('Choose reasoning effort', { exact: true })).toBeVisible();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit response' }).click();
  await expect(page.getByRole('heading', { name: 'Agent questions' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Planning mode' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Close session controls' }).click();
  await input.fill('/permissions');
  await expect(page.getByRole('option').filter({ hasText: /^\/permissions/ })).toBeVisible();
  await input.press('Enter');
  await page.getByRole('radio', { name: /Approval policy/ }).check();
  await page.getByRole('button', { name: 'Submit response' }).click();
  await expect(page.getByText('Choose approval policy', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /^On request/ }).check();
  await page.getByRole('button', { name: 'Submit response' }).click();
  await expect(page.getByTestId('session-permissions-button')).toContainText('On request');
  await expect(page.getByRole('heading', { name: 'Agent questions' })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'User message' })).toHaveCount(0);
  expect(errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
});

test('selects native models and permissions from the toolbar and restores confirmed settings', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await page.goto('/');
  await selectCodexHost(page);
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expectReady(page);
  const input = page.getByTestId('prompt-input');
  await page.getByTestId('session-permissions-button').click();
  await expect(page.getByTestId('session-setting-sandbox')).toBeEnabled();
  await expect(page.getByTestId('session-setting-sandbox')).toHaveValue('readOnly');
  await page.getByTestId('session-model-button').click();
  const model = page.getByTestId('session-setting-model');
  await expect(model).toBeEnabled();
  const choices = await model.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const selectedModel = choices.find((value) => value !== 'mock-model' && value !== '')!;
  expect(selectedModel).toBeTruthy();
  await model.selectOption(selectedModel);
  await expect(model).toHaveValue(selectedModel, { timeout: 20_000 });
  await expect(model).toBeEnabled();
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Planning mode' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Close session controls' }).click();
  await page.getByTestId('session-permissions-button').click();
  const approval = page.getByTestId('session-setting-approval');
  const sandbox = page.getByTestId('session-setting-sandbox');
  await expect(approval).toBeEnabled();
  await approval.selectOption('on-request');
  await expect(approval).toHaveValue('on-request', { timeout: 20_000 });
  await expect(sandbox).toBeEnabled();
  await sandbox.selectOption('workspaceWrite');
  await expect(sandbox).toHaveValue('workspaceWrite', { timeout: 20_000 });
  await expect(sandbox).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('native-session-settings.png'), fullPage: true });
  await page.reload();
  await expectReady(page);
  await page.getByTestId('session-permissions-button').click();
  await expect(approval).toHaveValue('on-request');
  await expect(sandbox).toHaveValue('workspaceWrite');
  await page.getByTestId('session-model-button').click();
  await expect(model).toHaveValue(selectedModel);
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Session status', exact: true })).toContainText('Connected');
  await expect(page.getByRole('article', { name: 'User message' })).toHaveCount(0);
  expect(errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
});

test('sends immediate input to a working native turn, restores elapsed time and interrupts', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await page.goto('/');
  await selectCodexHost(page);
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expectReady(page);
  await sendMessage(page, 'Hold this native turn for an interrupt.');
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Working');
  const elapsed = page.getByTestId('turn-elapsed');
  await expect(elapsed).toHaveText(/^[2-9]\d*s$/, { timeout: 10_000 });
  const before = Number((await elapsed.getAttribute('datetime'))?.match(/\d+/)?.[0]);
  await page.reload();
  await expectReady(page);
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Working');
  await expect.poll(async () => Number((await elapsed.getAttribute('datetime'))?.match(/\d+/)?.[0])).toBeGreaterThanOrEqual(before);
  await expect(page.getByTestId('queue-submit')).toHaveCount(0);
  await expect(page.getByTestId('steer-submit')).toHaveCount(0);
  await page.getByTestId('prompt-input').fill('Use a smaller example in this turn.');
  await page.getByTestId('prompt-input').press('Enter');
  await expect(page.getByTestId('prompt-input')).toHaveValue('');
  await expect(page.getByText('Message sent.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Working');
  await expect.poll(async () => Number((await elapsed.getAttribute('datetime'))?.match(/\d+/)?.[0])).toBeGreaterThanOrEqual(before);
  await page.getByTestId('prompt-input').fill('Keep this unsent draft.');
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();
  const interrupt = page.getByRole('button', { name: 'Interrupt', exact: true });
  await expect(interrupt).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('native-turn-working.png'), fullPage: true });
  await interrupt.click();
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Ready', { timeout: 30_000 });
  await expect(elapsed).toHaveCount(0);
  await expect(page.getByTestId('cancel-submit')).toBeDisabled();
  await expect(page.getByTestId('prompt-input')).toHaveValue('Keep this unsent draft.');
  expect(errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
});

for (const planning of [false, true]) test(`answers a Codex question in ${planning ? 'Plan' : 'Default'} and renders consecutive turns`, async ({ page }, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');
  await selectCodexHost(page);
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expectReady(page);

  await page.getByRole('button', { name: 'Status', exact: true }).click();
  const planningSwitch = page.getByRole('switch', { name: 'Planning mode' });
  await expect(planningSwitch).not.toBeChecked();
  if (planning) {
    await planningSwitch.click();
    await expect(planningSwitch).toBeChecked();
  }
  await page.getByRole('button', { name: 'Close session controls' }).click();

  await page.getByTestId('prompt-input').fill(prompt);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: prompt })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent questions' })).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath('codex-question.png'), fullPage: true });
  await page.getByLabel('Yes (Recommended)').check();
  await page.getByRole('button', { name: 'Submit response' }).click();
  await expectAssistantTranscript(page, completion);
  await expectIdle(page);

  await sendMessage(page, 'First message after the interaction.');
  await expect.poll(() => assistantOccurrenceCount(page, completion), { timeout: 60_000 }).toBe(2);
  await expectIdle(page);

  await sendMessage(page, 'Second message after the interaction.');
  await expect.poll(() => assistantOccurrenceCount(page, completion), { timeout: 60_000 }).toBe(3);
  await expectIdle(page);

  await page.reload();
  await expectReady(page);
  await expect(page.getByRole('article', { name: 'User message' })
    .filter({ hasText: 'Second message after the interaction.' })).toBeVisible();
  await expect.poll(() => assistantOccurrenceCount(page, completion), { timeout: 30_000 }).toBe(3);
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: prompt })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Load earlier activity' })).toHaveCount(0);
  expect(await assistantOccurrenceCount(page, completion)).toBe(3);
  await expectIdle(page);
  expect(browserErrors.console).toEqual([]);
  expect(browserErrors.page).toEqual([]);
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(planningSwitch).toBeChecked({ checked: planning });
  await page.getByRole('button', { name: 'Close session controls' }).click();
  await page.screenshot({ path: testInfo.outputPath('codex-visible.png'), fullPage: true });
});

test('cancels a Default question after reconnect and accepts a follow-up message', async ({ page }) => {
  await page.goto('/');
  await selectCodexHost(page);
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expectReady(page);
  await sendMessage(page, prompt);
  await expect(page.getByRole('heading', { name: 'Agent questions' })).toBeVisible();
  await page.reload();
  await expectReady(page);
  await expect(page.getByRole('heading', { name: 'Agent questions' })).toBeVisible();
  await page.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent questions' })).toHaveCount(0);
  await expectIdle(page);
  await sendMessage(page, 'Hold this native turn for an interrupt.');
  await expect(page.getByTestId('agent-activity-label')).toHaveText('Working');
  await page.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expectIdle(page);
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Planning mode' })).not.toBeChecked();
});

async function expectReady(page: Page): Promise<void> {
  await expect(page.getByTestId('connection-summary')).toContainText('Ready', { timeout: 30_000 });
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
}

async function expectIdle(page: Page): Promise<void> {
  await expectReady(page);
  await expect(page.getByTestId('cancel-submit')).toBeDisabled({ timeout: 30_000 });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(text);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: text })).toBeVisible();
}

async function expectAssistantTranscript(page: Page, text: string): Promise<void> {
  await expect.poll(async () => (await assistantMessages(page).allTextContents()).join(''), { timeout: 60_000 }).toContain(text);
}

async function assistantOccurrenceCount(page: Page, text: string): Promise<number> {
  const transcript = (await assistantMessages(page).allTextContents()).join('');
  return transcript.split(text).length - 1;
}

function assistantMessages(page: Page) {
  return page.getByRole('article', { name: 'Assistant message' });
}

function collectBrowserErrors(page: Page): { console: string[]; page: string[] } {
  const errors = { console: [] as string[], page: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') errors.console.push(message.text()); });
  page.on('pageerror', (error) => errors.page.push(error.message));
  return errors;
}

async function selectCodexHost(page: Page): Promise<void> {
  const provider = page.getByTestId('provider-select');
  await expect(provider.getByRole('option', { name: 'Codex (fixture) · Deterministic Codex Host · Online' })).toHaveCount(1);
  await provider.selectOption({ label: 'Codex (fixture) · Deterministic Codex Host · Online' });
}
