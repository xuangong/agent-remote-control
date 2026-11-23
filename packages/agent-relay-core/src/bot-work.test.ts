import { describe, expect, it } from 'vitest';
import { isTeam, parseTaskInputs, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { WAITING_TIMER_MS, WORK_TIMER_MS } from './bot-work.js';

// A standing bot keeps work items and quiet timers on its inbox. Groups and Hosts are stubs; the broker and its timers are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 1_000_000;
  const timers = new Map<number, { at: number; run: () => void }>(); let next = 0;
  const scheduler = { setTimeout: (run: () => void, delayMs: number) => { timers.set(++next, { at: now + delayMs, run }); return next; }, clearTimeout: (id: unknown) => { timers.delete(id as number); } };
  const fire = async () => { for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const groups = [group()];
  const broker = new TeamBroker({ scheduler,
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => now, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: 'worker-1' }) }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  const inbox = (botId = ids.chief) => state.find(team => team.inbox?.botId === botId)!;
  const timerInputs = () => inbox().messages.flatMap(message => parseTaskInputs(message.text) ?? []).filter(input => input.kind === 'timer');
  // The bot read everything queued for it.
  const read = () => { for (const message of inbox().messages) message.status = 'delivered'; };
  return { broker, as, inbox, timerInputs, read, fire, advance: (ms: number) => { now += ms; } };
}
type Item = { id: string; phase: string };

describe('a standing bot\'s work items and timers', () => {
  it('keeps work items that list_bots shows, and a quiet timer that reminds the bot of its open work', async () => {
    const f = fixture();
    const item = await f.broker.hostCall('mac', { action: 'update_work', owner: f.as('chief'), title: 'Release notes', summary: 'Collecting the changes.', phase: 'in_progress', next: 'Ask Tracker for the build.' }) as Item;
    expect(item).toMatchObject({ id: expect.stringMatching(/^w_[0-9a-f]{12}$/), phase: 'in_progress' });
    expect(await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('chief') })).toMatchObject({ work: [expect.objectContaining({ title: 'Release notes', next: 'Ask Tracker for the build.' })] });
    expect(isTeam(f.inbox())).toBe(true);
    // The bot read its standing instructions, so nothing is on its way to it.
    f.read();
    f.advance(WORK_TIMER_MS - 1); await f.fire();
    expect(f.timerInputs()).toEqual([]);
    f.advance(1); await f.fire();
    expect(f.timerInputs()).toEqual([expect.objectContaining({ name: 'work', body: 'Release notes · in_progress · next: Ask Tracker for the build.' })]);
    // The reminder starts a chain of its own at the bot.
    expect(f.broker.chains.list()).toEqual([expect.objectContaining({ cause: 'timer', bot: ids.chief, messages: 1 })]);
    expect(f.inbox().messages.at(-1)!.chain).toBe(f.broker.chains.list()[0]!.id);
    // While the reminder still waits for the bot, the timer only waits again.
    f.advance(WORK_TIMER_MS); await f.fire();
    expect(f.timerInputs()).toHaveLength(1);
    // Once the bot has read it, the next quiet interval reminds it again.
    f.read(); f.advance(WORK_TIMER_MS); await f.fire();
    expect(f.inbox().messages.filter(message => message.status === 'queued').flatMap(message => parseTaskInputs(message.text) ?? [])).toEqual([expect.objectContaining({ kind: 'timer', name: 'work' })]);
  });

  it('pushes the timer back with every message, waits longer while the work waits, and drops it once the work is done', async () => {
    const f = fixture();
    const item = await f.broker.hostCall('mac', { action: 'update_work', owner: f.as('chief'), title: 'Release notes', summary: 'Collecting.' }) as Item;
    f.advance(WORK_TIMER_MS - 1);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'm1', to: 'Chief', text: 'Build is green.' });
    f.read(); f.advance(2); await f.fire();
    expect(f.timerInputs()).toEqual([]);
    await f.broker.hostCall('mac', { action: 'update_work', owner: f.as('chief'), work: item.id, phase: 'waiting', summary: 'Waiting for the person to approve.' });
    expect(f.inbox().inbox!.timers).toEqual([expect.objectContaining({ name: 'work', intervalMs: WAITING_TIMER_MS })]);
    expect(await f.broker.hostCall('mac', { action: 'complete_work', owner: f.as('chief'), work: item.id, summary: 'Published.' })).toMatchObject({ phase: 'done', summary: 'Published.' });
    expect(f.inbox().inbox!.timers).toEqual([]);
    f.advance(WAITING_TIMER_MS); await f.fire();
    expect(f.timerInputs()).toEqual([]);
  });

  it('sets and clears named timers, and refuses work items to a temporary bot', async () => {
    const f = fixture();
    expect(await f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'Check CI', minutes: 10 })).toEqual({ timers: [expect.objectContaining({ name: 'Check CI', intervalMs: 600_000 })] });
    f.read();
    f.advance(600_000); await f.fire();
    expect(f.timerInputs()).toEqual([expect.objectContaining({ name: 'Check CI', body: '' })]);
    expect(await f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'Check CI', minutes: 0 })).toEqual({ timers: [] });
    await expect(f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'work', minutes: 10 })).rejects.toThrow('work timer');
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    await expect(f.broker.hostCall('mac', { action: 'update_work', owner: f.as('worker-1'), title: 'Review', summary: 'Reading.' })).rejects.toThrow('temporary bot');
  });
});
