import { expect, test } from '@playwright/test';

test('native commands fit the viewport and remain accessible in the session dialog', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/native-session-commands.html');
  await page.getByText('Restart daemon to recover…', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy restart command' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Share session link' }).click();
  const dialog = page.getByRole('dialog');
  const command = dialog.getByLabel('Terminal command');
  await command.scrollIntoViewIfNeeded();
  await expect(command).toHaveValue('agent-remote-controller codex resume 01a0ba06-321d-7600-9141-a1ad0779fc9f');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await command.focus();
  expect(await command.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe((await command.inputValue()).length);
  await page.screenshot({ path: testInfo.outputPath('native-resume.png') });
  await page.getByRole('button', { name: 'Close session link' }).click();
  await expect(page.getByRole('button', { name: 'Share session link' })).toBeFocused();
});
