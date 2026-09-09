import { expect, test, type Page } from '@playwright/test';

const prompt = 'Ask me to confirm the shared Agent Remote path, then continue after my answer.';
const completion = 'CODEX_BROWSER_CONTINUATION_OK';

test.skip(process.env.BORGEE_CODEX_TEST_EXECUTABLE === undefined, 'The real Codex app-server executable was not selected.');
test.setTimeout(180_000);

test('answers a Codex question and renders consecutive turns through the visible UI', async ({ page }, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agent conversations' })).toBeVisible();
  await page.getByTestId('provider-select').selectOption({ label: 'Codex (fixture)' });
  await page.getByTestId('session-create').click();
  await expectReady(page);

  await page.getByTestId('prompt-input').fill(prompt);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: prompt })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent questions' })).toBeVisible({ timeout: 60_000 });
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
  await page.getByRole('button', { name: 'Load earlier activity' }).click();
  await expect.poll(() => assistantOccurrenceCount(page, completion), { timeout: 30_000 }).toBe(3);
  await page.getByRole('button', { name: 'Load earlier activity' }).click();
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: prompt })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Load earlier activity' })).toHaveCount(0);
  expect(await assistantOccurrenceCount(page, completion)).toBe(3);
  await expectIdle(page);
  expect(browserErrors.console).toEqual([]);
  expect(browserErrors.page).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('codex-visible.png'), fullPage: true });
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
