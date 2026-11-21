// Component projects: webkit-mobile-viewport
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openSettingsPage } from '../all-sessions';

test('records shell movement from Settings and exports a private, selectable report', async ({ page }, info) => {
  test.skip(!info.project.use.isMobile);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), {
      width: 390, height: 844, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
    }) });
  });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
  // Settings > Advanced, from the Me tab; the tab bar leads back to the Window.
  const settings = await openSettingsPage(page, 'Advanced');
  const toggle = settings.getByRole('switch', { name: 'Record layout changes' });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('[data-layout-safe-area-probe]')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.locator('.lab-tab-bar').getByRole('button', { name: 'Windows', exact: true }).click();
  const prompt = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
  await prompt.tap();
  await prompt.tap();
  await page.evaluate(() => {
    const privateText = document.createElement('span');
    privateText.textContent = 'PRIVATE SESSION TITLE';
    privateText.hidden = true;
    document.querySelector('.lab-mobile-navigation')!.append(privateText);
    Object.assign(window.visualViewport!, { height: 400, offsetTop: 44, pageTop: 44 });
    window.dispatchEvent(new Event('orientationchange'));
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.lab-shell')).toHaveCSS('top', '44px');
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 844, offsetTop: 0, pageTop: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.lab-shell')).toHaveCSS('top', '0px');
  await openSettingsPage(page, 'Advanced');
  await expect(toggle).toBeChecked();
  await settings.getByRole('button', { name: 'Copy report', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  const output = settings.getByRole('textbox', { name: 'Report text' });
  await expect(output).toBeVisible();
  const text = await output.inputValue();
  const report = JSON.parse(text);
  expect(report.environment.standalone).toBe(true);
  expect(report.environment.viewportMeta).toBe(await page.locator('meta[name="viewport"]').getAttribute('content'));
  expect(text).not.toContain('PRIVATE SESSION TITLE');
  expect(text).not.toContain('recorded-session');
  expect(text).not.toContain('session-stars.html');
  let previous = {};
  const samples = report.samples.map((sample: Record<string, unknown>) => previous = { ...previous, ...sample });
  expect(samples.some((sample: any) => sample.reason === 'pointerdown' && typeof sample.interaction?.target?.pane === 'number')).toBe(true);
  expect(samples.some((sample: any) => sample.reason === 'viewport-before' && sample.decision.occluded && sample.shellStyle.top === '0px')).toBe(true);
  expect(samples.some((sample: any) => sample.reason === 'viewport-after' && sample.shell.y === 44 && sample.shellStyle.top === '44px')).toBe(true);
  await output.focus();
  expect(await output.evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart)).toBe(text.length);
  const downloadPromise = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadPromise;
  expect(JSON.parse(await readFile((await download.path())!, 'utf8')).samples).toEqual(report.samples);
  expect(await settings.locator('.lab-settings-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('layout-diagnostics.png') });
  await settings.getByRole('button', { name: 'Clear report', exact: true }).click();
  await expect(output).toHaveCount(0);
  await expect(page.locator('[data-layout-safe-area-probe]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-layout-safe-area-probe]')).toHaveCount(0);
});
