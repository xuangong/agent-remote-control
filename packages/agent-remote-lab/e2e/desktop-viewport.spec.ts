import { expect, test } from '@playwright/test';
import { toggleViewPanel } from './view-options';

test('long sidebar content never scrolls the desktop workspace away from the viewport', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop sidebar scrolling');
  await page.setViewportSize({ width: 2048, height: 920 });
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: Array.from({ length: 18 }, (_, index) => ({
    hostId: 'host', providerId: 'recorded', nativeSessionId: `favorite-${index}`, title: `Saved conversation ${index}`,
    starredAt: 1, hostName: 'Work Mac', available: true, online: true,
  })) } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html');
  const sidebar = page.locator('.lab-sidebar-content');
  await expect(sidebar.locator('.lab-favorite-list > li')).toHaveCount(18);
  const discovery = sidebar.getByRole('region', { name: 'Discover sessions' });
  await expect(discovery.locator('.lab-session-row')).toHaveCount(1);
  for (const size of [{ width: 2048, height: 920 }, { width: 1440, height: 700 }, { width: 1181, height: 800 }]) {
    await page.setViewportSize(size);
    for (const showHeader of [false, true]) {
      if (showHeader) await toggleViewPanel(page, 'Header');
      await sidebar.evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => page.evaluate(() => ({
        scrollY, overflow: document.documentElement.scrollHeight - innerHeight,
        top: document.querySelector('.lab-shell')!.getBoundingClientRect().top,
        bottom: document.querySelector('.lab-composer-dock')!.getBoundingClientRect().bottom - innerHeight,
      }))).toEqual({ scrollY: 0, overflow: 0, top: 0, bottom: 0 });
      await discovery.getByRole('button', { name: 'Refresh', exact: true }).focus();
      await expect(discovery.getByRole('button', { name: 'Refresh', exact: true })).toBeInViewport();
      expect(await sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await page.getByTestId('prompt-input').focus();
      expect(await page.evaluate(() => scrollY)).toBe(0);
      if (showHeader) await toggleViewPanel(page, 'Header');
    }
  }
  await page.screenshot({ path: info.outputPath('desktop-viewport.png') });
});
