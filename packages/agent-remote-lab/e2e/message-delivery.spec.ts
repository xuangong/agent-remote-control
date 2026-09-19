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

test('waits through compaction delays before acknowledgement and echo without showing a false delivery error', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('prompt-input').fill('Continue after compaction.');
  await page.getByTestId('prompt-submit').click();
  const row = page.locator('.agent-outgoing-message');
  await page.clock.fastForward(60_000);
  await expect(row).toContainText('Sending…');
  await expect(row).toHaveAttribute('data-delivery-state', 'pending');
  await expect(page.getByTestId('prompt-input')).toHaveValue('Continue after compaction.');
  await expect(page.getByTestId('prompt-submit')).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delivery error' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Acknowledge send' }).click();
  await page.clock.fastForward(120_000);
  await expect(row).toContainText('Sent — waiting for conversation…');
  await expect(page.getByTestId('prompt-input')).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delivery error' })).toHaveCount(0);
  expect(await row.locator('.agent-message').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('slow-message-awaiting-echo.png') });
  await page.getByRole('button', { name: 'Deliver message' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.agent-message-user')).toHaveCount(1);
});

test('uses neutral delivery wording when the connection drops before acknowledgement', async ({ page }) => {
  await page.getByTestId('prompt-input').fill('A message whose acknowledgement is unknown.');
  await page.getByTestId('prompt-submit').click();
  const row = page.locator('.agent-outgoing-message');

  await page.getByRole('button', { name: 'Disconnect before acknowledgement' }).click();

  await expect(row).toHaveAttribute('data-delivery-state', 'unconfirmed');
  await expect(row.getByRole('alert')).toContainText('Delivery not confirmed');
  await page.clock.fastForward(120_000);
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText('Send acknowledged');
  await expect(row).not.toContainText('Send failed');
});
