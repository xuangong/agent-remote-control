// E11 of the I4 plan: Settings on the real stack. A person types a half-written message in an assistant's chat, opens Settings (the rail on
// a desktop, Me on a phone), chooses Dark and then 中文 and sees the page in Chinese with `<html lang="zh-CN">`, turns smart reading off for
// the scripted provider in Computers and sees the Relay agree, then on again, and returns to Chats to find the same chat with its draft.
// No frame shows a per-session connection word (target T5). Desktop and a phone viewport; `E2E_BROWSER=webkit` runs both in WebKit.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, type PageOptions } from './browser.js';
import { chooseSetting, goTo, openComputer, openSettings, waitForEntries } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });

const DRAFT = 'A half-written thought for later';
const variants: Array<[string, PageOptions]> = [
  ['desktop 1280x800', { viewport: { width: 1280, height: 800 } }],
  ['phone 390x844', { viewport: { width: 390, height: 844 }, mobile: true }],
];

/** The providers the Relay keeps smart reading on for, for this Host, as its owner reads them. */
async function smartReadingOf(context: BrowserContext, origin: string, hostId: string): Promise<string[]> {
  const status = await (await context.request.get(origin + '/auth/status')).json() as { basePath: string };
  const response = await context.request.get(`${origin}${status.basePath}v1/remote/hosts/${encodeURIComponent(hostId)}/smart-reading`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { providers: string[] }).providers;
}

describe.each(variants)('E11 at %s', (_name, view) => {
  beforeAll(async () => {
    stack = await startStack({ sessions: { chief: { title: 'Chief', history: [{ role: 'user', text: 'Hello Chief' }, { role: 'assistant', text: 'Hello, ready when you are.' }] } } });
  });
  afterAll(async () => { await stack?.close(); });

  it('E11: Dark and 中文 apply at once, smart reading changes at the Relay, and the same chat returns with its draft, with no connection word', async () => {
    const { context, page, words } = await openPage(browser, stack.sessionUrl('chief'), view);
    try {
      await waitForEntries(page, 2);
      // An assistant's chat in Chats, with a draft in its composer.
      await page.getByRole('button', { name: 'More session actions' }).first().click();
      await page.getByRole('button', { name: 'Open in Bot mode', exact: true }).first().click();
      const bot = page.locator('[data-workbench-mode="bot"]');
      await bot.locator('.lab-assistant-top-bar').waitFor();
      // The assistant is called by a generated name, which follows the language; the chat is the same one by its place in the address.
      const name = await bot.locator('.lab-assistant-top-bar .lab-assistant-name').innerText();
      const chat = new URL(page.url()).searchParams.get('bot');
      expect(chat).toBeTruthy();
      const composer = bot.getByRole('textbox', { name: 'Message', exact: true });
      await composer.click();
      await page.keyboard.type(DRAFT);
      await expect.poll(() => composer.innerText()).toBe(DRAFT);

      // Settings over the chat: General, with Dark applied at once and then Chinese.
      await openSettings(page, 'General');
      await page.getByRole('group', { name: 'Theme', exact: true }).getByRole('button', { name: 'Dark', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
      await page.getByRole('group', { name: 'Language', exact: true }).getByRole('button', { name: '中文', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('zh-CN');
      await expect.poll(() => page.locator('.lab-settings h1').innerText()).toBe('通用');
      expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');

      // Computers, in Chinese: the scripted provider's smart reading turns off at the Relay, and on again.
      await chooseSetting(page, '电脑');
      await openComputer(page, stack.hostName);
      const provider = stack.provider.providerId;
      const toggle = page.getByRole('switch', { name: /的智能读取$/ }).first();
      await toggle.waitFor();
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
      expect(await smartReadingOf(context, stack.origin, stack.hostId)).toContain(provider);
      await toggle.click();
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false');
      await expect.poll(() => smartReadingOf(context, stack.origin, stack.hostId), { timeout: 10_000 }).not.toContain(provider);
      await toggle.click();
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
      await expect.poll(() => smartReadingOf(context, stack.origin, stack.hostId), { timeout: 10_000 }).toContain(provider);

      // Back to Chats: the same assistant, with its draft.
      await goTo(page, '聊天');
      if (view.mobile) await bot.locator(`.lab-bot-row[data-bot-place*="${chat}"]`).first().click();
      await bot.locator('.lab-assistant-top-bar').waitFor();
      await expect.poll(() => bot.getByRole('textbox').first().innerText()).toBe(DRAFT);
      expect(new URL(page.url()).searchParams.get('bot')).toBe(chat);
      expect(name).not.toBe('Chief');
      expect(new URL(page.url()).searchParams.get('page')).toBeNull();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await words.seen()).toEqual([]);
    } finally { await context.close(); }
  });
});
