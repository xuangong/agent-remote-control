import { describe, expect, it } from 'vitest';
import { BOARD_KEEP_MS, BOARD_OPEN_LIMIT, isTeam, parseTaskInputs, type Board, type BoardItem, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { temporaryBotId } from './bot-calls.js';
import { committed, detached } from './drafts.js';

// A standing bot's board and the bots that hold its items. Groups and Hosts are stubs; the broker, tasks, inboxes and boards are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker', chief: ids.chief } } } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 1_000_000, workers = 0;
  const groups = [group()];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => now, assertHost: () => {},
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  const call = (who: string, action: Record<string, unknown>) => broker.hostCall('mac', { ...action, owner: as(who) } as never) as Promise<any>;
  const inbox = (botId: string) => state.find(team => team.inbox?.botId === botId)!;
  const board = (botId = ids.chief): Board => inbox(botId).inbox!.board!;
  const item = (key: number, botId = ids.chief): BoardItem => board(botId).items.find(entry => entry.key === key)!;
  const inputs = (team: SavedTeam, member = 0) => team.messages.filter(message => message.to === team.members[member]!.id).flatMap(message => parseTaskInputs(message.text) ?? []);
  const task = () => state.find(team => team.task)!;
  let sent = 0;
  const say = (who: string, to: string, text: string, extra: Record<string, unknown> = {}) => call(who, { action: 'bot_message', operationId: `op-${++sent}`, to, text, ...extra });
  const texts = (team: SavedTeam, member = 0) => team.messages.filter(message => message.to === team.members[member]!.id).map(message => message.text);
  return { broker, call, as, inbox, board, item, inputs, texts, task, say, state: () => state, advance: (ms: number) => { now += ms; } };
}
const write = (f: ReturnType<typeof fixture>, items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => f.call('chief', { action: 'update_board', items, ...extra });

describe('a bot\'s board', () => {
  it('keeps items with a version that counts their writes, and refuses a change that names none', async () => {
    const f = fixture();
    const created = await write(f, [{ title: 'Release notes' }, { title: 'Changelog', parent: 1, links: [{ kind: 'branch', value: 'docs/changelog' }] }]);
    expect(created.items).toEqual([{ key: 1, version: 1 }, { key: 2, version: 1 }]);
    expect(f.item(2)).toMatchObject({ title: 'Changelog', status: 'open', assignee: 'self', parent: 1, links: [{ kind: 'branch', value: 'docs/changelog' }], updatedBy: ids.chief });
    expect(isTeam(f.inbox(ids.chief))).toBe(true);
    expect((await write(f, [{ key: 1, version: 1, status: 'working' }])).items).toEqual([{ key: 1, version: 2 }]);
    // Writing what is there changes nothing.
    expect((await write(f, [{ key: 1, version: 2, status: 'working' }])).items).toEqual([{ key: 1, version: 2 }]);
    await expect(write(f, [{ key: 1, status: 'done' }])).rejects.toThrow('Name the version of item 1 you read (it is 2 now)');
    await expect(write(f, [{ key: 9, version: 1, status: 'done' }])).rejects.toThrow('No item 9');
    await expect(write(f, [{ key: 1, version: 2, parent: 2 }])).rejects.toThrow('own ancestor');
    await expect(write(f, [{ key: 1, version: 2, parent: 5 }])).rejects.toThrow('No item 5');
    expect(await f.call('chief', { action: 'board' })).toMatchObject({ bot: 'Chief', items: [expect.objectContaining({ key: 1, status: 'working' }), expect.objectContaining({ key: 2 })] });
  });

  it('applies a stale write field by field and tells the writer what it overwrote', async () => {
    const f = fixture();
    await write(f, [{ title: 'Release notes' }]);
    // Two writers read version 1; one changes the status, the other the title and the status.
    await write(f, [{ key: 1, version: 1, status: 'waiting' }]);
    const stale = await write(f, [{ key: 1, version: 1, title: 'Release notes 2.0', status: 'working' }]);
    expect(stale.items).toEqual([{ key: 1, version: 3, overwrote: [{ field: 'status', was: 'waiting', by: ids.chief }] }]);
    expect(f.item(1)).toMatchObject({ title: 'Release notes 2.0', status: 'working', version: 3 });
    // A field the other write did not change is not reported, and a write of the same value overwrites nothing.
    expect((await write(f, [{ key: 1, version: 1, title: 'Release notes 2.0', status: 'working' }])).items).toEqual([{ key: 1, version: 3 }]);
    // The plan note is versioned the same way and keeps a line for each change saying why.
    expect((await write(f, [], { plan: { text: 'Notes first.', why: 'Start.' } })).plan).toEqual({ version: 1 });
    await f.call('chief', { action: 'update_board', plan: { text: 'Notes, then ship.', why: 'The build is green.', version: 1 } });
    const late = await f.call('chief', { action: 'update_board', plan: { text: 'Ship first.', why: 'The person asked.', version: 1 } });
    expect(late.plan).toEqual({ version: 3, overwrote: [{ field: 'plan', was: 'Notes, then ship.', by: ids.chief }] });
    expect(f.board().plan).toMatchObject({ text: 'Ship first.', changes: [{ why: 'Start.' }, { why: 'The build is green.' }, { why: 'The person asked.' }] });
  });

  it('holds at most 50 open items, keeps finished ones a week, and reopens only while there is room', async () => {
    const f = fixture();
    await write(f, Array.from({ length: 10 }, (_, index) => ({ title: `Item ${index}` })));
    for (let batch = 0; batch < 4; batch++) await write(f, Array.from({ length: 10 }, (_, index) => ({ title: `Item ${batch}.${index}` })));
    expect(f.board().items).toHaveLength(BOARD_OPEN_LIMIT);
    await expect(write(f, [{ title: 'One too many' }])).rejects.toThrow('50 open items');
    await write(f, [{ key: 1, version: 1, status: 'done', result: 'Shipped.' }]);
    await write(f, [{ title: 'Fits now' }]);
    await expect(write(f, [{ key: 1, version: 2, status: 'open' }])).rejects.toThrow('50 open items');
    f.advance(BOARD_KEEP_MS - 1);
    await write(f, [{ key: 2, version: 1, status: 'cancelled' }]);
    expect(f.item(1)).toBeDefined();
    f.advance(2);
    await write(f, [{ key: 3, version: 1, status: 'working' }]);
    expect(f.item(1)).toBeUndefined();
    expect(f.item(2)).toBeDefined();
  });
});

describe('the bots that hold an item', () => {
  it('records the assignee and the brief of a temporary bot created for an item, and names the item in its first input', async () => {
    const f = fixture();
    await write(f, [{ title: 'Run the regression' }]);
    const created = await f.call('chief', { action: 'create_bot', operationId: 'op', name: 'Regression', mission: 'Run the suite on the branch.', lifetime: 'temporary', item: 1 });
    expect(f.item(1)).toMatchObject({ assignee: temporaryBotId(f.task().id), status: 'working', brief: 'Run the suite on the branch.' });
    expect(created.botId).toBe(temporaryBotId(f.task().id));
    expect(f.inputs(f.task())[0]).toMatchObject({ kind: 'brief', brief: expect.stringContaining('[Item 1 "Run the regression" · from ') });
    await expect(f.call('chief', { action: 'create_bot', operationId: 'op2', name: 'Other', mission: 'x', lifetime: 'temporary', item: 7 })).rejects.toThrow('No item 7');
  });

  it('takes the reports of a temporary bot created for the item as its latest report, its status and its result', async () => {
    const f = fixture();
    await write(f, [{ title: 'Run the regression' }]);
    await f.call('chief', { action: 'create_bot', operationId: 'op', name: 'Regression', mission: 'Run it.', lifetime: 'temporary', item: 1 });
    await f.say('worker-1', 'chief', 'Half of the suites ran.', { status: 'progress' });
    expect(f.item(1)).toMatchObject({ status: 'working', report: 'Half of the suites ran.', updatedBy: temporaryBotId(f.task().id) });
    await f.say('worker-1', 'chief', 'Which branch?', { status: 'needs_input' });
    expect(f.item(1)).toMatchObject({ status: 'waiting', report: 'Which branch?' });
    await f.say('worker-1', 'chief', 'All green.', { status: 'done' });
    expect(f.item(1)).toMatchObject({ status: 'done', report: 'All green.', result: 'All green.' });
    expect(f.inputs(f.task(), 1).at(-1)).toMatchObject({ kind: 'done', body: expect.stringContaining('[Item 1 "Run the regression" · from Regression]') });
  });

  it('puts a failed report on the item and reopens it', async () => {
    const f = fixture();
    await write(f, [{ title: 'Run the regression' }]);
    await f.call('chief', { action: 'create_bot', operationId: 'op', name: 'Regression', mission: 'Run it.', lifetime: 'temporary', item: 1 });
    await f.say('worker-1', 'chief', 'The suite does not start.', { status: 'failed' });
    expect(f.item(1)).toMatchObject({ status: 'open', report: 'Failed: The suite does not start.' });
    expect(f.item(1).result).toBeUndefined();
  });

  it('lets a temporary bot write the status, links and result of its own item, and nothing else', async () => {
    const f = fixture();
    await write(f, [{ title: 'Run the regression' }, { title: 'Other' }]);
    await f.call('chief', { action: 'create_bot', operationId: 'op', name: 'Regression', mission: 'Run it.', lifetime: 'temporary', item: 1 });
    const written = await f.call('worker-1', { action: 'update_board', items: [{ status: 'working', links: [{ kind: 'pr', value: '#12' }], result: 'Two suites left.' }] });
    expect(written.items).toEqual([{ key: 1, version: 3 }]);
    expect(f.item(1)).toMatchObject({ links: [{ kind: 'pr', value: '#12' }], result: 'Two suites left.', updatedBy: temporaryBotId(f.task().id) });
    await expect(f.call('worker-1', { action: 'update_board', items: [{ key: 2, status: 'done' }] })).rejects.toThrow('the item it was created for');
    await expect(f.call('worker-1', { action: 'update_board', items: [{ title: 'Mine now' }] })).rejects.toThrow('only the status, links and result');
    await expect(f.call('worker-1', { action: 'update_board', plan: { text: 'x', why: 'y' } })).rejects.toThrow('plan note');
    // It reads its item, with its brief, and its chief's board no further.
    expect(await f.call('worker-1', { action: 'board' })).toMatchObject({ item: { key: 1, brief: 'Run it.' }, readOnly: true });
    await f.call('chief', { action: 'create_bot', operationId: 'op3', name: 'Free', mission: 'Run it.', lifetime: 'temporary' });
    await expect(f.call('worker-2', { action: 'update_board', items: [{ status: 'done' }] })).rejects.toThrow('not created for a board item');
  });

  it('hands work to a standing staff bot with the item named in its message, and takes its reports as the latest report only', async () => {
    const f = fixture();
    await write(f, [{ title: 'Track the build' }, { title: 'Track the deploy' }]);
    expect(await f.say('chief', 'Tracker', 'Watch the build on main.', { item: 1 })).toMatchObject({ outcome: 'delivered' });
    expect(f.item(1)).toMatchObject({ assignee: ids.tracker, status: 'working', brief: 'Watch the build on main.' });
    const frames = f.inputs(f.inbox(ids.tracker)).filter(input => input.kind === 'assistant');
    expect(frames).toEqual([expect.objectContaining({ from: 'Chief', body: '[Item 1 "Track the build" · from Chief]\nWatch the build on main.' })]);
    // The staff bot reports the item as the only one it holds; the chief's item keeps its status and has no result.
    await f.say('tracker', 'Chief', 'Build is red on main.', { status: 'done' });
    expect(f.item(1)).toMatchObject({ report: 'Build is red on main.', status: 'working', updatedBy: ids.tracker });
    expect(f.item(1).result).toBeUndefined();
    expect(f.inputs(f.inbox(ids.chief)).filter(input => input.kind === 'assistant').at(-1)).toMatchObject({ body: expect.stringContaining('[Item 1 "Track the build" · from Tracker]') });
    // With two items it holds, the report names one; the other is untouched.
    await f.say('chief', 'Tracker', 'Also the deploy.', { item: 2 });
    await f.say('tracker', 'Chief', 'Deploy is waiting.', { status: 'progress' });
    expect(f.item(1).report).toBe('Build is red on main.');
    expect(f.item(2).report).toBeUndefined();
    await f.say('tracker', 'Chief', 'Deploy is waiting.', { status: 'progress', item: 2 });
    expect(f.item(2)).toMatchObject({ report: 'Deploy is waiting.', status: 'working' });
    // The chief decides.
    await write(f, [{ key: 1, version: f.item(1).version, status: 'done', result: 'Fixed by the chief.' }]);
    expect(f.item(1)).toMatchObject({ status: 'done', result: 'Fixed by the chief.' });
    await expect(f.say('chief', 'Tracker', 'x', { item: 9 })).resolves.toMatchObject({ outcome: 'forbidden' });
  });

  it('tells the assignee when its item is retitled, its brief changed, cancelled or reassigned, and the old assignee when it moves', async () => {
    const f = fixture();
    await write(f, [{ title: 'Track the build' }, { title: 'Own work' }]);
    await f.say('chief', 'Tracker', 'Watch the build.', { item: 1 });
    const told = () => f.inbox(ids.tracker).messages.map(message => message.text).filter(text => text.startsWith('[Item "'));
    const version = () => f.item(1).version;
    await write(f, [{ key: 1, version: version(), title: 'Track main' }]);
    await write(f, [{ key: 1, version: version(), brief: 'Watch main only.' }]);
    await write(f, [{ key: 2, version: 1, title: 'Own work 2' }]);
    expect(told()).toEqual(['[Item "Track main" changed · retitled to "Track main"]', '[Item "Track main" changed · brief changed]']);
    // Moving it to a temporary bot tells the old assignee, and the new one.
    await f.call('chief', { action: 'create_bot', operationId: 'op', name: 'Regression', mission: 'Run it.', lifetime: 'temporary' });
    await write(f, [{ key: 1, version: version(), assignee: 'Regression' }]);
    expect(told().at(-1)).toBe('[Item "Track main" changed · reassigned]');
    expect(f.texts(f.task()).at(-1)).toBe('[Item "Track main" changed · assigned to you]');
    await write(f, [{ key: 1, version: version(), status: 'cancelled' }]);
    expect(f.texts(f.task()).at(-1)).toBe('[Item "Track main" changed · cancelled]');
    expect(f.item(1)).toMatchObject({ assignee: temporaryBotId(f.task().id), status: 'cancelled', closedAt: expect.any(Number) });
    // A bot that is not on the account, and one that is not the chief's own staff, cannot be assigned.
    await expect(write(f, [{ key: 2, version: 2, assignee: 'Nobody' }])).rejects.toThrow('No bot');
  });

  it('lets a standing staff bot write only its own board, and the chief read it without writing', async () => {
    const f = fixture();
    await write(f, [{ title: 'Track the build' }]);
    await f.say('chief', 'Tracker', 'Watch the build.', { item: 1 });
    await f.call('tracker', { action: 'update_board', items: [{ title: 'Poll every minute' }] });
    expect(f.board(ids.tracker).items).toMatchObject([{ key: 1, title: 'Poll every minute', assignee: 'self' }]);
    expect(f.board().items).toMatchObject([{ key: 1, title: 'Track the build' }]);
    expect(f.item(1)).not.toHaveProperty('report');
    const read = await f.call('chief', { action: 'board', bot: 'Tracker' });
    expect(read).toMatchObject({ bot: 'Tracker', readOnly: true, items: [{ key: 1, title: 'Poll every minute' }] });
    expect(await f.call('chief', { action: 'board', bot: 'Tracker', item: 1 })).toMatchObject({ item: { key: 1 } });
    // The staff bot is no chief, so it reads no board but its own.
    await expect(f.call('tracker', { action: 'board', bot: 'Chief' })).rejects.toThrow('own standing staff');
    await expect(f.call('tracker', { action: 'board', bot: 'Chief', item: 2 })).rejects.toThrow('own standing staff');
    // The item handed to it can be read, with its brief and links, on the chief's board; it stays read only.
    expect(await f.call('tracker', { action: 'board', bot: 'Chief', item: 1 })).toMatchObject({ bot: 'Chief', readOnly: true, item: { key: 1, title: 'Track the build', brief: 'Watch the build.', assignee: ids.tracker } });
    expect(f.board().items).toMatchObject([{ key: 1, title: 'Track the build', version: 2 }]);
    expect(await f.call('chief', { action: 'board', bot: 'Chief' })).toMatchObject({ bot: 'Chief' });
  });

  it('lists the open items of the caller\'s board, with the latest report, in list_bots', async () => {
    const f = fixture();
    await write(f, [{ title: 'Track the build' }, { title: 'Old', status: 'done' }]);
    await f.say('chief', 'Tracker', 'Watch.', { item: 1 });
    await f.say('tracker', 'Chief', 'Red.', { status: 'progress' });
    expect((await f.call('chief', { action: 'list_bots' })).board).toEqual({ open: 1, items: [{ key: 1, title: 'Track the build', status: 'working', assignee: ids.tracker, report: 'Red.' }] });
  });
});

describe('the person\'s edits of a board', () => {
  const edit = (f: ReturnType<typeof fixture>, action: Record<string, unknown>) => f.broker.chainAction({ action: 'update_board', botId: ids.chief, ...action } as never) as Promise<any>;
  const told = (f: ReturnType<typeof fixture>) => f.inbox(ids.tracker).messages.map(message => message.text).filter(text => text.startsWith('[Item "'));

  it('writes items and the plan note as the person, with the same versions, and tells the assignee of a changed item once', async () => {
    const f = fixture();
    await write(f, [{ title: 'Track the build' }]);
    await f.say('chief', 'Tracker', 'Watch the build.', { item: 1 });
    const result = await edit(f, { items: [{ key: 1, version: f.item(1).version, title: 'Track main', brief: 'Main only.' }] });
    expect(result.items).toEqual([{ key: 1, version: f.item(1).version }]);
    expect(f.item(1)).toMatchObject({ title: 'Track main', brief: 'Main only.', updatedBy: 'person' });
    expect(told(f)).toEqual(['[Item "Track main" changed · retitled to "Track main"; brief changed]']);
    // Cancelling is told too; writing what is there tells no one again.
    await edit(f, { items: [{ key: 1, version: f.item(1).version, status: 'cancelled' }] });
    await edit(f, { items: [{ key: 1, version: f.item(1).version, status: 'cancelled' }] });
    expect(told(f)).toHaveLength(2);
    expect(told(f).at(-1)).toBe('[Item "Track main" changed · cancelled]');
    expect((await edit(f, { plan: { text: 'Notes first.', why: 'The person decided.' } })).plan).toEqual({ version: 1 });
    expect(f.board().plan).toMatchObject({ text: 'Notes first.', changes: [{ by: 'person', why: 'The person decided.' }] });
  });

  it('tells the board\'s own bot what the person changed on its items and plan note, and stays silent for the bot\'s own edits', async () => {
    const f = fixture();
    const toldChief = () => f.inbox(ids.chief).messages.map(message => message.text).filter(text => text.startsWith('[Item "'));
    await write(f, [{ title: 'Write notes' }], { plan: { text: 'Notes.', why: 'Start.' } });
    await write(f, [{ key: 1, version: 1, title: 'Write the notes', status: 'working', brief: 'Short.' }], { plan: { text: 'Notes, short.', why: 'Tighter.', version: 1 } });
    expect(toldChief()).toEqual([]);
    await edit(f, { items: [{ key: 1, version: f.item(1).version, title: 'Write the release notes', status: 'waiting' }] });
    expect(toldChief()).toEqual(['[Item "Write the release notes" changed · retitled to "Write the release notes"; status is now waiting]']);
    await edit(f, { items: [{ key: 1, version: f.item(1).version, status: 'waiting' }] });
    expect(toldChief()).toHaveLength(1);
    await edit(f, { plan: { text: 'Notes, then ship.', why: 'Ship it too.', version: 2 } });
    expect(toldChief().at(-1)).toBe('[Item "Plan note" changed · changed: Ship it too.]');
    await edit(f, { items: [{ title: 'Ship', assignee: 'self' }] });
    expect(toldChief().at(-1)).toBe('[Item "Ship" changed · assigned to you]');
    // A new item the person assigns to another bot tells that bot as an assignment, with its parent and brief kept.
    await edit(f, { items: [{ title: 'Watch main', assignee: ids.tracker, brief: 'Main only.', parent: 1 }] });
    expect(told(f)).toEqual(['[Item "Watch main" changed · assigned to you]']);
    expect(f.item(3)).toMatchObject({ parent: 1, brief: 'Main only.', assignee: ids.tracker });
  });

  it('says what a stale edit overwrote, in an item and in the plan note, and still applies it', async () => {
    const f = fixture();
    await write(f, [{ title: 'Release notes' }], { plan: { text: 'Notes.', why: 'Start.' } });
    await write(f, [{ key: 1, version: 1, status: 'waiting' }]);
    await f.call('chief', { action: 'update_board', plan: { text: 'Notes, then ship.', why: 'Green.', version: 1 } });
    const result = await edit(f, { items: [{ key: 1, version: 1, status: 'working' }], plan: { text: 'Ship.', why: 'Person.', version: 1 } });
    expect(result.items).toEqual([{ key: 1, version: 3, overwrote: [{ field: 'status', was: 'waiting', by: ids.chief }] }]);
    expect(result.plan).toEqual({ version: 3, overwrote: [{ field: 'plan', was: 'Notes, then ship.', by: ids.chief }] });
    expect(f.item(1)).toMatchObject({ status: 'working', updatedBy: 'person' });
  });

  it('assigns to the bot itself, its standing staff or its temporary bots, and tells the old and the new assignee', async () => {
    const f = fixture();
    await write(f, [{ title: 'Track the build' }]);
    await f.call('chief', { action: 'create_bot', operationId: 'op', name: 'Regression', mission: 'Run it.', lifetime: 'temporary' });
    // The page names a temporary bot by the id its items carry.
    expect(f.broker.readForClient(f.task().id).task!.botId).toBe(temporaryBotId(f.task().id));
    await edit(f, { items: [{ key: 1, version: 1, assignee: ids.tracker }] });
    expect(told(f)).toEqual(['[Item "Track the build" changed · assigned to you]']);
    await edit(f, { items: [{ key: 1, version: f.item(1).version, assignee: temporaryBotId(f.task().id) }] });
    expect(told(f).at(-1)).toBe('[Item "Track the build" changed · reassigned]');
    expect(f.texts(f.task()).at(-1)).toBe('[Item "Track the build" changed · assigned to you]');
    await edit(f, { items: [{ key: 1, version: f.item(1).version, assignee: 'self' }] });
    expect(f.texts(f.task()).at(-1)).toBe('[Item "Track the build" changed · reassigned]');
    expect(f.item(1).assignee).toBe('self');
    // The bot's own chief is not its staff, so Tracker's board cannot hand an item to Chief.
    await expect(f.broker.chainAction({ action: 'update_board', botId: ids.tracker, items: [{ title: 'Mine', assignee: ids.chief }] } as never)).rejects.toThrow('itself, its standing staff');
    await expect(edit(f, { items: [{ key: 1, version: f.item(1).version, assignee: 'b_' + '9'.repeat(32) }] })).rejects.toThrow('itself, its standing staff');
    await expect(f.broker.chainAction({ action: 'update_board', botId: 'b_' + '9'.repeat(32), plan: { text: 'x', why: 'y' } } as never)).rejects.toThrow('No standing bot');
  });
});
