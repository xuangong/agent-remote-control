// E19, the team page and the primary bot: the real page, Relay and Controller, with a scripted bot that takes tools. The chief writes its team
// page in its model's place (`useTool`); the page shows it as one card in the chief's conversation and a rewrite updates that card in place.
// The person marks the chief primary: the Relay keeps the mark, the chief's session is sent the primary section, and Chats shows the mark.
import type { Browser, BrowserContext } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { hasTools as hasToolsOf, team as teamOf } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, tools: true,
    sessions: { chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
      tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const base = async (context: BrowserContext) => stack.origin + (await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string }).basePath;
const members = async (context: BrowserContext) => ((await (await context.request.get(await base(context) + 'v1/windows')).json()) as { groups: Array<{ bots?: { members: Record<string, { botId?: string; name?: string; primary?: true }> } }> })
  .groups.flatMap(group => Object.values(group.bots?.members ?? {}));
const table = (rows: string[]) => ['| Task | Owner | Status |', '|---|---|---|', ...rows].join('\n');

it('E19: the chief writes its team page, the page shows one card and a rewrite updates it in place', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await teamOf(stack, context);
  await hasToolsOf(stack, 'chief');
  const written = await stack.provider.useTool('chief', 'write_page', { title: 'Release tracker', contents: table(['| Cut the branch | Chief | done |']), team: true }) as { pageId: string };
  expect(written.pageId).toMatch(/^pg_[0-9a-f]{12}$/);
  const card = page.locator('[data-page-card]');
  await expect.poll(() => card.count(), { timeout: 45_000 }).toBe(1);
  expect(await card.textContent()).toContain('Release tracker');
  expect(await card.textContent()).toContain('Updated by Chief');
  await card.getByRole('button', { name: 'Show page' }).click();
  expect(await card.locator('tbody tr').count()).toBe(1);
  await stack.provider.useTool('chief', 'write_page', { page_id: written.pageId, title: 'Release tracker', contents: table(['| Cut the branch | Chief | done |', '| Announce | Tracker | open |']) });
  await expect.poll(() => card.locator('tbody tr').count(), { timeout: 45_000 }).toBe(2);
  expect(await page.locator('[data-page-card]').count()).toBe(1);
  expect(await card.getAttribute('data-open')).toBe('true');
  // Everyone reads it: the tracker reads the chief's page by the chief's name.
  await hasToolsOf(stack, 'tracker');
  const read = await stack.provider.useTool('tracker', 'read_page', { bot: 'Chief', page_id: written.pageId }) as { contents: string };
  expect(read.contents).toContain('Announce');
  await context.close();
}, 90_000);

it('E19: the person marks the chief primary, which sends it the primary section and shows the mark in Chats, and replaces it when another is marked', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await teamOf(stack, context);
  await hasToolsOf(stack, 'chief');
  const all = await members(context), chief = all.find(member => member.name === 'Chief')!.botId!, tracker = all.find(member => member.name === 'Tracker')!.botId!;
  const url = (await base(context)) + 'v1/remote/chains/action';
  const post = (botId: string, primary: boolean) => context.request.post(url, { headers: { origin: stack.origin }, data: { action: 'set_primary', botId, primary } });
  expect((await post(chief, true)).ok()).toBe(true);
  await expect.poll(async () => (await members(context)).filter(member => member.primary).map(member => member.name), { timeout: 20_000 }).toEqual(['Chief']);
  await expect.poll(() => stack.provider.session('chief')?.sent.some(text => text.includes("You are the person's primary bot")) ?? false, { timeout: 30_000 }).toBe(true);
  await page.reload();
  await expect.poll(() => page.locator('.lab-bot-row [data-primary]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  expect((await post(tracker, true)).ok()).toBe(true);
  await expect.poll(async () => (await members(context)).filter(member => member.primary).map(member => member.name), { timeout: 20_000 }).toEqual(['Tracker']);
  await context.close();
});
