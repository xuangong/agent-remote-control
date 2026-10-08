import { expect, test } from '@playwright/test';

const colors = {
  running: 'rgb(35, 112, 73)',
  waiting: 'oklch(0.52 0.108 87)',
  idle: 'oklch(0.243 0.024 248.8)',
  closed: 'oklch(0.485 0.029 246.6)',
};

test('session titles track work, pending input, idle and closed across surfaces', async ({ page, isMobile }, testInfo) => {
  await page.goto('/e2e/fixtures/session-title-status.html');
  const collapsedTitle = page.getByRole('navigation', { name: 'Earlier windows', includeHidden: true }).locator('.lab-collapsed-title');
  const titles = [
    page.getByRole('heading', { name: 'Conversation', exact: true }),
    page.getByRole('region', { name: 'Chat sessions' }).locator('.lab-session-row strong'),
    page.getByRole('region', { name: 'Discover sessions' }).locator('.lab-session-row strong'),
  ];
  if (isMobile) await expect(collapsedTitle).toBeHidden();
  else titles.push(collapsedTitle);
  for (const mode of ['running', 'pending', 'running', 'idle', 'closed'] as const) {
    await page.getByRole('navigation', { name: 'Fixture state' }).getByRole('button', { name: mode, exact: true }).click();
    await page.locator('.lab-chat-sessions-heading').click();
    const expected = mode === 'pending' ? 'waiting' : mode;
    for (const title of titles) {
      await expect(title).toBeVisible();
      await expect(title).toHaveAttribute('data-session-status', expected);
      await expect(title).toHaveCSS('color', colors[expected]);
    }
    await expect(page.locator('.lab-session-indicator')).toHaveCSS('background-color', colors[expected]);
    if (mode === 'pending') await expect(page.locator('.lab-conversation-status')).toHaveText('Waiting for response');
  }
  for (const status of ['running', 'waiting', 'idle', 'closed'] as const) {
    await expect(page.locator(`[data-child-session-id="${status}"] .agent-session-title`)).toHaveCSS('color', colors[status]);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('session-title-colors.png'), fullPage: true });
});
