// E7 of the target architecture, as far as one local user reaches: a session opened from its address on a second device is the same
// conversation, live on both devices; and a temporary bot a bot started is kept by the Controller across a restart. The recipient of
// another account who may only read needs a second account on the stack, which the Devbox Relay does not have (open item O23).
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, openPageIn, resetWindows } from './browser.js';
import { send, showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, tools: true, sessions: {
    shared: { title: 'Shared', history: [{ role: 'user', text: 'Shared requirement' }, { role: 'assistant', text: 'Shared answer' }] },
    chief: { title: 'Chief', history: [{ role: 'user', text: 'Chief requirement' }, { role: 'assistant', text: 'Chief answer' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

/** A group of the account with Chief as its bot. */
async function chiefGroup(context: BrowserContext): Promise<void> {
  await resetWindows(context, stack.origin);
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const binding = { hostId: stack.hostId, providerId: stack.provider.providerId, nativeSessionId: 'chief', title: 'Chief' };
  const response = await context.request.post(stack.origin + status.basePath + 'v1/windows', { headers: { origin: stack.origin }, data: { operationId: randomUUID(), issuedAt: Date.now(),
    window: { schemaVersion: 3, id: randomUUID(), title: 'Release', revision: 0, selectedPrimaryViewId: 'chief', selectedViewId: 'chief', views: [createWindowView('chief', binding, 'primary')] },
    bots: { rank: 'm', members: { chief: { name: 'Chief' } } } } });
  if (!response.ok()) throw new Error(`The group could not be created (${response.status()}).`);
}

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

it('E7: a temporary bot a bot started is kept across a Controller restart, and still reports to its chief', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await chiefGroup(context);
  await showsText(page, 'Chief answer');
  const tools = (nativeSessionId: string) => stack.provider.given(nativeSessionId)?.tools.map(tool => tool.name) ?? [];
  await expect.poll(() => tools('chief'), { timeout: 20_000 }).toContain('create_bot');
  // The Relay offers tasks to the Controller a moment after its tools arrive.
  await expect.poll(async () => stack.provider.useTool('chief', 'create_bot', { name: 'Logs', mission: 'Collect the logs.' }).catch(() => undefined), { timeout: 20_000 }).toMatchObject({ status: 'working' });
  const worker = () => stack.provider.known().find(id => id.includes('-new-'));
  await expect.poll(worker, { timeout: 20_000 }).toBeDefined();
  const bot = worker()!;
  await stack.stopController();
  await stack.startController();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await showsText(page, 'Chief answer');
  await expect.poll(() => tools(bot), { timeout: 30_000 }).toContain('message');
  await expect.poll(async () => stack.provider.useTool(bot, 'message', { to: 'chief', text: 'Logs saved after the restart.', status: 'done' }).catch(() => undefined), { timeout: 20_000 }).toBeDefined();
  await expect.poll(() => stack.provider.session('chief')!.sent.some(text => text.includes('Logs saved after the restart.')), { timeout: 20_000 }).toBe(true);
  await context.close();
});

it('E7: two pages opened at once on an account with no Window converge on one Window', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await resetWindows(context, stack.origin);
  const [{ page: first }, { page: second }] = await Promise.all([openPageIn(context, stack.origin + '/'), openPageIn(context, stack.origin + '/')]);
  const windowOf = (page: Page) => page.waitForFunction(() => new URL(location.href).searchParams.get('window'), undefined, { timeout: 25_000 }).then(handle => handle.jsonValue() as Promise<string>);
  const [one, other] = [await windowOf(first), await windowOf(second)];
  expect(other).toBe(one);
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const { windows } = await (await context.request.get(stack.origin + status.basePath + 'v1/windows')).json() as { windows: unknown[] };
  expect(windows).toHaveLength(1);
  await context.close();
});
