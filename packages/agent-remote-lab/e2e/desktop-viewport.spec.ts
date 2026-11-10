import { expect, test } from '@playwright/test';
import { toggleViewPanel } from './view-options';
import { openSessionsPage } from './all-sessions';

// The long session lists live on the All sessions page, which takes the Window's place in the main area.
test('long sessions page content never scrolls the desktop workspace away from the viewport', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Desktop sidebar scrolling');
  await page.setViewportSize({ width: 2048, height: 920 });
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  // Favorites have their own page now, so the long content is the fixture's 24 discovered sessions.
  await page.goto('/e2e/fixtures/session-stars.html?sidebar');
  const sessions = await openSessionsPage(page);
  const scroller = sessions.locator('.lab-sessions-page-body');
  const discovery = sessions.getByRole('region', { name: 'Discover sessions' });
  await expect(discovery.locator('.lab-session-row')).toHaveCount(24);
  const fitsViewport = (bottomOf: string) => page.evaluate(bottomOf => ({
    scrollY, overflow: document.documentElement.scrollHeight - innerHeight,
    top: document.querySelector('.lab-shell')!.getBoundingClientRect().top,
    bottom: document.querySelector(bottomOf)!.getBoundingClientRect().bottom - innerHeight,
  }), bottomOf);
  for (const size of [{ width: 2048, height: 920 }, { width: 1440, height: 700 }, { width: 1181, height: 800 }]) {
    await page.setViewportSize(size);
    for (const showHeader of [false, true]) {
      if (showHeader) await toggleViewPanel(page, 'Header');
      await scroller.evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => fitsViewport('#lab-sessions-page')).toEqual({ scrollY: 0, overflow: 0, top: 0, bottom: 0 });
      await discovery.locator('.lab-session-row').last().focus();
      await expect(discovery.locator('.lab-session-row').last()).toBeInViewport();
      expect(await scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await sessions.getByRole('button', { name: 'Back to Window', exact: true }).click();
      await expect.poll(() => fitsViewport('.lab-composer-dock')).toEqual({ scrollY: 0, overflow: 0, top: 0, bottom: 0 });
      await page.getByTestId('prompt-input').focus();
      expect(await page.evaluate(() => scrollY)).toBe(0);
      if (showHeader) await toggleViewPanel(page, 'Header');
      await openSessionsPage(page);
    }
  }
  await page.screenshot({ path: info.outputPath('desktop-viewport.png') });
});
