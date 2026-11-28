import { describe, expect, it } from 'vitest';
import { isTeam, parseTaskInputs, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { WAITING_TIMER_MS, WORK_TIMER_MS } from './bot-work.js';
import { committed, detached } from './drafts.js';

// A standing bot keeps quiet timers on its inbox; open board items give it a default one. Groups and Hosts are stubs; the broker and its timers are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 1_000_000, workers = 0;
  const timers = new Map<number, { at: number; run: () => void }>(); let next = 0;
  const scheduler = { setTimeout: (run: () => void, delayMs: number) => { timers.set(++next, { at: now + delayMs, run }); return next; }, clearTimeout: (id: unknown) => { timers.delete(id as number); } };
  const fire = async () => { for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const groups = [group()];
  const broker = new TeamBroker({ scheduler,
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => now, assertHost: () => {},
    // Drafts as the Relay's state makes them, so what a change returns is detached as there.
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  const inbox = (botId = ids.chief) => state.find(team => team.inbox?.botId === botId)!;
  const timerInputs = () => inbox().messages.flatMap(message => parseTaskInputs(message.text) ?? []).filter(input => input.kind === 'timer');
  // The bot read everything queued for it.
  const read = () => { state = committed.produce(state, draft => { for (const team of draft) if (team.inbox?.botId === ids.chief) for (const message of team.messages) { message.status = 'accepted'; message.acceptance = 'handled'; } }); };
  // What was queued for the sub-sessions reached them and started their turns.
  const settleSubs = () => { state = committed.produce(state, draft => { for (const team of draft) if (team.task) for (const message of team.messages) if (message.status === 'queued') { message.status = 'accepted'; message.acceptance = 'started'; } }); };
  return { broker, as, inbox, timerInputs, read, fire, state: () => state, settleSubs, advance: (ms: number) => { now += ms; } };
}
describe('a standing bot\'s timers', () => {
  it('ends a timer by itself after until_minutes: it wakes the bot until then, and is dropped without a wake once the end has passed', async () => {
    const f = fixture();
    expect(await f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'Check in', minutes: 10, untilMinutes: 25 }))
      .toEqual({ timers: [expect.objectContaining({ name: 'Check in', intervalMs: 600_000, endsAt: 1_000_000 + 25 * 60_000 })] });
    // The bot reads each wake before the next tick; read messages leave the inbox.
    f.read();
    f.advance(600_000); await f.fire();
    expect(f.timerInputs()).toHaveLength(1);
    f.read();
    f.advance(600_000); await f.fire();
    expect(f.timerInputs()).toHaveLength(1);
    f.read();
    // The tick at 30 min falls after the end at 25: the timer is dropped and nothing wakes the bot.
    f.advance(600_000); await f.fire();
    expect(f.timerInputs()).toEqual([]);
    expect(f.inbox().inbox!.timers).toEqual([]);
  });
  it('keeps a timer without until_minutes, and refuses an end on a clear', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'Open', minutes: 10 });
    expect(f.inbox().inbox!.timers![0]).not.toHaveProperty('endsAt');
    await expect(f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'Open', minutes: 0, untilMinutes: 5 })).rejects.toThrow('until_minutes');
  });
  it('lists the sub-sessions a bot holds on its due timer, with how long each has been idle and what it last did, and not a person\'s side', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Release notes', status: 'working' }] });
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'a', name: 'Collect logs', prompt: 'Collect them.' });
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'b', name: 'Run tests', prompt: 'Run them.' });
    await f.broker.startBot({ operationId: 'side', source: { hostId: 'mac', providerId: 'claude', nativeSessionId: 'chief', title: 'Chief' }, bot: { name: 'Look it up', mission: 'What?' } });
    f.settleSubs();
    // The first one finished its turn and sits idle; the second still works and says what it does.
    const [first, second] = [0, 1].map(index => state_(f).filter(team => team.task)[index]!);
    await f.broker.hostCall('mac', { action: 'sub_turn_end', teamId: first.id, memberId: first.members[0]!.id, outcome: 'finished', text: 'Logs saved.' });
    await f.broker.hostCall('mac', { action: 'sub_update', owner: f.as(second.members[0]!.nativeSessionId!), currentStep: 'Reading the suite' });
    f.read();
    f.advance(WORK_TIMER_MS + 3 * 3_600_000); await f.fire();
    const [timer] = f.timerInputs();
    expect(timer).toMatchObject({ kind: 'timer', name: 'work' });
    const lines = (timer as { body: string }).body.split('\n');
    expect(lines).toContain('Sub-session "Collect logs" · idle 3 h · last: Collect logs');
    expect(lines).toContain('Sub-session "Run tests" · working · last: Run tests · now: Reading the suite');
    expect(lines.some(line => line.includes('Look it up'))).toBe(false);
  });

  it('keeps a quiet timer that reminds the bot of its open board items, which list_bots shows', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Release notes', status: 'working' }] });
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ key: 1, version: 1, status: 'waiting' }] });
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ key: 1, version: 2, status: 'working' }] });
    expect(await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('chief') })).toMatchObject({ board: { open: 1, items: [expect.objectContaining({ key: 1, title: 'Release notes', status: 'working' })] } });
    expect(isTeam(f.inbox())).toBe(true);
    // The bot read its standing instructions, so nothing is on its way to it.
    f.read();
    f.advance(WORK_TIMER_MS - 1); await f.fire();
    expect(f.timerInputs()).toEqual([]);
    f.advance(1); await f.fire();
    expect(f.timerInputs()).toEqual([expect.objectContaining({ name: 'work', body: 'Release notes · working' })]);
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
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Release notes' }] });
    f.advance(WORK_TIMER_MS - 1);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'm1', to: 'Chief', text: 'Build is green.' });
    f.read(); f.advance(2); await f.fire();
    expect(f.timerInputs()).toEqual([]);
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ key: 1, version: 1, status: 'waiting' }] });
    expect(f.inbox().inbox!.timers).toEqual([expect.objectContaining({ name: 'work', intervalMs: WAITING_TIMER_MS })]);
    expect(await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ key: 1, version: 2, status: 'done', result: 'Published.' }] })).toMatchObject({ items: [{ key: 1, version: 3 }] });
    expect(f.inbox().inbox!.timers).toEqual([]);
    f.advance(WAITING_TIMER_MS); await f.fire();
    expect(f.timerInputs()).toEqual([]);
  });

  it('sets and clears named timers, and refuses them to a sub-session', async () => {
    const f = fixture();
    expect(await f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'Check CI', minutes: 10 })).toEqual({ timers: [expect.objectContaining({ name: 'Check CI', intervalMs: 600_000 })] });
    f.read();
    f.advance(600_000); await f.fire();
    expect(f.timerInputs()).toEqual([expect.objectContaining({ name: 'Check CI', body: '' })]);
    expect(await f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'Check CI', minutes: 0 })).toEqual({ timers: [] });
    await expect(f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('chief'), name: 'work', minutes: 10 })).rejects.toThrow('work timer');
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', prompt: 'Review it.' });
    await expect(f.broker.hostCall('mac', { action: 'set_timer', owner: f.as('worker-1'), name: 'Check CI', minutes: 5 })).rejects.toThrow('not a bot');
  });
});

const state_ = (f: ReturnType<typeof fixture>) => f.state();
