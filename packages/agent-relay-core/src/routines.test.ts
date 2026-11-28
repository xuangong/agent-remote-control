import { describe, expect, it } from 'vitest';
import { isTeam, parseTaskInputs, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { WAITING_QUIET_MS, WORK_QUIET_MS } from './routines.js';
import { committed, detached } from './drafts.js';

// A standing bot keeps routines on its inbox; open board items give it a quiet one by default. Groups and Hosts are stubs; the broker and its timers are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } }) as unknown as WindowGroup;

function fixture(brokenSeats = false) {
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
    tasks: { capable: () => true, assertHost: () => { if (brokenSeats) throw new Error('This Host cannot start sub-sessions.'); } },
    assistants: { groups: () => groups, capable: () => true },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  const inbox = (botId = ids.chief) => state.find(team => team.inbox?.botId === botId)!;
  const routineInputs = () => inbox().messages.flatMap(message => parseTaskInputs(message.text) ?? []).filter(input => input.kind === 'routine');
  // The bot read everything queued for it.
  const read = () => { state = committed.produce(state, draft => { for (const team of draft) if (team.inbox?.botId === ids.chief) for (const message of team.messages) { message.status = 'accepted'; message.acceptance = 'handled'; if (message.chain) team.members[0]!.chain = { id: message.chain, at: now }; } }); };
  // What was queued for the sub-sessions reached them and started their turns.
  const settleSubs = () => { state = committed.produce(state, draft => { for (const team of draft) if (team.task) for (const message of team.messages) if (message.status === 'queued') { message.status = 'accepted'; message.acceptance = 'started'; } }); };
  return { broker, as, inbox, routineInputs, read, fire, state: () => state, settleSubs, advance: (ms: number) => { now += ms; } };
}
const everyTen = { kind: 'every', minutes: 10 } as const;
describe('a standing bot\'s routines', () => {
  it('ends a routine by itself after until_minutes: it wakes the bot until then, and is dropped without a wake once the end has passed', async () => {
    const f = fixture();
    expect(await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Check in', schedule: { kind: 'quiet', minutes: 10 }, untilMinutes: 25 }))
      .toEqual({ routines: [expect.objectContaining({ name: 'Check in', schedule: { kind: 'quiet', minutes: 10 }, endsAt: 1_000_000 + 25 * 60_000, by: 'bot' })] });
    f.read();
    f.advance(600_000); await f.fire();
    expect(f.routineInputs()).toHaveLength(1);
    f.read();
    f.advance(600_000); await f.fire();
    expect(f.routineInputs()).toHaveLength(1);
    f.read();
    // The tick at 30 min falls after the end at 25: the routine is dropped and nothing wakes the bot.
    f.advance(600_000); await f.fire();
    expect(f.routineInputs()).toEqual([]);
    expect(f.inbox().inbox!.routines).toEqual([]);
  });
  it('keeps the sub-sessions a bot holds on its quiet routine\'s frame, with how long each has been idle and what it last did, and not a person\'s side', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Release notes', status: 'working' }] });
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'a', name: 'Collect logs', prompt: 'Collect them.' });
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'b', name: 'Run tests', prompt: 'Run them.' });
    await f.broker.startBot({ operationId: 'side', source: { hostId: 'mac', providerId: 'claude', nativeSessionId: 'chief', title: 'Chief' }, bot: { name: 'Look it up', mission: 'What?' } });
    f.settleSubs();
    const [first, second] = [0, 1].map(index => f.state().filter(team => team.task)[index]!);
    await f.broker.hostCall('mac', { action: 'sub_turn_end', teamId: first.id, memberId: first.members[0]!.id, outcome: 'finished', text: 'Logs saved.' });
    await f.broker.hostCall('mac', { action: 'sub_update', owner: f.as(second.members[0]!.nativeSessionId!), currentStep: 'Reading the suite' });
    f.read();
    f.advance(WORK_QUIET_MS + 3 * 3_600_000); await f.fire();
    const [routine] = f.routineInputs();
    expect(routine).toMatchObject({ kind: 'routine', name: 'work', quiet: true });
    const lines = (routine as { body: string }).body.split('\n');
    expect(lines).toContain('Sub-session "Collect logs" · idle 3 h · last: Collect logs');
    expect(lines).toContain('Sub-session "Run tests" · working · last: Run tests · now: Reading the suite');
    expect(lines.some(line => line.includes('Look it up'))).toBe(false);
  });
  it('keeps a quiet routine that reminds the bot of its open board items, which list_bots shows', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Release notes', status: 'working' }] });
    expect(isTeam(f.inbox())).toBe(true);
    f.read();
    f.advance(WORK_QUIET_MS - 1); await f.fire();
    expect(f.routineInputs()).toEqual([]);
    f.advance(1); await f.fire();
    expect(f.routineInputs()).toEqual([expect.objectContaining({ name: 'work', body: 'Release notes · working' })]);
    // The run starts a chain of its own at the bot, and the routine keeps it.
    expect(f.broker.chains.list()).toEqual([expect.objectContaining({ cause: 'routine', bot: ids.chief, messages: 1 })]);
    expect(f.inbox().messages.at(-1)!.chain).toBe(f.broker.chains.list()[0]!.id);
    expect(f.inbox().inbox!.routines![0]!.runs).toEqual([expect.objectContaining({ n: 1, state: 'waiting', chain: f.broker.chains.list()[0]!.id })]);
    // While the reminder still waits for the bot, the routine only waits again.
    f.advance(WORK_QUIET_MS); await f.fire();
    expect(f.routineInputs()).toHaveLength(1);
    f.read(); f.advance(WORK_QUIET_MS); await f.fire();
    expect(f.inbox().messages.filter(message => message.status === 'queued').flatMap(message => parseTaskInputs(message.text) ?? [])).toEqual([expect.objectContaining({ kind: 'routine', name: 'work' })]);
  });
  it('pushes a quiet routine back with every message, waits longer while the work waits, and drops it once the work is done', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Release notes' }] });
    f.advance(WORK_QUIET_MS - 1);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'm1', to: 'Chief', text: 'Build is green.' });
    f.read(); f.advance(2); await f.fire();
    expect(f.routineInputs()).toEqual([]);
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ key: 1, version: 1, status: 'waiting' }] });
    expect(f.inbox().inbox!.routines).toEqual([expect.objectContaining({ name: 'work', schedule: { kind: 'quiet', minutes: WAITING_QUIET_MS / 60_000 }, work: true, by: 'system' })]);
    expect(await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ key: 1, version: 2, status: 'done', result: 'Published.' }] })).toMatchObject({ items: [{ key: 1, version: 3 }] });
    expect(f.inbox().inbox!.routines).toEqual([]);
    f.advance(WAITING_QUIET_MS); await f.fire();
    expect(f.routineInputs()).toEqual([]);
  });
  it('runs a clock routine with its prompt in a chain of its own, whatever else reaches the bot, and keeps the run', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Morning check', schedule: everyTen, prompt: 'Summarise the overnight failures.' });
    f.read();
    // A message to the bot pushes only quiet routines back.
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'm1', to: 'Chief', text: 'Build is green.' });
    f.read(); f.advance(600_000); await f.fire();
    expect(f.routineInputs()).toEqual([expect.objectContaining({ name: 'Morning check', quiet: false, detail: expect.stringContaining('run 1'), body: 'Summarise the overnight failures.' })]);
    expect(f.broker.chains.list().filter(chain => chain.cause === 'routine')).toHaveLength(1);
    // The bot's first turn in the run's chain ends: the run is done.
    const chain = f.inbox().inbox!.routines![0]!.runs[0]!.chain!;
    f.read();
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('chief'), cause: { kind: 'framed' }, tokens: 10 });
    expect(f.broker.routines('b_' + '1'.repeat(32))[0]!.runs[0]).toMatchObject({ state: 'done', chain });
  });
  it('counts due times that pass while a run still waits as missed, and delivers one run that says how many', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Morning check', schedule: everyTen, prompt: 'Look.' });
    f.read();
    // The bot's Host is away: the first run waits, and three more due times pass.
    f.advance(600_000); await f.fire();
    for (let tick = 0; tick < 3; tick++) { f.advance(600_000); await f.fire(); }
    const queued = f.inbox().messages.filter(message => message.status === 'queued' && parseTaskInputs(message.text)?.[0]?.kind === 'routine');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.text).toContain('3 earlier runs were missed');
    expect(f.inbox().inbox!.routines![0]!.runs).toEqual([expect.objectContaining({ n: 1, state: 'waiting', missed: 3 })]);
  });
  it('skips a due time while the bot is still working on the run, and records why', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Morning check', schedule: everyTen });
    f.read();
    f.advance(600_000); await f.fire();
    f.read();
    f.advance(600_000); await f.fire();
    expect(f.inbox().inbox!.routines![0]!.runs).toEqual([expect.objectContaining({ n: 1, state: 'running' }), expect.objectContaining({ n: 2, state: 'skipped', reason: 'overlap' })]);
  });
  it('stops a routine at its own runs per day, runs a once routine one time, and keeps its history to the last twenty', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Limited', schedule: { kind: 'every', minutes: 5 }, maxRunsPerDay: 2 });
    for (let tick = 0; tick < 4; tick++) { f.advance(300_000); await f.fire(); f.read(); await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('chief'), cause: { kind: 'framed' }, tokens: 1 }); }
    expect(f.inbox().inbox!.routines![0]!.runs.map(run => run.state === 'skipped' ? run.reason : run.state)).toEqual(['done', 'done', 'daily limit', 'daily limit']);
    const once = fixture();
    await once.broker.hostCall('mac', { action: 'set_routine', owner: once.as('chief'), name: 'Once', schedule: { kind: 'once', at: 1_000_000 + 60_000 } });
    once.read(); once.advance(60_000); await once.fire();
    expect(once.routineInputs()).toHaveLength(1);
    once.read(); once.advance(3_600_000); await once.fire();
    expect(once.routineInputs()).toHaveLength(1);
    expect(once.inbox().inbox!.routines![0]).toMatchObject({ finished: true });
    const past = fixture();
    await expect(past.broker.hostCall('mac', { action: 'set_routine', owner: past.as('chief'), name: 'Past', schedule: { kind: 'once', at: 1 } })).rejects.toThrow('future');
    const long = fixture();
    await long.broker.hostCall('mac', { action: 'set_routine', owner: long.as('chief'), name: 'Often', schedule: { kind: 'every', minutes: 5 } });
    for (let tick = 0; tick < 25; tick++) { long.read(); long.advance(300_000); await long.fire(); }
    expect(long.inbox().inbox!.routines![0]!.runs).toHaveLength(20);
    expect(long.inbox().inbox!.routines![0]!.runs.at(-1)).toMatchObject({ n: 25 });
  });
  it('pauses and deletes a routine, and refuses the work routine, the event kind, and another bot\'s name', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Often', schedule: everyTen });
    await f.broker.hostCall('mac', { action: 'pause_routine', owner: f.as('chief'), name: 'Often', paused: true });
    f.read(); f.advance(1_200_000); await f.fire();
    expect(f.routineInputs()).toEqual([]);
    await f.broker.hostCall('mac', { action: 'pause_routine', owner: f.as('chief'), name: 'Often', paused: false });
    f.advance(600_000); await f.fire();
    expect(f.routineInputs()).toHaveLength(1);
    expect(await f.broker.hostCall('mac', { action: 'delete_routine', owner: f.as('chief'), name: 'Often' })).toEqual({ routines: [] });
    await expect(f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'work', schedule: everyTen })).rejects.toThrow('work routine');
    await expect(f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Hook', schedule: { kind: 'event' } })).rejects.toThrow('person');
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', prompt: 'Review it.' });
    await expect(f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('worker-1'), name: 'Often', schedule: everyTen })).rejects.toThrow('not a bot');
  });
  it('lets a bot in a chain a routine started pause and delete routines but set none', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Often', schedule: everyTen });
    f.read(); f.advance(600_000); await f.fire();
    // The bot reads the run's frame, so its next calls are made in the routine's chain.
    f.read();
    await expect(f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'More', schedule: everyTen, cause: { kind: 'framed' } })).rejects.toThrow('cannot set routines');
    expect(await f.broker.hostCall('mac', { action: 'pause_routine', owner: f.as('chief'), name: 'Often', paused: true })).toMatchObject({ routines: [expect.objectContaining({ paused: true })] });
    expect(await f.broker.hostCall('mac', { action: 'delete_routine', owner: f.as('chief'), name: 'Often' })).toEqual({ routines: [] });
  });
  it('runs a test of a routine now, whatever its schedule says, and refuses it while a run is active', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Often', schedule: { kind: 'daily', time: '08:30' } });
    await f.broker.hostCall('mac', { action: 'pause_routine', owner: f.as('chief'), name: 'Often', paused: true });
    expect(await f.broker.routineTest(ids.chief, 'Often')).toEqual({ run: 1 });
    expect(f.routineInputs()).toEqual([expect.objectContaining({ name: 'Often', detail: expect.stringContaining('test') })]);
    await expect(f.broker.routineTest(ids.chief, 'Often')).rejects.toThrow('still active');
  });
  it('refuses new starts once the budget is spent, lets the run that spent it finish, and shows what it cost', async () => {
    const f = fixture();
    await f.broker.chainAction({ action: 'set_unattended', patch: { budget: { perDay: 1 } } });
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Often', schedule: everyTen });
    f.advance(600_000); await f.fire(); f.read();
    // The run's turn costs about $18 on Sonnet: one million input and one million output tokens. The cap is $1, and the run is done all the same.
    await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('chief'), cause: { kind: 'framed' }, tokens: 2_000_000, usage: { model: 'sonnet', input: 1_000_000, output: 1_000_000, cacheCreation: 0, cachedInput: 0 } });
    expect(f.broker.routines(ids.chief)[0]!.runs[0]).toMatchObject({ state: 'done', usd: 18, tokens: 2_000_000 });
    expect(f.broker.chains.list()[0]!.usage).toMatchObject({ estimatedUsd: 18 });
    f.advance(600_000); await f.fire();
    expect(f.inbox().inbox!.routines![0]!.runs.at(-1)).toMatchObject({ state: 'skipped', reason: 'budget' });
    expect(f.broker.chainView().unattended).toMatchObject({ today: { usd: 18 }, tripped: [{ scope: 'account', period: 'day' }] });
    // The person raises today's cap, and the next due time starts a run.
    await f.broker.chainAction({ action: 'set_unattended', patch: { allowMoreToday: 20 } });
    f.read(); f.advance(600_000); await f.fire();
    expect(f.inbox().inbox!.routines![0]!.runs.at(-1)).toMatchObject({ state: 'waiting' });
  });
  it('holds every unattended start while the person paused unattended work or the provider reported its usage limit, and still tests', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Often', schedule: everyTen });
    await f.broker.chainAction({ action: 'set_unattended', patch: { paused: true } });
    f.advance(600_000); await f.fire();
    expect(f.inbox().inbox!.routines![0]!.runs.at(-1)).toMatchObject({ state: 'skipped', reason: 'paused' });
    await f.broker.chainAction({ action: 'set_unattended', patch: { paused: false } });
    await f.broker.hostCall('mac', { action: 'provider_limit', owner: f.as('chief'), resetsAt: 1_000_000 + 3 * 3_600_000 });
    f.advance(600_000); await f.fire();
    expect(f.inbox().inbox!.routines![0]!.runs.at(-1)).toMatchObject({ state: 'skipped', reason: 'provider limit' });
    expect(f.broker.chainView().unattended!.limits).toEqual([{ provider: 'mac/claude', resetsAt: 1_000_000 + 3 * 3_600_000 }]);
    expect(await f.broker.routineTest(ids.chief, 'Often')).toEqual({ run: 3 });
    // The test run ends, the window ends, and the next due time starts again.
    f.read(); await f.broker.hostCall('mac', { action: 'chain_turn', owner: f.as('chief'), cause: { kind: 'framed' }, tokens: 1 });
    f.advance(3 * 3_600_000); await f.fire();
    expect(f.inbox().inbox!.routines![0]!.runs.at(-1)).toMatchObject({ state: 'waiting' });
  });
  it('sends a run that names another model to a sub-session of that model, never switching the bot\'s own session, and ends the run with the sub-session\'s turn', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Cheap check', schedule: everyTen, prompt: 'Summarise the overnight failures.', model: 'claude-haiku-4-5' });
    f.read(); f.advance(600_000); await f.fire();
    // Nothing is queued for the bot's own session; a sub-session of the bot works on the prompt with the named model.
    expect(f.routineInputs()).toEqual([]);
    const [sub] = f.state().filter(team => team.task);
    expect(sub!.members[0]).toMatchObject({ role: 'leader', model: 'claude-haiku-4-5' });
    expect(sub!.task!.brief).toContain('Summarise the overnight failures.');
    expect(sub!.task!.brief).toContain('[Routine "Cheap check"');
    const run = f.broker.routines(ids.chief)[0]!.runs[0]!;
    expect(run).toMatchObject({ state: 'running', model: 'claude-haiku-4-5', chain: f.broker.chains.list().find(chain => chain.cause === 'routine')!.id });
    expect(f.broker.chains.list().find(chain => chain.cause === 'routine')).toMatchObject({ subSessions: 1 });
    // The sub-session's turn ends: the run is done, or failed when the turn failed.
    f.settleSubs();
    await f.broker.hostCall('mac', { action: 'sub_turn_end', teamId: sub!.id, memberId: sub!.members[0]!.id, outcome: 'finished', text: 'Nothing failed overnight.',
      tokens: 1_100_000, usage: { model: 'claude-haiku-4-5', input: 1_000_000, output: 100_000, cacheCreation: 0, cachedInput: 0 } });
    // The run is priced by the sub-session's model (Haiku: $1 per million input, $5 per million output), and counts in the unattended usage.
    expect(f.broker.routines(ids.chief)[0]!.runs[0]).toMatchObject({ state: 'done', usd: 1.5, tokens: 1_100_000 });
    expect(f.broker.chainView().unattended!.today.usd).toBeCloseTo(1.5, 6);
    expect(f.state().find(team => team.task)!.task!.state).toBe('ended');
  });
  it('ends a run as failed, with the reason, when its sub-session cannot start', async () => {
    const f = fixture(true);
    await f.broker.hostCall('mac', { action: 'set_routine', owner: f.as('chief'), name: 'Cheap check', schedule: everyTen, model: 'claude-haiku-4-5' });
    f.read(); f.advance(600_000); await f.fire();
    expect(f.broker.routines(ids.chief)[0]!.runs[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('cannot start sub-sessions') });
  });
});
