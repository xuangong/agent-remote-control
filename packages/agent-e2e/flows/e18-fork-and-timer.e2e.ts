// E18, a sub-session started from its bot's conversation, and a timer that ends by itself: the real page, Relay and Controller, with scripted
// sessions that take tools. A flow calls a bot's tool in its model's place (`useTool`); the fork is read from the bot's real session timeline.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { hasTools as hasToolsOf, team as teamOf } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, tools: true,
    turns: text => text.includes('Summarise the plan.') ? [{ reply: 'Plan summarised.' }] : undefined,
    sessions: { chief: { title: 'Chief', history: [
      { role: 'user', text: 'We pick Postgres for the ledger.' }, { role: 'assistant', text: 'Postgres it is.' },
      { role: 'user', text: 'The deadline is Friday.' }, { role: 'assistant', text: 'Friday noted.' },
      { role: 'user', text: 'Ship the report.' }, { role: 'assistant', text: 'Shipping it.' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E18: a sub-session forked with fork_turns 2 is given those turns and no older one', async () => {
  const { context } = await openPage(browser, stack.sessionUrl('chief'));
  await teamOf(stack, context);
  await hasToolsOf(stack, 'chief');
  const created = await stack.provider.useTool('chief', 'create_sub_session', { name: 'Plan', prompt: 'Summarise the plan.', fork_from: 'main', fork_turns: 2 }) as { message: string; sub_session_id: string };
  expect(created.message).toContain('last 2 turns of your conversation');
  const worker = () => stack.provider.known().find(id => id.includes('-new-'))!;
  await expect.poll(() => stack.provider.session(worker())?.sent.join('\n') ?? '', { timeout: 20_000 }).toContain('Summarise the plan.');
  const brief = stack.provider.session(worker())!.sent.join('\n');
  expect(brief).toContain('The deadline is Friday.'); expect(brief).toContain('Shipping it.');
  expect(brief).not.toContain('We pick Postgres');
  // The sub-session is recorded as forked, and the context sits before the work.
  expect(brief.indexOf('Friday noted.')).toBeLessThan(brief.indexOf('Summarise the plan.'));
  const status = await stack.provider.useTool('chief', 'get_sub_session_status', {}) as { sub_sessions: Array<{ name: string }> };
  expect(status.sub_sessions.map(item => item.name)).toEqual(['Plan']);
  await context.close();
});

it('E18: fork_from without fork_turns is refused, and nothing starts', async () => {
  const known = stack.provider.known().length;
  await expect(stack.provider.useTool('chief', 'create_sub_session', { name: 'Again', prompt: 'Summarise the plan.', fork_from: 'main' })).rejects.toThrow('fork_turns');
  expect(stack.provider.known().length).toBe(known);
});

it('E18: a timer set with until_minutes ends at that time, and one without runs on', async () => {
  const before = Date.now();
  const set = await stack.provider.useTool('chief', 'set_timer', { name: 'Check in', minutes: 5, until_minutes: 30 }) as { timers: Array<{ name: string; endsAt?: number }> };
  const ends = set.timers.find(timer => timer.name === 'Check in')!.endsAt!;
  expect(ends).toBeGreaterThanOrEqual(before + 30 * 60_000); expect(ends).toBeLessThan(Date.now() + 30 * 60_000 + 1);
  const open = await stack.provider.useTool('chief', 'set_timer', { name: 'Open', minutes: 10 }) as { timers: Array<{ name: string; endsAt?: number }> };
  expect(open.timers.find(timer => timer.name === 'Open')).not.toHaveProperty('endsAt');
  await expect(stack.provider.useTool('chief', 'set_timer', { name: 'Open', minutes: 0, until_minutes: 5 })).rejects.toThrow('until_minutes');
  await stack.provider.useTool('chief', 'set_timer', { name: 'Check in', minutes: 0 });
});
