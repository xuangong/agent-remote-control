import { expect, test, type Page } from '@playwright/test';
import { contrastFailures } from './contrast.js';
import { coveringControls } from './covering.js';
import { englishWords } from './english-words.js';

// Navigation (I4 plan, Task 5): the desktop's icon rail and the phone's tab bar, the same four destinations, in both themes and
// both languages. Buttons are 42 px (44 px under a coarse pointer), the current destination says so, no floating control covers
// text, and a keyboard that covers the tab bar leaves the screen whole.

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) <= 430;
const url = (query = '') => `/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot${query}`;
const sample = ['Chief', 'Builder', 'Reviewer', 'Notes', 'Helper', 'Tester', 'Mac', 'mini', 'chief@example.com', 'claude', 'Safari', 'App'];

for (const locale of ['en-US', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${locale} ${theme}`, () => {
      test.use({ locale });
      const names = locale === 'zh-CN' ? { chats: '聊天', assistants: '助手', settings: '设置', me: '我', windows: '窗口' } : { chats: 'Chats', assistants: 'Assistants', settings: 'Settings', me: 'Me', windows: 'Windows' };
      const destination = (page: Page, name: string) => phone(page) ? page.locator('.lab-tab-bar .lab-tab', { hasText: name === names.settings ? names.me : name })
        : page.locator('.lab-rail').getByRole('button', { name, exact: true });

      test('shows the rail or the tab bar with the current destination marked, and 44 px targets under a coarse pointer', async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(url(`&theme=${theme}`));
        await expect(page.locator('.lab-bot-roster')).toBeVisible();
        if (phone(page)) {
          await expect(page.locator('.lab-rail')).toHaveCount(0);
          const bar = page.locator('.lab-tab-bar');
          await expect(bar).toBeVisible();
          await expect(bar.locator('.lab-tab')).toHaveCount(4);
          const box = (await bar.boundingBox())!;
          expect(box.y + box.height).toBeLessThanOrEqual(844 + 1);
          for (const tab of await bar.locator('.lab-tab').all()) {
            const target = (await tab.boundingBox())!;
            expect(target.width, 'tab width').toBeGreaterThanOrEqual(44);
            expect(target.height, 'tab height').toBeGreaterThanOrEqual(44);
          }
        } else {
          await expect(page.locator('.lab-tab-bar')).toHaveCount(0);
          const rail = page.locator('.lab-rail');
          await expect(rail).toBeVisible();
          const width = (await rail.boundingBox())!.width;
          expect(width).toBeGreaterThanOrEqual(56); expect(width).toBeLessThanOrEqual(64);
          for (const button of await rail.getByRole('button').all()) {
            const target = (await button.boundingBox())!;
            expect(target.width, 'button width').toBeGreaterThanOrEqual(42);
            expect(target.height, 'button height').toBeGreaterThanOrEqual(42);
          }
        }
        await expect(destination(page, names.chats)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('[aria-current="page"]').filter({ hasNot: page.locator('.lab-bot-row') })).toHaveCount(1);
        expect(await contrastFailures(page)).toEqual([]);
        expect(await coveringControls(page, '.lab-bot-roster-list')).toEqual([]);
        if (locale === 'zh-CN') expect(await englishWords(page, { allow: sample })).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`navigation-${locale}-${theme}.png`) });
      });

      test('moves between Chats, the Assistants directory and Settings, and each leaves the others as they were', async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(url(`&theme=${theme}&section=notes&bot=chief`));
        // A conversation: the tab bar steps aside on the phone, the rail stays on the desktop.
        await expect(page.locator('.lab-bot-conversation')).toBeVisible();
        if (phone(page)) {
          await expect(page.locator('.lab-tab-bar')).toBeHidden();
          await page.getByRole('button', { name: 'Back to chats', exact: false }).or(page.locator('.lab-bot-back')).first().click();
          await expect(page.locator('.lab-tab-bar')).toBeVisible();
        } else {
          expect(await coveringControls(page)).toEqual([]);
        }
        await destination(page, names.assistants).click();
        await expect(destination(page, names.assistants)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('.lab-directory')).toBeVisible();
        expect(new URL(page.url()).searchParams.get('page')).toBe('assistants');
        await expect(page.locator('.lab-directory .lab-bot-member')).toHaveCount(3);
        expect(await contrastFailures(page)).toEqual([]);
        expect(await coveringControls(page, '.lab-directory-groups')).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`directory-${locale}-${theme}.png`) });
        await destination(page, names.settings).click();
        await expect(destination(page, names.settings)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('.lab-settings').first()).toBeVisible();
        expect(new URL(page.url()).searchParams.get('page')).toBe('settings');
        expect(await contrastFailures(page)).toEqual([]);
        expect(await coveringControls(page, '.lab-settings-body, .lab-settings-list')).toEqual([]);
        // Back to Chats: the same conversation, as it was.
        await destination(page, names.chats).click();
        await expect(destination(page, names.chats)).toHaveAttribute('aria-current', 'page');
        expect(new URL(page.url()).searchParams.get('page')).toBeNull();
        expect(new URL(page.url()).searchParams.get('bot')).toBe('chief');
        if (!phone(page)) await expect(page.locator('.lab-bot-conversation')).toBeVisible();
      });
    });
  }
}

test('a keyboard that covers the tab bar leaves the list whole, with the tab bar off the screen', async ({ page }) => {
  test.skip(!phone(page), 'The tab bar is the phone\'s.');
  await page.goto(url());
  await expect(page.locator('.lab-tab-bar')).toBeVisible();
  const listBottom = async () => (await page.locator('.lab-bot-roster').boundingBox())!.y + (await page.locator('.lab-bot-roster').boundingBox())!.height;
  const barTop = (await page.locator('.lab-tab-bar').boundingBox())!.y;
  expect(await listBottom()).toBeLessThanOrEqual(barTop + 1);
  // What the visual viewport hook does when a keyboard covers the bottom: its measured height and the occluded mark.
  await page.locator('.lab-bot-workspace').evaluate(node => { node.dataset.viewportOccluded = 'true'; node.style.setProperty('--lab-viewport-height', '440px'); });
  await expect(page.locator('.lab-tab-bar')).toBeHidden();
  expect(await listBottom()).toBeLessThanOrEqual(440 + 1);
});

test('the rail opens search and offers the account with the device-link dot', async ({ page }) => {
  test.skip(phone(page), 'The rail is the desktop\'s.');
  await page.goto(url());
  const rail = page.locator('.lab-rail');
  await expect(rail.getByRole('button', { name: 'Search' })).toHaveAttribute('title', /Search \((⌘K|Ctrl\+K)\)/);
  const avatar = rail.locator('.lab-rail-avatar');
  await expect(avatar.locator('.lab-link-dot')).toHaveAttribute('data-link', 'online');
  await avatar.click();
  await expect(page.locator('.lab-rail-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.lab-rail-popover')).toHaveCount(0);
});

test('the tab bar stays while the Window shell is hidden, whatever its drawer state, and steps aside only when that drawer shows', async ({ page }) => {
  test.skip(!phone(page), 'The tab bar is the phone\'s.');
  await page.goto(url());
  await expect(page.locator('.lab-bot-roster')).toBeVisible();
  // The Window-mode shell stays mounted but hidden in Chats, and keeps its last drawer state.
  await page.evaluate(() => {
    const shell = document.createElement('main');
    shell.className = 'lab-shell lab-window-mode lab-supporting-open';
    shell.hidden = true;
    document.querySelector('.lab-frame')!.append(shell);
  });
  await expect(page.locator('.lab-tab-bar')).toBeVisible();
  await page.evaluate(() => { (document.querySelector('.lab-frame > .lab-shell') as HTMLElement).hidden = false; });
  await expect(page.locator('.lab-tab-bar')).toBeHidden();
});
