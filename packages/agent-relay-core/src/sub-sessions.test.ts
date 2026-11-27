import { describe, expect, it } from 'vitest';
import { isTeam, parseTaskInputs, SUB_SESSION_LIVE_LIMIT, type TaskView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { committed, detached } from './drafts.js';
import { validSavedTeam, type SavedTeam } from './team-delivery.js';
import { subSessionId } from './chain-scope.js';

// A bot starts sub-sessions of its own. The groups and the Host are stubs; the broker, the sub-session records, the board and their validation are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = (bots = ['chief', 'tracker']) => ({ window: { id: 'g', title: 'g', revision: 1, views: bots.map(nativeSessionId => ({ id: `v-${nativeSessionId}`, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: Object.fromEntries(bots.map(name => [`v-${name}`, { botId: ids[name as keyof typeof ids], name: name === 'chief' ? 'Chief' : 'Tracker' }])) } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 100;
  let groups = [group()];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', nativeSessionId: seat.member.nativeSessionId ?? `worker-${seat.member.id}` }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'codex', nativeSessionId });
  const subs = () => state.filter(team => team.task);
  const sub = (index = 0) => subs()[index]!;
  const worker = (index = 0) => as(sub(index).members[0]!.nativeSessionId!);
  const inputs = (team: SavedTeam, to: number) => team.messages.filter(message => message.to === team.members[to]!.id).flatMap(message => parseTaskInputs(message.text) ?? []);
  const call = (owner: ReturnType<typeof as>, action: string, extra: Record<string, unknown> = {}) => broker.hostCall('mac', { action, owner, ...extra } as never) as Promise<Record<string, any>>;
  const start = (name = 'Collect logs', extra: Record<string, unknown> = {}) => call(as('chief'), 'create_sub_session', { operationId: `op-${name}`, name, prompt: `Do ${name}.`, ...extra });
  const end = (index = 0, outcome = 'finished', text?: string) => broker.hostCall('mac', { action: 'sub_turn_end', teamId: sub(index).id, memberId: sub(index).members[0]!.id, outcome, ...(text ? { text } : {}) } as never);
  /** Everything queued so far reached its seat and started its turn. */
  const settle = () => { state = state.map(team => ({ ...team, messages: team.messages.map(message => message.status === 'queued' ? { ...message, status: 'accepted' as const, acceptance: 'started' as const } : message) })); };
  return { broker, as, sub, subs, worker, inputs, call, start, end, settle, state: () => state, retire: () => { groups = [group(['tracker'])]; } };
}

describe('sub-sessions of a bot', () => {
  it('starts as a Team of a new session and its bot, and queues the framed first work that tells it how to report', async () => {
    const f = fixture();
    const created = await f.start() as { sub_session_id: string; status: string };
    expect(created.status).toBe('working');
    expect(created.sub_session_id).toBe(subSessionId(f.sub().id));
    expect(isTeam(f.sub()) && validSavedTeam(f.sub())).toBe(true);
    expect(f.sub().task).toMatchObject({ title: 'Collect logs', state: 'working', lastWork: { title: 'Collect logs' } });
    expect(f.sub().members.map(member => [member.role, member.creation])).toEqual([['leader', 'ready'], ['requester', 'ready']]);
    expect(f.inputs(f.sub(), 0)).toEqual([expect.objectContaining({ kind: 'brief', title: 'Collect logs', brief: 'Do Collect logs.' })]);
    expect(f.sub().messages[0]!.text).toContain('communicate_update');
    // A repeated operation is the same sub-session; other input under its identity is refused.
    expect(await f.start()).toMatchObject({ sub_session_id: created.sub_session_id });
    expect(f.subs()).toHaveLength(1);
    await expect(f.start('Collect logs', { prompt: 'Something else.' })).rejects.toThrow('different input');
  });

  it('is no bot: other bots do not list, reach or read it, and it messages no one', async () => {
    const f = fixture();
    const { sub_session_id: id } = await f.start() as { sub_session_id: string };
    const listed = await f.call(f.as('tracker'), 'list_bots') as { bots: Array<{ id: string }> };
    expect(listed.bots.map(bot => bot.id)).toEqual([ids.chief]);
    expect(await f.call(f.as('tracker'), 'bot_message', { operationId: 'o1', to: id, text: 'Hi.' })).toMatchObject({ outcome: 'unreachable' });
    expect(await f.call(f.as('tracker'), 'bot_message', { operationId: 'o2', to: 'Collect logs', text: 'Hi.' })).toMatchObject({ outcome: 'unreachable' });
    await expect(f.call(f.as('tracker'), 'bot_session', { bot: id })).rejects.toThrow();
    expect(await f.call(f.worker(), 'bot_message', { operationId: 'o3', to: 'Tracker', text: 'Hi.' })).toMatchObject({ outcome: 'forbidden' });
    await expect(f.call(f.worker(), 'create_bot', { operationId: 'o4', name: 'X', mission: 'Y.' })).rejects.toThrow('not a bot');
    // Its bot reads its conversation with read_bot, by id or name.
    expect(await f.call(f.as('chief'), 'bot_session', { bot: id })).toEqual(f.worker());
    expect(await f.call(f.as('chief'), 'bot_session', { bot: 'collect logs' })).toEqual(f.worker());
  });

  it('keeps at most eight live for a bot, naming them when it refuses the next, and never counts a side the person started', async () => {
    const f = fixture();
    for (let index = 0; index < SUB_SESSION_LIVE_LIMIT; index++) await f.start(`Job ${index}`);
    await expect(f.start('One more')).rejects.toThrow(`already have ${SUB_SESSION_LIVE_LIMIT} live sub-sessions; stop one you will not use again, or send it the work. Live now: Job 0 (working)`);
    const source = { hostId: 'mac', providerId: 'codex', nativeSessionId: 'chief', title: 'Chief' };
    await f.broker.startBot({ operationId: 'side', source, bot: { name: 'Look it up', mission: 'What is wordstat?' } });
    expect(f.subs()).toHaveLength(SUB_SESSION_LIVE_LIMIT + 1);
    // Ending one makes room.
    await f.call(f.as('chief'), 'stop_sub_session', { subSessionId: 'Job 3' });
    expect(await f.start('One more')).toMatchObject({ status: 'working' });
  });

  it('gives the same sub-session more work as input, keeping its record, and says when it has ended', async () => {
    const f = fixture();
    const { sub_session_id: id } = await f.start() as { sub_session_id: string };
    f.settle();
    await f.end(0, 'finished', 'Logs saved.');
    expect(f.sub().task!.state).toBe('idle');
    const more = { subSessionId: id, operationId: 'more', text: 'Now compress them.', title: 'Compress' };
    expect(await f.call(f.as('chief'), 'send_to_sub_session', more)).toMatchObject({ sub_session_id: id, delivered_as: 'delivered' });
    expect(f.subs()).toHaveLength(1);
    expect(f.sub().task).toMatchObject({ state: 'working', lastWork: { title: 'Compress' } });
    expect(f.inputs(f.sub(), 0).at(-1)).toMatchObject({ kind: 'message', from: 'the main session', body: 'Now compress them.' });
    expect(await f.call(f.as('chief'), 'send_to_sub_session', more)).toMatchObject({ delivered_as: 'duplicate' });
    // delivery interrupt stops a running turn first; the work still waits for the session to be idle.
    const before = f.sub().members[0]!.interrupt;
    await f.call(f.as('chief'), 'send_to_sub_session', { ...more, operationId: 'urgent', text: 'Stop that, do this.', title: 'Urgent', delivery: 'interrupt' });
    expect(f.sub().members[0]!.interrupt).toBeGreaterThan(before ?? 0);
    await f.call(f.as('chief'), 'stop_sub_session', { subSessionId: id });
    expect(await f.call(f.as('chief'), 'send_to_sub_session', { ...more, operationId: 'late' })).toMatchObject({ delivered_as: 'unreachable' });
    // Another bot cannot send to it, by id or name.
    await expect(f.call(f.as('tracker'), 'send_to_sub_session', { ...more, operationId: 'x' })).rejects.toThrow('None of your sub-sessions');
  });

  it('tells its bot the result of each turn once: the summary it reported, else its final text, cut at 300 characters with the way to the rest', async () => {
    const f = fixture();
    await f.start();
    f.settle();
    await f.call(f.worker(), 'sub_update', { currentStep: 'Running the suite' });
    expect(f.sub().task).toMatchObject({ currentStep: 'Running the suite', state: 'working' });
    // A step is shown, never queued for its bot.
    expect(f.inputs(f.sub(), 1)).toEqual([]);
    await f.call(f.worker(), 'sub_update', { finalSummary: 'x'.repeat(400) });
    await f.end(0, 'finished', 'The closing words.');
    expect(f.sub().task).toMatchObject({ state: 'idle', result: { outcome: 'finished', text: 'x'.repeat(400) } });
    expect(f.sub().task!.currentStep).toBeUndefined();
    const kinds: string[] = [], [result] = f.inputs(f.sub(), 1);
    kinds.push(result!.kind);
    expect(result).toMatchObject({ kind: 'done', title: 'Collect logs' });
    expect((result as { body: string }).body).toBe(`${'x'.repeat(299)}… (the rest: read_bot)`);
    // The next turn has no summary of its own: its final text is the result, not the earlier summary.
    await f.call(f.as('chief'), 'send_to_sub_session', { subSessionId: 'Collect logs', operationId: 'm', text: 'Again.', title: 'Again' });
    f.settle();
    await f.end(0, 'finished', 'Second answer.');
    expect(f.sub().task!.result).toMatchObject({ text: 'Second answer.' });
    kinds.push(f.inputs(f.sub(), 1).at(-1)!.kind);
    await f.call(f.as('chief'), 'send_to_sub_session', { subSessionId: 'Collect logs', operationId: 'm2', text: 'Again.', title: 'Again' });
    f.settle();
    await f.end(0, 'interrupted');
    expect(f.sub().task!.result).toMatchObject({ outcome: 'interrupted', text: 'The turn was interrupted.' });
    kinds.push(f.inputs(f.sub(), 1).at(-1)!.kind);
    expect(kinds).toEqual(['done', 'done', 'interrupted']);
    await f.call(f.as('chief'), 'send_to_sub_session', { subSessionId: 'Collect logs', operationId: 'm3', text: 'Again.', title: 'Again' });
    f.settle();
    await f.end(0, 'failed', 'The runner is offline.');
    expect(f.inputs(f.sub(), 1).at(-1)).toMatchObject({ kind: 'failed', body: 'The runner is offline.' });
  });

  it('reports its status to its bot: lifecycle, a turn in flight, the last work, step and result, and how long it has been idle', async () => {
    const f = fixture();
    await f.start('Collect logs');
    await f.start('Run tests');
    const status = async (extra: Record<string, unknown> = {}) => (await f.call(f.as('chief'), 'get_sub_session_status', extra)).sub_sessions as Array<Record<string, unknown>>;
    expect((await status()).map(entry => [entry.name, entry.lifecycle, entry.turn_in_flight])).toEqual([['Run tests', 'live', true], ['Collect logs', 'live', true]]);
    f.settle();
    await f.end(0, 'finished', 'Logs saved.');
    const [one] = await status({ subSessionIds: [subSessionId(f.sub().id)] });
    expect(one).toMatchObject({ lifecycle: 'live', turn_in_flight: false, last_terminal_turn_status: 'finished', last_work_title: 'Collect logs', last_result: 'Logs saved.', idle_for_ms: expect.any(Number) });
    // A bot sees only its own, and never a person's side.
    expect((await f.call(f.as('tracker'), 'get_sub_session_status')).sub_sessions).toEqual([]);
    await f.call(f.as('chief'), 'stop_sub_session', { subSessionId: 'Run tests' });
    // A stopped sub-session is no longer among the live ones its bot lists.
    expect((await status()).map(entry => entry.name)).toEqual(['Collect logs']);
  });

  it('writes the items it owns on its bot\'s board and no other, and its result becomes their latest report', async () => {
    const f = fixture();
    await f.call(f.as('chief'), 'update_board', { items: [{ title: 'Collect logs', brief: 'All of them.' }, { title: 'Review' }] });
    const { sub_session_id: id } = await f.start('Collect logs', { trackedTaskKeys: [1] }) as { sub_session_id: string };
    const board = async () => (await f.call(f.as('chief'), 'board')) as { items: Array<Record<string, any>> };
    expect((await board()).items[0]).toMatchObject({ assignee: id, status: 'working', links: [{ kind: 'sub_session', value: id }] });
    // The sub-session reads the whole board and writes the status of its own item, without naming a version.
    expect(((await f.call(f.worker(), 'board')).items as unknown[]).length).toBe(2);
    await f.call(f.worker(), 'update_board', { items: [{ key: 1, status: 'waiting', links: [{ kind: 'branch', value: 'logs' }] }] });
    expect((await board()).items[0]).toMatchObject({ status: 'waiting', updatedBy: id });
    await expect(f.call(f.worker(), 'update_board', { items: [{ key: 2, status: 'done' }] })).rejects.toThrow('writes the items it owns');
    await expect(f.call(f.worker(), 'update_board', { items: [{ key: 1, title: 'Renamed' }] })).rejects.toThrow('only the status, links and result');
    await expect(f.call(f.worker(), 'update_board', { plan: { text: 'x', why: 'y' } })).rejects.toThrow('plan note');
    await expect(f.call(f.worker(), 'update_board', { items: [{ title: 'New' }] })).rejects.toThrow('items it owns');
    f.settle();
    await f.end(0, 'finished', 'Logs saved in /tmp/logs.');
    expect((await board()).items[0]).toMatchObject({ report: 'Logs saved in /tmp/logs.', status: 'waiting' });
    // Its bot is told when it changes the item the sub-session owns; the sub-session's own writes tell it nothing.
    const before = f.inputs(f.sub(), 0).length;
    await f.call(f.as('chief'), 'update_board', { items: [{ key: 1, version: (await board()).items[0]!.version, title: 'Collect every log' }] });
    expect(f.inputs(f.sub(), 0).length).toBe(before + 1);
    expect(f.inputs(f.sub(), 0).at(-1)).toMatchObject({ kind: 'item_changed', what: 'retitled to "Collect every log"' });
  });

  it('waits for the person on a pending approval, and on an input whose delivery is unknown, and goes on when it is answered', async () => {
    const f = fixture();
    await f.start();
    f.settle();
    const team = f.sub(), seat = team.members[0]!;
    await f.broker.hostCall('mac', { action: 'presence', teamId: team.id, memberId: seat.id, activity: 'busy', interaction: 'Run npm test?' } as never);
    expect(f.sub().task).toMatchObject({ state: 'needs_input', waiting: { reason: 'interaction', text: 'Run npm test?' } });
    expect(f.inputs(f.sub(), 1).at(-1)).toMatchObject({ kind: 'needs_you', body: 'Run npm test?' });
    await f.broker.hostCall('mac', { action: 'presence', teamId: team.id, memberId: seat.id, activity: 'busy' } as never);
    expect(f.sub().task).toMatchObject({ state: 'working' });
    f.settle();
    await f.end(0, 'finished', 'Done.');
    // The person typing into an idle sub-session makes it work.
    await f.broker.hostCall('mac', { action: 'presence', teamId: team.id, memberId: seat.id, activity: 'busy' } as never);
    expect(f.sub().task!.state).toBe('working');
    // A delivery of unknown outcome is never sent again: the sub-session waits for a decision.
    const unknown = f.sub().messages.at(-1)!;
    await f.broker.hostCall('mac', { action: 'claim', teamId: team.id, memberId: seat.id, messageId: unknown.id } as never).catch(() => undefined);
    await f.broker.hostCall('mac', { action: 'settle', teamId: team.id, memberId: seat.id, messageId: unknown.id, outcome: 'unknown' } as never).catch(() => undefined);
    expect(['needs_input', 'working']).toContain(f.sub().task!.state);
  });

  it('is idle once its turn has ended after the latest work, even when the end was reported before that work\'s delivery settled', async () => {
    const f = fixture();
    await f.start();
    f.settle();
    await f.end(0, 'finished', 'Logs saved.');
    await f.call(f.as('chief'), 'send_to_sub_session', { subSessionId: 'Collect logs', operationId: 'again', text: 'Compress them.', title: 'Compress' });
    // The Host reports the end of the turn that took this work before it has settled the delivery of the work.
    await f.end(0, 'finished', 'Compressed.');
    expect(f.sub().task!.state).toBe('working');
    f.settle();
    await f.broker.hostCall('mac', { action: 'presence', teamId: f.sub().id, memberId: f.sub().members[0]!.id, activity: 'idle' } as never);
    expect(f.sub().task!.state).toBe('idle');
    // A turn that has not ended since the latest work leaves it working.
    await f.call(f.as('chief'), 'send_to_sub_session', { subSessionId: 'Collect logs', operationId: 'third', text: 'And again.', title: 'Again' });
    f.settle();
    await f.broker.hostCall('mac', { action: 'presence', teamId: f.sub().id, memberId: f.sub().members[0]!.id, activity: 'idle' } as never);
    expect(f.sub().task!.state).toBe('working');
  });

  it('ends on its bot\'s stop and on the person\'s, withdrawing what waits and stopping its turn, and tells its bot of the person\'s', async () => {
    const f = fixture();
    await f.start('Collect logs');
    await f.start('Run tests');
    await f.call(f.as('chief'), 'stop_sub_session', { subSessionId: 'Collect logs' });
    expect(f.sub(0).task).toMatchObject({ state: 'ended', endedBy: 'bot' });
    expect(f.sub(0).members[0]!.interrupt).toBeDefined();
    expect(f.sub(0).messages.filter(message => message.to === f.sub(0).members[0]!.id).every(message => message.status === 'canceled')).toBe(true);
    // Stopping again changes nothing.
    await expect(f.call(f.as('chief'), 'stop_sub_session', { subSessionId: 'Collect logs' })).resolves.toMatchObject({ sub_session_id: subSessionId(f.sub(0).id) });
    await f.broker.action({ teamId: f.sub(1).id, action: 'stop_sub_session' });
    expect(f.sub(1).task).toMatchObject({ state: 'ended', endedBy: 'person' });
    expect(f.inputs(f.sub(1), 1).at(-1)).toMatchObject({ kind: 'cancelled' });
    // Nothing keeps it as a bot: Keep is gone.
    await expect(f.broker.action({ teamId: f.sub(1).id, action: 'keep_task' } as never)).rejects.toThrow();
  });

  it('keeps a side the person started beside its conversation: nothing it says reaches the bot, and its bot does not list it', async () => {
    const f = fixture();
    const source = { hostId: 'mac', providerId: 'codex', nativeSessionId: 'chief', title: 'Chief' };
    await f.broker.startBot({ operationId: 'side', source, bot: { name: 'Look it up', mission: 'What is wordstat?' } });
    expect(f.sub().task).toMatchObject({ startedBy: 'person', state: 'working' });
    await f.end(0, 'finished', 'A word counter.');
    expect(f.sub().task!.result).toMatchObject({ text: 'A word counter.' });
    expect(f.inputs(f.sub(), 1)).toEqual([]);
    expect(((await f.call(f.as('chief'), 'get_sub_session_status')).sub_sessions as unknown[]).length).toBe(0);
    const view = f.broker.list().find(team => team.task)!.task!;
    expect(view.subSessionId).toBe(subSessionId(f.sub().id));
  });

  it('ends the sub-sessions of a bot that retires, and leaves a person\'s side', async () => {
    const f = fixture();
    await f.start();
    await f.broker.startBot({ operationId: 'side', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'chief', title: 'Chief' }, bot: { name: 'Look it up', mission: 'Q?' } });
    f.retire();
    await f.broker.hostCall('mac', { action: 'poll' });
    expect(f.subs().map(team => [team.task!.state, team.task!.endedBy])).toEqual([['ended', 'bot_retired'], ['working', undefined]]);
  });
});

describe('what the page reads of a sub-session', () => {
  it('lists it with its state, last work, step and result for its bot\'s details', async () => {
    const f = fixture();
    await f.start();
    await f.call(f.worker(), 'sub_update', { currentStep: 'Reading' });
    const view = (f.broker.list().find(team => team.task)!).task!;
    expect(view).toMatchObject({ state: 'working', currentStep: 'Reading', subSessionId: subSessionId(f.sub().id) });
    const asView: TaskView | undefined = undefined;
    expect(asView).toBeUndefined();
  });
});
