// E15, bots that call bots (bots design 11): the real page, Relay and Controller, with scripted sessions that take tools. A flow calls a
// bot's tool in its model's place (`useTool`); everything the call causes runs for real: tasks and their workers, inboxes, framed inputs,
// delivery between turns, and a standing bot joining its organizer's group.
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWindowView, parseTaskInputs } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage, resetWindows } from './browser.js';
import { showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, tools: true, sessions: {
    chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
    tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

/** One group of the account with Chief and Tracker as its bots. */
async function team(context: BrowserContext): Promise<string> {
  await resetWindows(context, stack.origin);
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const binding = (nativeSessionId: string, title: string) => ({ hostId: stack.hostId, providerId: stack.provider.providerId, nativeSessionId, title });
  const id = randomUUID();
  const response = await context.request.post(stack.origin + status.basePath + 'v1/windows', { headers: { origin: stack.origin }, data: { operationId: randomUUID(), issuedAt: Date.now(),
    window: { schemaVersion: 3, id, title: 'Release', revision: 0, selectedPrimaryViewId: 'chief', selectedViewId: 'chief',
      views: [createWindowView('chief', binding('chief', 'Chief'), 'primary'), createWindowView('tracker', binding('tracker', 'Tracker'), 'primary')] },
    bots: { rank: 'm', members: { chief: { name: 'Chief' }, tracker: { name: 'Tracker' } } } } });
  if (!response.ok()) throw new Error(`The team group could not be created (${response.status()}).`);
  return id;
}
/** A bot's tools arrive once the Controller has read which sessions are bots. */
const hasTools = (nativeSessionId: string) => expect.poll(() => stack.provider.given(nativeSessionId)?.tools.map(tool => tool.name) ?? [], { timeout: 20_000 }).toContain('create_bot');
const inputs = (nativeSessionId: string) => stack.provider.session(nativeSessionId)?.sent.flatMap(text => parseTaskInputs(text) ?? []) ?? [];

it('E15: a bot starts two temporary bots; both report while it is idle, as one input, and the page folds them', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await team(context);
  await showsText(page, 'Chief is ready.');
  await hasTools('chief');
  for (const name of ['Logs', 'Tests']) expect(await stack.provider.useTool('chief', 'create_bot', { name, mission: `Collect the ${name.toLowerCase()}.` })).toMatchObject({ status: 'working' });
  const workers = () => stack.provider.known().filter(id => id.includes('-new-'));
  await expect.poll(workers, { timeout: 20_000 }).toHaveLength(2);
  for (const worker of workers()) await hasTools(worker);
  const [logs, tests] = workers();
  await stack.provider.useTool(logs!, 'message', { to: 'organizer', text: 'Logs saved in /tmp/logs.', status: 'done' });
  await stack.provider.useTool(tests!, 'message', { to: 'organizer', text: 'Two tests fail.', status: 'failed' });
  await expect.poll(() => inputs('chief').map(input => input.kind).sort(), { timeout: 20_000 }).toEqual(['done', 'failed']);
  // Both results reached the organizer in one input.
  expect(stack.provider.session('chief')!.sent.filter(text => parseTaskInputs(text))).toHaveLength(1);
  await showsText(page, 'Two tests fail.');
  await context.close();
});

it('E15: a bot messages another bot in its inbox, which answers it, between their turns', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('tracker'));
  await team(context);
  await showsText(page, 'Tracker is ready.');
  await hasTools('chief'); await hasTools('tracker');
  const sent = await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Is the build green?' }) as { messageId: string; outcome: string };
  expect(sent.outcome).toBe('delivered');
  await expect.poll(() => inputs('tracker').filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toEqual([expect.objectContaining({ from: 'Chief', body: 'Is the build green?' })]);
  await stack.provider.useTool('tracker', 'message', { to: 'Chief', text: 'Green.', reply_to: sent.messageId });
  await expect.poll(() => inputs('chief').filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toEqual([expect.objectContaining({ from: 'Tracker', body: 'Green.', replyTo: sent.messageId })]);
  // The answer came from the turn the question started, so both are one chain, which the account's audit reads.
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const audit = await (await context.request.get(stack.origin + status.basePath + 'v1/remote/chains')).json() as { chains: Array<{ bots: string[]; messages: number; depth: number }>; names: Record<string, string> };
  const exchange = audit.chains.filter(chain => chain.bots.some(bot => audit.names[bot] === 'Tracker'));
  expect(exchange).toHaveLength(1);
  // Chief asked from the turn its last input started, so the exchange continues that turn's chain.
  expect(exchange[0]!.depth).toBe(2);
  expect(exchange[0]!.messages).toBeGreaterThanOrEqual(2);
  expect(exchange[0]!.bots.map(bot => audit.names[bot])).toEqual(expect.arrayContaining(['Chief', 'Tracker']));
  await context.close();
});

it('E15: a bot creates a standing bot, which joins its group in the page and reads its first message', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?mode=bot');
  await team(context);
  await hasTools('chief');
  expect(await stack.provider.useTool('chief', 'create_bot', { name: 'Scribe', mission: 'Keep the release notes.', lifetime: 'standing', message: 'Start from v0.3.' })).toMatchObject({ status: 'ready' });
  await showsText(page, 'Scribe');
  const scribe = () => stack.provider.known().filter(id => id.includes('-new-')).find(id => stack.provider.given(id)?.instructions?.includes('Keep the release notes.'));
  await expect.poll(scribe, { timeout: 20_000 }).toBeDefined();
  await expect.poll(() => inputs(scribe()!).filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toEqual([expect.objectContaining({ from: 'Chief', body: 'Start from v0.3.' })]);
  await context.close();
});

it('E15: the person stops a chain from the audit in Settings, and a bot\'s next call in it is refused', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?page=settings&group=assistants');
  await team(context);
  await hasTools('chief'); await hasTools('tracker');
  const sent = await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Draft the notes.' }) as { messageId: string };
  await expect.poll(() => inputs('tracker').some(input => input.kind === 'assistant' && input.body === 'Draft the notes.'), { timeout: 20_000 }).toBe(true);
  // The new group opened in the page; the person goes to Settings > Assistants.
  await page.goto(stack.origin + '/?page=settings&group=assistants');
  // The newest chain is the one this message continued; it lists Tracker among its bots.
  const row = page.locator('.lab-bot-audit > ul > li').first();
  await row.locator('.lab-assistant-session-toggle').click();
  await expect.poll(() => row.innerText(), { timeout: 20_000 }).toContain('Tracker');
  await row.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => row.locator('small').innerText(), { timeout: 20_000 }).toContain('Stopped');
  await expect(stack.provider.useTool('tracker', 'message', { to: 'Chief', text: 'Notes drafted.', reply_to: sent.messageId })).rejects.toThrow('The person stopped this work');
  await context.close();
});
