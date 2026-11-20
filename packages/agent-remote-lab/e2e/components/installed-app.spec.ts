import { expect, test, type Page } from '@playwright/test';
import { coveringControls } from './covering';

// The page added to the home screen (I4, Task 9), in iOS WebKit emulation: it opens standalone as Orchard, the browser's chrome and
// the ground take the chosen theme's ground from the tokens, and the conversation and its composer stay inside the viewport.
const GROUND = { light: '#f3efe9', dark: '#151517' } as const;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;

/** The page as an installed app: `navigator.standalone`, and the device's stored appearance before the first paint. */
async function installed(page: Page, appearance?: 'light' | 'dark') {
  await page.addInitScript(stored => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    if (stored) localStorage.setItem('agent-remote:appearance', stored); else localStorage.removeItem('agent-remote:appearance');
  }, appearance);
}

const chrome = (page: Page) => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(meta => [meta.getAttribute('media'), meta.getAttribute('content')]));

test('opens standalone as Orchard, with the light ground as its launch colour', async ({ page, request }) => {
  await installed(page);
  await page.goto('/');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Orchard');
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/app/icon-192.png');
  const manifest = await (await request.get('/app/manifest.webmanifest')).json() as Record<string, unknown>;
  expect(manifest).toMatchObject({ name: 'Orchard', short_name: 'Orchard', display: 'standalone', start_url: '/', scope: '/', background_color: GROUND.light, theme_color: GROUND.light });
});

for (const [appearance, scheme, light, dark] of [
  [undefined, 'light', GROUND.light, GROUND.dark], [undefined, 'dark', GROUND.light, GROUND.dark],
  ['light', 'dark', GROUND.light, GROUND.light], ['dark', 'light', GROUND.dark, GROUND.dark],
] as const) test(`follows the ${appearance ?? 'system'} appearance on a ${scheme} system: chrome and ground`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: scheme });
  await installed(page, appearance);
  // The app's own page: its entry binds the stored appearance before the first render.
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await chrome(page)).toEqual([['(prefers-color-scheme: light)', light], ['(prefers-color-scheme: dark)', dark]]);
  const shown = appearance ?? scheme;
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(rgb(GROUND[shown]));
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(rgb(GROUND[shown]));
});

test('keeps the conversation and the composer inside the viewport, with the keyboard up too', async ({ page }, info) => {
  await installed(page);
  await page.goto('/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief&pending=none');
  const capsule = page.locator('.agent-composer-capsule').first();
  await expect(capsule).toBeVisible();
  const viewport = page.viewportSize()!;
  const inside = async (height: number) => { const box = (await capsule.boundingBox())!; return box.y >= 0 && box.y + box.height <= height + 0.5 && box.x >= 0 && box.x + box.width <= viewport.width + 0.5; };
  expect(await inside(viewport.height)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await coveringControls(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath('installed-conversation.png') });
  await capsule.getByTestId('prompt-input').click();
  await page.setViewportSize({ width: viewport.width, height: Math.round(viewport.height * 0.55) });
  await expect.poll(() => inside(Math.round(viewport.height * 0.55))).toBe(true);
  await page.screenshot({ path: info.outputPath('installed-keyboard.png') });
});
