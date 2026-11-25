// Component projects: orchard-phone-chromium, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';
import { contrastFailures } from './contrast.js';
import { englishWords } from './english-words.js';

// One Settings page (I4 plan, Task 6): its six groups on the desktop (the list beside the chosen group) and on the phone (Me, then a
// group), in both themes and both languages: contrast, 44 px targets, no horizontal overflow, and no English word in Chinese.

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) <= 430;
const sample = ['Chief', 'Builder', 'Reviewer', 'Notes', 'Helper', 'Tester', 'Mac', 'mini', 'Studio', 'chief@example.com', 'claude', 'Safari', 'App', 'darwin', 'arm64'];
/** Pages of the Host settings that still hold their English words (moved whole from the old panel). */
const GROUPS = {
  en: ['General', 'Assistants', 'Computers', 'Privacy and data', 'Advanced', 'Account and about'],
  zh: ['通用', '助手', '电脑', '隐私与数据', '高级', '账户与关于'],
} as const;

for (const locale of ['en-US', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${locale} ${theme}`, () => {
      test.use({ locale });
      const names = GROUPS[locale === 'zh-CN' ? 'zh' : 'en'];
      const open = async (page: Page, group?: string) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot&theme=${theme}`);
        await (phone(page) ? page.locator('.lab-tab-bar .lab-tab').last() : page.locator('.lab-rail').getByRole('button', { name: locale === 'zh-CN' ? '设置' : 'Settings', exact: true })).click();
        await expect(page.locator('.lab-settings').first()).toBeVisible();
        if (group) await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: new RegExp(`^${group}$`) }) }).click();
      };

      test('lists the six groups, and shows each with contrast, targets and width in order', async ({ page }, testInfo) => {
        await open(page);
        const list = page.locator('.lab-settings-list');
        await expect(list.locator('.lab-settings-group strong')).toHaveText([...names]);
        for (const [index, name] of names.entries()) {
          if (phone(page) && index > 0) await page.locator('.lab-settings-head').getByRole('button').first().click();
          await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
          await expect(page.locator('.lab-settings h1')).toHaveText(name);
          if (!phone(page)) await expect(page.locator('.lab-settings-group[aria-current="page"] strong')).toHaveText(name);
          await expect(page.locator('.lab-settings-body')).toBeVisible();
          expect(await contrastFailures(page), name).toEqual([]);
          const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth, body: (() => { const body = document.querySelector('.lab-settings-body')!; return body.scrollWidth - body.clientWidth; })() }));
          expect(overflow.page, `${name}: the page does not scroll sideways`).toBeLessThanOrEqual(1);
          expect(overflow.body, `${name}: the group fits its panel`).toBeLessThanOrEqual(1);
          if (phone(page)) {
            for (const control of await page.locator('.lab-settings button:visible, .lab-settings [role="switch"]:visible, .lab-settings select:visible').all()) {
              const box = (await control.boundingBox())!;
              expect(box.height, `${name}: ${(await control.textContent())?.slice(0, 30)}`).toBeGreaterThanOrEqual(43.5);
            }
          }
          if (locale === 'zh-CN') expect(await englishWords(page, { allow: sample }), name).toEqual([]);
          await page.screenshot({ path: testInfo.outputPath(`settings-${index}-${locale}-${theme}.png`) });
        }
      });

      test('Theme, Reduce motion and Default view change at once on this device', async ({ page }) => {
        await open(page, names[0]);
        const label = locale === 'zh-CN' ? { theme: '主题', dark: '深色', light: '浅色', motion: '减少动效', view: '默认视图', chats: '聊天' } : { theme: 'Theme', dark: 'Dark', light: 'Light', motion: 'Reduce motion', view: 'Default view', chats: 'Chats' };
        await page.getByRole('group', { name: label.theme }).getByRole('button', { name: label.dark, exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await page.getByRole('group', { name: label.theme }).getByRole('button', { name: label.light, exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        await page.getByRole('switch', { name: label.motion }).click();
        await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
        await page.getByRole('group', { name: label.view }).getByRole('button', { name: label.chats, exact: true }).click();
        expect(await page.evaluate(() => localStorage.getItem('agent-remote:default-view'))).toBe('chats');
      });
    });
  }
}

test('Language switches the page between Chinese and English with the document language', async ({ page }) => {
  await page.goto('/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot');
  await (phone(page) ? page.locator('.lab-tab-bar .lab-tab').last() : page.locator('.lab-rail').getByRole('button', { name: 'Settings', exact: true })).click();
  await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: /^General$/ }) }).click();
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: '中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('.lab-settings h1')).toHaveText('通用');
  await page.getByRole('group', { name: '语言' }).getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.lab-settings h1')).toHaveText('General');
});

test('a computer opens as a page with its smart reading switch per agent, and a shared computer has none', async ({ page }) => {
  await page.goto('/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot');
  await (phone(page) ? page.locator('.lab-tab-bar .lab-tab').last() : page.locator('.lab-rail').getByRole('button', { name: 'Settings', exact: true })).click();
  await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: /^Computers$/ }) }).click();
  await expect(page.locator('.lab-host-lead')).toHaveText('1 of 2 online');
  await page.locator('.lab-host-card[data-host-id="mac"] .lab-host-open').click();
  await expect(page.locator('.lab-host-page-head h2')).toHaveText('Mac mini');
  const claude = page.getByRole('switch', { name: 'Smart reading for Claude Code' });
  await expect(claude).toHaveAttribute('aria-checked', 'true');
  const codex = page.getByRole('switch', { name: 'Smart reading for Codex' });
  await expect(codex).toHaveAttribute('aria-checked', 'false');
  await codex.click();
  await expect(codex).toHaveAttribute('aria-checked', 'true');
  await page.locator('.lab-host-back').click();
  await page.locator('.lab-host-card[data-host-id="studio"] .lab-host-open').click();
  await expect(page.locator('.lab-host-page-head h2')).toHaveText('Studio');
  await expect(page.getByRole('switch', { name: /Smart reading/ })).toHaveCount(0);
});

test('a computer card lists what uses the machine, fitted to the card and readable', async ({ page }) => {
  await page.goto('/e2e/fixtures/assistant-conversation.html?layout=bot&mode=bot');
  await (phone(page) ? page.locator('.lab-tab-bar .lab-tab').last() : page.locator('.lab-rail').getByRole('button', { name: 'Settings', exact: true })).click();
  await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: /^Computers$/ }) }).click();
  const list = page.locator('.lab-host-card[data-host-id="mac"] .lab-host-processes');
  await expect(list.locator('h4')).toHaveText('What uses this machine');
  await expect(list.locator('li')).toHaveCount(5);
  await expect(list.locator('li').first()).toContainText('claude');
  await expect(list.locator('li').first()).toContainText('1.4 GB');
  const fit = await list.evaluate(node => ({ card: node.closest('.lab-host-card')!.getBoundingClientRect().width, rows: [...node.querySelectorAll('li')].map(row => row.scrollWidth - row.clientWidth) }));
  expect(Math.max(...fit.rows)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await contrastFailures(page)).toEqual([]);
});
