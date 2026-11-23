// Component projects: webkit-conversation
import { expect, test, type Page } from '@playwright/test';

// Without the sidebar, a wide screen floats the Track, Window and Ask entries in the margin, where a person can drag them. A
// compact screen (up to 1180 px) has no floating entries: they are capsules in a launcher bar (`launcher-layout`), so these tests run on a
// desktop profile.
const controls = [
  { view: 'window', label: 'Groups', position: 'agent-remote:window-position' },
  { view: 'track', label: 'Tracked sessions', position: 'agent-remote-tracking-position' },
  { view: 'ask', label: 'Ask about this session', position: 'agent-remote:ask-position' },
];

/** An entry's button, never the rail's or the tab bar's destinations. */
const entryButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).and(page.locator(':not(.lab-rail *, .lab-tab-bar *)'));

for (const control of controls) {
  test(`${control.view} floating button keeps the conversation width when moved to the right edge`, async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'A compact screen has a launcher bar, not floating entries.');
    const width = 1440;
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ view, position }) => {
      for (const name of ['window', 'track', 'ask']) localStorage.setItem(`agent-remote:${name}-view`, String(name === view));
      localStorage.setItem(position, JSON.stringify({ x: 120, y: 260 }));
      localStorage.setItem('agent-remote:desktop-notifications', 'false');
    }, control);
    await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
    await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
    await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
    await page.goto('/e2e/fixtures/session-stars.html');
    const button = entryButton(page, control.label);
    await expect(button).toBeEnabled();
    const rail = page.locator('.lab-main-stage .lab-session-dock-rail');
    await expect(rail).toBeVisible();
    const original = (await rail.boundingBox())!;
    const anchor = (await button.boundingBox())!;
    await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
    await page.mouse.down();
    await page.mouse.move(width - 1, anchor.y + anchor.height / 2, { steps: 10 });
    await page.mouse.up();
    const fromRight = async () => { const box = (await button.boundingBox())!; return Math.round(width - box.x - box.width); };
    await expect.poll(fromRight).toBe(12);
    await page.screenshot({ path: info.outputPath('right-edge.png') });
    expect((await rail.boundingBox())!.width).toBeCloseTo(original.width, 1);
    await button.press('Shift+ArrowLeft');
    expect((await button.boundingBox())!.x).toBeLessThan(width - anchor.width - 12);
    expect((await rail.boundingBox())!.width).toBeCloseTo(original.width, 1);
    await button.press('Shift+ArrowRight');
    await expect.poll(fromRight).toBe(12);
    expect((await rail.boundingBox())!.width).toBeCloseTo(original.width, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
