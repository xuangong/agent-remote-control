import { expect, test } from '@playwright/test';

// The composer offers the account's bots after @, and what a bot answered shows in the conversation as one quiet line that opens.
// Chromium desktop and the phone project run it.
const asked = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { asked: Array<[string, string]> }).asked);

test('offers the bots after @, chooses one by keyboard, and asks it instead of writing to the session', async ({ page }) => {
  await page.goto('/e2e/fixtures/mention-answer.html');
  const input = page.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.click();
  await input.pressSequentially('@');
  const picker = page.locator('[data-mention-picker]');
  const options = picker.getByRole('option');
  await expect(options).toHaveText(['@Reviewer', '@Release Manager']);
  // The picker sits inside the viewport and does not make the page scroll sideways.
  const box = (await picker.boundingBox())!, viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await input.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(picker).toHaveCount(0);
  await input.pressSequentially('Who signs off?');
  await page.getByTestId('prompt-submit').click();
  await expect.poll(() => asked(page)).toEqual([['Release Manager', 'Who signs off?']]);
  await expect(input).toHaveText('');
});

test('chooses a bot with the pointer, and Escape closes the picker', async ({ page, isMobile }) => {
  await page.goto('/e2e/fixtures/mention-answer.html');
  const input = page.getByTestId('prompt-input');
  await input.click();
  await input.pressSequentially('@rev');
  const option = page.locator('[data-mention-picker]').getByRole('option', { name: '@Reviewer' });
  if (isMobile) await option.tap(); else await option.click();
  await expect.poll(() => input.evaluate((element: HTMLElement) => element.innerText.trim())).toBe('@Reviewer');
  await input.fill('');
  await input.pressSequentially('@');
  await expect(page.locator('[data-mention-picker]')).toBeVisible();
  await input.press('Escape');
  await expect(page.locator('[data-mention-picker]')).toHaveCount(0);
});

test('shows an answered ask and one still being answered as quiet lines after the turn, and opens the answer', async ({ page }) => {
  await page.goto('/e2e/fixtures/mention-answer.html');
  const lines = page.locator('[data-ask-id]');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0).locator('summary')).toHaveText('Reviewer answered');
  await expect(lines.nth(1).locator('summary')).toHaveText('Release Manager is answering');
  await expect(lines.nth(0)).not.toHaveAttribute('open', '');
  await lines.nth(0).locator('summary').click();
  await expect(lines.nth(0)).toContainText('Is the third fix safe to ship on Friday?');
  await expect(lines.nth(0)).toContainText('Ship it, and watch the first hour of retries.');
  const line = (await lines.nth(0).boundingBox())!, viewport = page.viewportSize()!;
  expect(line.x + line.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // The lines follow the turn they came after.
  const before = await page.getByText('The notes cover three fixes and one new command.').boundingBox();
  expect(line.y).toBeGreaterThan(before!.y);
});
