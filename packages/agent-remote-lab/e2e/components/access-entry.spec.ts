// Component projects: webkit-desktop
import { expect, test, type Page } from '@playwright/test';
import { contrastFailures } from './contrast';

// The Workbench root in gateway mode, as the Relay serves it, before anyone is signed in: the page asks the Relay's /auth/status.
const entry = '/e2e/fixtures/access-entry.html';
const sessionLink = '?host=desk&provider=codex&session=native';
const answer = (page: Page, status: number) => page.route('**/auth/status', route => route.fulfill({ status, json: {} }));

test('a check that has not answered paints no text, then asks to sign in with the focus on the heading', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/status', async route => { await gate; await route.fulfill({ status: 401, json: {} }); });
  await page.goto(entry);
  const status = page.getByRole('status');
  // A wait before the Relay answers paints no words at all: the ground of the page, announced to assistive technology only.
  await expect(status).toHaveAttribute('aria-label', 'Opening Orchard…');
  await expect(status).toHaveText('');
  await expect(page.locator('.arc-access-mark')).toHaveCount(0);
  expect(await page.getByRole('heading').count()).toBe(0);
  release();
  await expect(page.getByRole('heading', { name: 'Sign in to Orchard' })).toBeFocused();
});

for (const locale of ['en', 'zh-CN'] as const) for (const colorScheme of ['light', 'dark'] as const) {
  test(`the sign-in and unavailable cards of a session link are readable and reachable in ${locale}, ${colorScheme}`, async ({ browser }) => {
    const words = locale === 'en'
      ? { signIn: 'Sign in to continue', link: 'Sign in', unavailable: 'Can’t reach Orchard right now', retry: 'Try again' }
      : { signIn: '登录后继续', link: '登录', unavailable: '暂时连不上 Orchard', retry: '再试一次' };
    const context = await browser.newContext({ locale, colorScheme, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await answer(page, 503);
      await page.goto(entry + sessionLink);
      await expect(page.getByRole('heading', { name: words.unavailable })).toBeFocused();
      expect(await contrastFailures(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.unroute('**/auth/status');
      await answer(page, 401);
      await page.getByRole('button', { name: words.retry, exact: true }).click();
      await expect(page.getByRole('heading', { name: words.signIn })).toBeFocused();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const signIn = page.getByRole('link', { name: words.link, exact: true });
      await expect(signIn).toHaveAttribute('href', '/auth/login' + sessionLink);
      expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      expect(await contrastFailures(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.close(); }
  });
}
