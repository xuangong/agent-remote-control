// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';
import { installLifecycle, type TitleBarArea } from '@orchardworks/agent-e2e/lifecycle';
import { contrastFailures } from './contrast.js';
import { coveringControls, panelOverlaps } from './covering.js';

// Orchard installed as an app (I5a). On the desktop its window may give the title bar to the page (Window Controls Overlay): the
// page's title bar then carries the assistant's name over a drag region, inside the area clear of the traffic lights or the window
// controls, and the panels start below it. Playwright cannot emulate the overlay and Chromium's DevTools emulation does nothing headless,
// so the lifecycle simulator's installed desktop app gives the page the overlay's API (`titleBar`). Settings > General offers
// installation only where the browser does: its own prompt, or Safari's instructions for the home screen or the Dock.

const BOT = '/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&section=notes&bot=chief';
/** The title bar areas a desktop app window leaves the page at 1440 px: right of macOS's traffic lights, left of Windows's controls. */
const AREAS: Readonly<Record<'macOS' | 'Windows', TitleBarArea>> = {
  macOS: { x: 78, y: 0, width: 1362, height: 28 },
  Windows: { x: 0, y: 0, width: 1302, height: 33 },
};

async function openBot(page: Page, theme: 'light' | 'dark', query = '') {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${BOT}&theme=${theme}${query}`);
  await page.locator('.lab-bot-conversation .agent-turn').first().waitFor();
}
/** Settings > General, from the rail or the tab bar. */
async function openGeneralSettings(page: Page) {
  const phone = (page.viewportSize()?.width ?? 0) <= 760;
  if (phone) {
    await page.locator('.lab-bot-back').click();
    await page.locator('.lab-tab-bar .lab-tab').last().click();
  } else await page.locator('.lab-rail').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: /^General$/ }) }).click();
  await expect(page.locator('.lab-settings h1')).toHaveText('General');
}
/** What the browser does when it can install the site: `beforeinstallprompt`, whose `prompt()` the page may call once. */
const offerInstallation = (page: Page) => page.evaluate(() => {
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: async () => { (window as unknown as { prompted: number }).prompted = ((window as unknown as { prompted?: number }).prompted ?? 0) + 1; },
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  });
  dispatchEvent(event);
  return event.defaultPrevented;
});

test.describe('the installed desktop app', () => {
  test.skip(({ isMobile }) => isMobile, 'A desktop app window.');

  for (const platform of ['macOS', 'Windows'] as const) for (const theme of ['light', 'dark'] as const) {
    test(`carries the assistant's name over a drag region in the title bar, clear of the ${platform} window controls, ${theme}`, async ({ page, browserName }, testInfo) => {
      const area = AREAS[platform];
      await page.setViewportSize({ width: 1440, height: 900 });
      const lifecycle = await installLifecycle(page, { titleBar: area });
      await openBot(page, theme);
      const bar = page.locator('.lab-title-bar');
      await expect(bar).toHaveText('Chief');
      await expect(page).toHaveTitle('Chief · Orchard');
      const box = (await bar.boundingBox())!;
      expect([box.x, box.y, box.width, box.height]).toEqual([area.x, area.y, area.width, area.height]);
      // The name sits in the middle of the area, so it never reaches the controls beside it.
      const name = (await bar.locator('.lab-title-bar-name').boundingBox())!;
      expect(name.x).toBeGreaterThan(area.x);
      expect(name.x + name.width).toBeLessThan(area.x + area.width);
      // Chromium moves the window by the title bar; WebKit has no app regions.
      if (browserName === 'chromium') expect(await bar.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region') || getComputedStyle(element).getPropertyValue('app-region'))).toBe('drag');
      // The frame starts below the title bar, and the handles with it.
      for (const selector of ['.lab-rail', '.lab-bot-roster', '.lab-bot-conversation', '.lab-assistant-details', '.lab-panel-handle[data-panel="sidebar"]']) {
        expect((await page.locator(selector).boundingBox())!.y, selector).toBeGreaterThanOrEqual(area.y + area.height);
      }
      const frameBottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.lab-rail, .lab-bot-workspace')].map(element => element.getBoundingClientRect().bottom)));
      expect(frameBottom).toBeLessThanOrEqual(900);
      expect(await panelOverlaps(page)).toEqual([]);
      expect(await coveringControls(page)).toEqual([]);
      expect(await contrastFailures(page)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`title-bar-${platform}-${theme}.png`) });
      // Another assistant: the title bar and the window's title follow.
      await page.locator('.lab-bot-row', { hasText: 'Builder' }).click();
      await expect(bar).toHaveText('Builder');
      await expect(page).toHaveTitle('Builder · Orchard');
      // The person shows the window's own title bar again: the page's goes, and the frame takes the whole window.
      await lifecycle.setTitleBar(undefined);
      await expect(bar).toHaveCount(0);
      await expect.poll(async () => (await page.locator('.lab-rail').boundingBox())!.y).toBe(10);
      await lifecycle.setTitleBar(area);
      await expect(bar).toHaveText('Builder');
    });
  }

  test('keeps Window mode at 1000 px and a phone-width app window below the title bar', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    const lifecycle = await installLifecycle(page, { titleBar: { x: 78, y: 0, width: 922, height: 28 } });
    // The Workbench in Window mode, whose shell is fixed to the viewport up to 1180 px.
    await page.goto('/');
    const shell = page.locator('main.lab-shell');
    await shell.waitFor();
    await expect(page.locator('.lab-title-bar')).toBeVisible();
    expect((await shell.boundingBox())!.y).toBe(28);
    expect(Math.round((await shell.boundingBox())!.y + (await shell.boundingBox())!.height)).toBeLessThanOrEqual(800);
    // There Window mode's shell starts at the rail's edge: the rail has no handle over it.
    await expect(page.locator('.lab-panel-handle[data-panel="rail"]')).toBeHidden();
    // A window narrowed to the phone's width: the one panel and the pages start below the title bar too.
    await page.setViewportSize({ width: 700, height: 800 });
    await page.goto(`${BOT}&theme=light`);
    await lifecycle.setTitleBar({ x: 78, y: 0, width: 622, height: 28 });
    const workspace = page.locator('.lab-bot-workspace[data-phone]');
    await workspace.waitFor();
    await expect.poll(async () => (await workspace.boundingBox())!.y).toBe(28);
    await page.locator('.lab-bot-back').click();
    await page.locator('.lab-tab-bar .lab-tab').last().click();
    await expect.poll(async () => (await page.locator('.lab-page').boundingBox())!.y).toBe(28);
  });

  test('offers no installation from inside the installed app', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installLifecycle(page, { titleBar: AREAS.macOS });
    await openBot(page, 'light');
    await openGeneralSettings(page);
    expect(await offerInstallation(page)).toBe(true);
    await expect(page.getByText('Install Orchard')).toHaveCount(0);
    // The settings page under the title bar: nothing of it sits beneath the overlay.
    expect((await page.locator('.lab-settings').first().boundingBox())!.y).toBeGreaterThanOrEqual(AREAS.macOS.height);
  });
});

test.describe('Install Orchard in Settings', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`appears where the browser offers installation, and says how where Safari does, ${theme}`, async ({ page, browserName, isMobile }, testInfo) => {
      await openBot(page, theme);
      await openGeneralSettings(page);
      const entry = page.locator('#settings-install');
      if (browserName === 'webkit') {
        // Safari gives no prompt: an iPhone adds to its home screen, a Mac (Safari 17 and later) to its Dock.
        await expect(entry).toContainText(isMobile ? 'Tap Share, then Add to Home Screen.' : 'In Safari, choose File > Add to Dock.');
        await expect(entry.getByRole('button')).toHaveCount(0);
      } else {
        // Chromium offers installation when it can install the site; until then there is no entry.
        await expect(entry).toHaveCount(0);
        expect(await offerInstallation(page)).toBe(true);
        await expect(entry).toContainText('Install Orchard');
        await entry.getByRole('button', { name: 'Install', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { prompted?: number }).prompted)).toBe(1);
        // The prompt is spent once shown; the browser offers again only if it can still install.
        await expect(entry).toHaveCount(0);
        expect(await offerInstallation(page)).toBe(true);
        await expect(entry).toBeVisible();
      }
      expect(await contrastFailures(page)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`install-entry-${browserName}-${isMobile ? 'phone' : 'desktop'}-${theme}.png`) });
    });
  }

  test.describe('in Chinese', () => {
    test.use({ locale: 'zh-CN' });
    test('says how to install in Chinese', async ({ page, browserName, isMobile }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`${BOT}&theme=light`);
      await page.locator('.lab-bot-conversation .agent-turn').first().waitFor();
      if ((page.viewportSize()?.width ?? 0) <= 760) {
        await page.locator('.lab-bot-back').click();
        await page.locator('.lab-tab-bar .lab-tab').last().click();
      } else await page.locator('.lab-rail').getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: /^通用$/ }) }).click();
      if (browserName !== 'webkit') expect(await offerInstallation(page)).toBe(true);
      const entry = page.locator('#settings-install');
      await expect(entry).toContainText('安装 Orchard');
      await expect(entry).toContainText(browserName !== 'webkit' ? '在独立的窗口中打开' : isMobile ? '添加到主屏幕' : '添加到程序坞');
    });
  });
});
