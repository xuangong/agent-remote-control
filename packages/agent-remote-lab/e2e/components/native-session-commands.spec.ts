import { expect, test } from '@playwright/test';
import { englishWords } from './english-words.js';

test('native commands fit the viewport and remain accessible in the session dialog', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/native-session-commands.html');
  await page.getByText('Restart daemon to recover…', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy restart command' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Share session link' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('summary', { hasText: 'Open on Host' }).click();
  const command = dialog.getByLabel('Terminal command');
  await command.scrollIntoViewIfNeeded();
  await expect(command).toHaveValue("cd '/Users/developer/Projects/agent-remote-control/packages/agent-remote-lab' && agent-remote-controller session attach host/codex/01a0ba06-321d-7600-9141-a1ad0779fc9f");
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await command.focus();
  expect(await command.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe((await command.inputValue()).length);
  await page.screenshot({ path: testInfo.outputPath('native-resume.png') });
  await page.getByRole('button', { name: 'Close session link' }).click();
  await expect(page.getByRole('button', { name: 'Share session link' })).toBeFocused();
});

test.describe('in Chinese', () => {
  test.use({ locale: 'zh-CN' });

  test('the native commands and the session link dialog have no English words left', async ({ page }) => {
    await page.goto('/e2e/fixtures/native-session-commands.html');
    await page.getByText('重启守护进程来恢复…', { exact: true }).click();
    await expect(page.getByRole('button', { name: '复制重启命令' })).toBeVisible();
    await page.getByRole('button', { name: '分享会话链接' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('summary', { hasText: '在 Host 上打开' }).click();
    await expect(dialog.getByLabel('终端命令')).toBeVisible();
    // The fixture's own sample data: a session titled "Session" of the codex provider, and a failure detail.
    expect(await englishWords(page, { allow: ['Session', 'codex', 'file', 'limit'] })).toEqual([]);
  });
});
