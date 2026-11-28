// E20, routines and the budget for unattended work: the real page, Relay and Controller, with a scripted session that takes tools and reports
// its model and usage. A bot sets a routine with its tool; the person tests it from the Relay's action (the page's Test button calls the same one) and
// the run's cost lands in Settings > Unattended work as ≈ $ from the model's price table. With a cap of $1 a day the next scheduled start
// is refused and recorded, the person allows more for the day and a start goes through, then pauses all unattended work and a start is
// held. `E2E_BROWSER=webkit` runs it in WebKit.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { BotChain, ChainView, Routine } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { hasTools, inputs, team } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';

const TASK = 'Summarise overnight failures.';
let stack: Stack; let browser: Browser;
beforeAll(async () => {
  // A turn that follows the routine's prompt costs a million input and a hundred thousand output tokens of Sonnet: $3 + $1.50.
  stack = await startStack({ teams: true, tools: true, model: 'claude-sonnet-4-5',
    turns: text => text.includes(TASK) ? [{ reply: 'All green.' }, { usage: { inputTokens: 1_000_000, outputTokens: 100_000 } }] : undefined,
    sessions: { chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
      tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E20: a bot\'s routine is tested, costs what its model costs, is refused at the cap, goes on when the person allows more, and is held by the pause', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?page=settings&group=assistants');
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const chains = `${stack.origin}${status.basePath}v1/remote/chains`;
  const view = async () => await (await context.request.get(chains)).json() as ChainView;
  const act = async (action: unknown) => { const response = await context.request.post(`${chains}/action`, { headers: { origin: stack.origin }, data: action }); if (!response.ok()) throw new Error(`${response.status()} ${await response.text()}`); return response.json(); };
  await team(stack, context);
  await hasTools(stack, 'chief');

  // The bot sets a routine with its tool: it takes effect at once, and the person sees it as the bot's.
  const set = await stack.provider.useTool('chief', 'set_routine', { name: 'Overnight', every_minutes: 5, prompt: TASK, model: 'claude-haiku-4-5' }) as { routines: Routine[] };
  expect(set.routines).toEqual([expect.objectContaining({ name: 'Overnight', by: 'bot', model: 'claude-haiku-4-5', schedule: { kind: 'every', minutes: 5 } })]);
  await expect.poll(async () => Object.keys((await view()).routines ?? {}).length, { timeout: 15_000 }).toBe(1);
  const botId = Object.keys((await view()).routines!)[0]!;
  const runs = async (name: string) => ((await view()).routines?.[botId] ?? []).find(routine => routine.name === name)?.runs ?? [];

  // The person caps unattended work at $1 a day on the page.
  await page.goto(stack.origin + '/?page=settings&group=assistants');
  const budget = page.getByRole('form', { name: 'Budget', exact: true });
  await budget.getByLabel('Per day').fill('1');
  await budget.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await view()).unattended?.settings.budget, { timeout: 10_000 }).toEqual({ perDay: 1 });

  // Test starts a run now, whatever the schedule says: the chief reads the frame marked as a test, answers, and the run is done with its cost.
  await act({ action: 'routine_test', botId, name: 'Overnight' });
  await expect.poll(() => inputs(stack, 'chief').some(input => input.kind === 'routine' && input.name === 'Overnight' && input.detail.includes('test')), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await runs('Overnight'))[0]?.state, { timeout: 30_000 }).toBe('done');
  const first = (await runs('Overnight'))[0]!;
  expect(first).toMatchObject({ trigger: 'test', tokens: 1_100_000 });
  expect(first.usd).toBeCloseTo(4.5, 6);
  const audit = await view();
  expect(audit.chains.find((chain: BotChain) => chain.cause === 'routine')).toMatchObject({ usage: { estimatedUsd: expect.closeTo(4.5, 6) } });

  // Settings shows what it cost and that the day's cap is reached.
  await page.goto(stack.origin + '/?page=settings&group=assistants');
  await expect.poll(() => page.getByText('Today · ≈ $4.50').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.getByText('Limit reached: all bots, today').count(), { timeout: 15_000 }).toBeGreaterThan(0);

  // The next scheduled start is refused and recorded; the chief is not woken.
  await act({ action: 'routine_set', botId, name: 'Soon', schedule: { kind: 'once', at: Date.now() + 3_000 }, prompt: TASK });
  await expect.poll(async () => (await runs('Soon'))[0], { timeout: 20_000 }).toMatchObject({ state: 'skipped', reason: 'budget' });
  expect(inputs(stack, 'chief').filter(input => input.kind === 'routine' && input.name === 'Soon')).toEqual([]);

  // The person allows more for today: the next start goes through.
  await page.getByRole('button', { name: 'Allow $5 more today', exact: true }).click();
  await expect.poll(async () => (await view()).unattended?.tripped, { timeout: 10_000 }).toEqual([]);
  await act({ action: 'routine_set', botId, name: 'Later', schedule: { kind: 'once', at: Date.now() + 3_000 }, prompt: TASK });
  await expect.poll(() => inputs(stack, 'chief').some(input => input.kind === 'routine' && input.name === 'Later'), { timeout: 25_000 }).toBe(true);
  await expect.poll(async () => (await runs('Later'))[0]?.state, { timeout: 30_000 }).toBe('done');

  // Pausing all unattended work holds the next start; Test still goes through.
  await page.getByRole('switch', { name: 'Pause all unattended work', exact: true }).click();
  await expect.poll(async () => (await view()).unattended?.settings.paused, { timeout: 10_000 }).toBe(true);
  await act({ action: 'routine_set', botId, name: 'Held', schedule: { kind: 'once', at: Date.now() + 3_000 }, prompt: TASK });
  await expect.poll(async () => (await runs('Held'))[0], { timeout: 20_000 }).toMatchObject({ state: 'skipped', reason: 'paused' });
  expect(inputs(stack, 'chief').filter(input => input.kind === 'routine' && input.name === 'Held')).toEqual([]);
  await act({ action: 'routine_test', botId, name: 'Overnight' });
  await expect.poll(() => inputs(stack, 'chief').filter(input => input.kind === 'routine' && input.name === 'Overnight').length, { timeout: 20_000 }).toBe(2);
  await context.close();
});
