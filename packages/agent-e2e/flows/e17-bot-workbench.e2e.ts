// E17, a bot's workbench: the real page, Relay and Controller, with scripted sessions that take tools. The bot starts and ends
// sub-sessions in its model's place (`useTool`); the page shows them as tiles of the bot's workbench without writing the Window, the ledger
// beside them links an item's owner to its tile, and a free workbench is bound to a bot and unbound again with its tiles kept.
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { hasTools as hasToolsOf, team as teamOf } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';
import { showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, tools: true,
    turns: text => text.includes('Collect the logs.') ? [{ reply: 'Logs saved in /tmp/logs.' }] : text.includes('Collect the tests.') ? [{ reply: 'Two tests fail.' }] : undefined,
    sessions: { chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
      tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const windowsApi = async (context: BrowserContext) => {
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  return stack.origin + status.basePath + 'v1/windows';
};
type Group = { window: { id: string; revision: number; views: Array<{ id: string; feature?: { kind: string; id: string }; binding?: { nativeSessionId: string } }> }; bots?: { members: Record<string, { botId?: string; name?: string }> } };
const groups = async (context: BrowserContext) => (await (await context.request.get(await windowsApi(context))).json() as { groups: Group[] }).groups;
const botIdOf = async (context: BrowserContext, name: string) => (await groups(context)).flatMap(group => Object.values(group.bots?.members ?? {})).find(member => member.name === name)!.botId!;

/** The workbench the page makes for a bot: a Window for it alone, with the bot's session as its tagged main tile. */
async function bindingWorkbench(context: BrowserContext, botId: string, nativeSessionId: string, title: string): Promise<string> {
  const id = `wb-${botId}`;
  const view = { ...createWindowView('main', { hostId: stack.hostId, providerId: stack.provider.providerId, nativeSessionId, title }, 'primary'), feature: { kind: 'bot', id: botId }, bindingPolicy: 'managed' };
  const response = await context.request.post(await windowsApi(context), { headers: { origin: stack.origin }, data: { operationId: randomUUID(), issuedAt: Date.now(),
    window: { schemaVersion: 3, id, title, revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [view] }, presentation: { bots: false } } });
  if (!response.ok()) throw new Error(`The workbench could not be created (${response.status()}).`);
  return id;
}
const tiles = (page: Page) => page.locator('[data-primary-group-id^="sub:"]');
const revisionOf = async (context: BrowserContext, id: string) => (await groups(context)).find(group => group.window.id === id)!.window.revision;

it('E17: the bot starts and ends sub-sessions and its workbench shows them as tiles without writing the Window', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await teamOf(stack, context);
  await hasToolsOf(stack, 'chief');
  const workbench = await bindingWorkbench(context, await botIdOf(context, 'Chief'), 'chief', 'Chief');
  await page.goto(`${stack.origin}/?mode=window&window=${workbench}`);
  await showsText(page, 'Chief is ready.');
  await expect.poll(() => page.locator('.lab-workbench-header').count(), { timeout: 20_000 }).toBe(1);
  const revision = await revisionOf(context, workbench);
  const started = [];
  for (const name of ['Logs', 'Tests']) started.push(await stack.provider.useTool('chief', 'create_sub_session', { name, prompt: `Collect the ${name.toLowerCase()}.` }) as { sub_session_id: string });
  await expect.poll(() => tiles(page).count(), { timeout: 30_000 }).toBe(2);
  // Each tile stands folded until the person opens it, and the bot's work never edited the Window.
  for (const tile of await tiles(page).all()) expect(await tile.getAttribute('data-minimized')).toBe('true');
  expect(await revisionOf(context, workbench)).toBe(revision);
  // Ending one moves it to the Ended fold.
  await stack.provider.useTool('chief', 'stop_sub_session', { sub_session_id: started[0]!.sub_session_id });
  await expect.poll(() => page.locator('[data-primary-group-id="group:ended"]').count(), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => tiles(page).count(), { timeout: 30_000 }).toBe(1);
  expect(await revisionOf(context, workbench)).toBe(revision);
  // The person opens the remaining tile: its conversation, with the result its turn ended with.
  await tiles(page).first().locator('button.lab-folded-bot').click();
  await showsText(page, 'Two tests fail.');
  await context.close();
});

it('E17: an item of the ledger links its owner to the sub-session\'s tile', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await teamOf(stack, context);
  await hasToolsOf(stack, 'chief');
  const workbench = await bindingWorkbench(context, await botIdOf(context, 'Chief'), 'chief', 'Chief');
  await stack.provider.useTool('chief', 'update_board', { items: [{ title: 'Collect the logs' }] });
  await stack.provider.useTool('chief', 'create_sub_session', { name: 'Logs', prompt: 'Collect the logs.', tracked_task_keys: [1] });
  await page.goto(`${stack.origin}/?mode=window&window=${workbench}`);
  await page.getByRole('button', { name: 'Ledger', exact: true }).first().waitFor();
  const ledger = page.locator('.lab-workbench-ledger');
  if (!await ledger.count()) await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
  await expect.poll(() => ledger.textContent(), { timeout: 30_000 }).toContain('Collect the logs');
  await ledger.locator('.lab-assistant-session-toggle').first().click();
  await ledger.getByRole('button', { name: /Open Logs/ }).first().click();
  await expect.poll(() => page.locator('.lab-derived-tile').count(), { timeout: 20_000 }).toBe(1);
  await context.close();
});

it('E17: a free workbench is bound to a bot and unbound again, keeping its tiles', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  const groupId = await teamOf(stack, context);
  await hasToolsOf(stack, 'chief');
  await page.goto(`${stack.origin}/?mode=window&window=${groupId}`);
  await page.getByRole('button', { name: 'Group actions' }).waitFor();
  const choose = async (item: string) => { await page.getByRole('button', { name: 'Group actions' }).click(); await page.getByRole('menuitem', { name: item }).click(); };
  expect(await page.locator('.lab-workbench-header').count()).toBe(0);
  await choose('Bind to a bot…');
  await page.getByRole('dialog').getByRole('button', { name: 'Chief', exact: true }).click();
  await expect.poll(() => page.locator('.lab-workbench-header').count(), { timeout: 20_000 }).toBe(1);
  expect((await groups(context)).find(group => group.window.id === groupId)!.window.views.find(view => view.feature?.kind === 'bot')?.binding?.nativeSessionId).toBe('chief');
  await choose('Unbind from Chief');
  await page.getByRole('dialog').getByRole('button', { name: 'Unbind', exact: true }).click();
  await expect.poll(() => page.locator('.lab-workbench-header').count(), { timeout: 20_000 }).toBe(0);
  const unbound = (await groups(context)).find(group => group.window.id === groupId)!.window;
  expect(unbound.views.some(view => view.feature?.kind === 'bot')).toBe(false);
  expect(unbound.views.map(view => view.binding?.nativeSessionId)).toEqual(expect.arrayContaining(['chief', 'tracker']));
  await context.close();
});

it('E17: on a phone the workbench is a list, a row pushes the sub-session full screen and Back returns to the list', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'), { mobile: true, viewport: { width: 390, height: 844 } });
  await teamOf(stack, context);
  await hasToolsOf(stack, 'chief');
  const workbench = await bindingWorkbench(context, await botIdOf(context, 'Chief'), 'chief', 'Chief');
  await stack.provider.useTool('chief', 'create_sub_session', { name: 'Tests', prompt: 'Collect the tests.' });
  await page.goto(`${stack.origin}/?mode=window&window=${workbench}`);
  const overview = page.locator('.lab-workbench-overview');
  await expect.poll(() => overview.count(), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => overview.locator('[data-tile^="sub:"]').count(), { timeout: 30_000 }).toBe(1);
  // A phone opens a Window address with the sessions drawer over it; dismissing it shows the workbench.
  await page.keyboard.press('Escape');
  expect(await page.locator('[data-primary-group-id]').count()).toBe(0);
  await overview.locator('[data-tile^="sub:"]').click();
  await showsText(page, 'Two tests fail.');
  expect(await overview.count()).toBe(0);
  await page.getByRole('button', { name: /^‹/ }).click();
  await expect.poll(() => overview.count(), { timeout: 10_000 }).toBe(1);
  await context.close();
});
