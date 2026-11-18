// E7 of the target architecture, as far as one local user reaches: a session opened from its address on a second device is the same
// conversation, live on both devices; and a Team created from a bot is kept by the Controller. The recipient of another account who may
// only read needs a second account on the stack, which the Devbox Relay does not have (open item O23).
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn } from './browser.js';
import { send, showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, sessions: {
    shared: { title: 'Shared', history: [{ role: 'user', text: 'Shared requirement' }, { role: 'assistant', text: 'Shared answer' }] },
    leader: { title: 'Leader', history: [{ role: 'user', text: 'Leader requirement' }, { role: 'assistant', text: 'Leader answer' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

/** The Team pill shows how many Teams the Controller keeps. */
const teamCount = (page: Page, count: number) => page.waitForFunction(needed => [...document.querySelectorAll('button')].some(button => new RegExp(`^Team\\s*${needed}$`).test((button.textContent ?? '').trim())), count);

it('E7: a session opened from its address on a second device shows the same conversation, live on both', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('shared'));
  await showsText(page, 'Shared answer');
  const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page: other } = await openPageIn(second, stack.sessionUrl('shared'));
  await showsText(other, 'Shared answer');
  await send(page, 'written on device one');
  await showsText(other, 'Echo: written on device one');
  await send(other, 'written on device two');
  await showsText(page, 'Echo: written on device two');
  expect(stack.provider.session('shared')!.sent).toEqual(['written on device one', 'written on device two']);
  await second.close();
  await context.close();
});

it('E7: a Team created from a bot is counted, and survives a Controller restart', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('leader'));
  await showsText(page, 'Leader answer');
  await page.getByRole('button', { name: /^Team/ }).first().click();
  await page.getByRole('button', { name: 'New team' }).click();
  await teamCount(page, 1);
  await stack.stopController();
  await stack.startController();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await showsText(page, 'Leader answer');
  await teamCount(page, 1);
  await context.close();
});
