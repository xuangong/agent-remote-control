import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-17T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-17T00:00:01Z'));
  await page.goto('/e2e/fixtures/message-delivery.html');
});

test('shows a pulsing outgoing message immediately and replaces it with the native echo', async ({ page }, testInfo) => {
  await page.getByTestId('prompt-input').fill('Please check the result.');
  await page.getByTestId('prompt-submit').click();
  const row = page.locator('.agent-outgoing-message');
  await expect(row).toContainText('Please check the result.');
  await expect(row).toContainText('Sending…');
  await expect(page.locator('.agent-message-user')).toHaveCount(1);
  expect(await row.locator('.agent-message').evaluate(element => getComputedStyle(element).animationName)).toBe('agent-message-pending');
  await page.screenshot({ path: testInfo.outputPath('message-pending.png') });
  await page.getByRole('button', { name: 'Acknowledge send' }).click();
  await expect(row).toContainText('Sent — waiting for conversation…');
  await expect(page.getByTestId('prompt-input')).toHaveValue('');
  await page.getByRole('button', { name: 'Deliver message' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.agent-message-user')).toHaveCount(1);
  await expect(page.locator('.agent-message-user')).toContainText('Please check the result.');
});

test('stops pulsing on timeout, shows red failure for ten seconds, and accepts a later echo', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('prompt-input').fill('A message without confirmation.');
  await page.getByTestId('prompt-submit').click();
  const row = page.locator('.agent-outgoing-message');
  expect(await row.locator('.agent-message').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Acknowledge send' }).click();
  await page.clock.fastForward(30_000);
  await page.clock.runFor(100);
  await expect(row).toHaveAttribute('data-delivery-state', 'failed');
  await expect(row.getByRole('alert')).toContainText('Send failed');
  await expect(page.getByText('Message sent.', { exact: true })).toHaveCount(0);
  expect(await row.locator('.agent-message').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  const colors = await row.locator('.agent-message-delivery').evaluate(element => {
    const probe = document.createElement('span'); probe.style.color = 'var(--agent-danger)'; element.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove(); return { actual: getComputedStyle(element).color, expected };
  });
  await expect(row.locator('.agent-message-delivery')).toHaveCSS('color', colors.expected);
  await page.screenshot({ path: testInfo.outputPath('message-failed.png') });
  await page.clock.fastForward(9_899);
  await expect(row).toHaveCount(1);
  await page.clock.fastForward(1);
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Deliver message' }).click();
  await expect(page.locator('.agent-message-user')).toHaveCount(1);
});
