import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { BOT_INSTRUCTIONS_VERSION, assistantMessageText, chiefChangedText, itemChangedText, itemTagText, parseTaskInputs, taskUpdateText, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { botsHarness } from './test-utils/bots-harness.js';
import { BotTools } from './bot-tools.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function harness(toolNamespaces = false) { const h = await botsHarness({ tasks: true, toolNamespaces }); cleanups.push(() => h.close()); return h; }
const owner = { providerId: 'codex', nativeSessionId: 'worker', title: 'Chief' };
const createSub = { action: 'create_sub_session' as const, owner, operationId: 'op', name: 'Collect logs', prompt: 'Collect the build logs of the last run.' };
/** Every bot's tools, as the Host gives them while the Relay runs tasks. */
const BOT_TOOLS = ['create_bot', 'create_sub_session', 'send_to_sub_session', 'get_sub_session_status', 'read_sub_session', 'stop_sub_session', 'message', 'download_attachment', 'list_bots', 'list_hosts', 'read_bot', 'update_mission', 'remember', 'forget', 'set_chief', 'board', 'update_board', 'write_page', 'read_page', 'set_routine', 'list_routines', 'pause_routine', 'delete_routine', 'open_room'];
const tool = (tools: readonly AgentSessionTool[] | undefined, name: string) => tools?.find(item => item.name === name) ?? (() => { throw new Error(`No ${name} tool.`); })();

describe('a sub-session and its bot', () => {
  const taskOf = (h: Awaited<ReturnType<typeof harness>>, index = 0) => h.teams().filter(team => team.task)[index]!;
  const end = (h: Awaited<ReturnType<typeof harness>>, text: string, index = 0, outcome: 'finished' | 'failed' | 'interrupted' = 'finished') =>
    h.host({ action: 'sub_turn_end', teamId: taskOf(h, index).id, memberId: taskOf(h, index).members[0]!.id, outcome, text });
  it('starts the session where its bot works, with its own few tools and no bot instructions, and delivers the framed first work', async () => {
    const h = await harness();
    expect(await h.host(createSub)).toMatchObject({ status: 'working' });
    expect(h.created).toHaveLength(1);
    const worker = h.created[0]!;
    expect(worker.creation.cwd).toBe(h.directory);
    expect(worker.extensions.tools?.map(item => item.name)).toEqual(['read_main_session', 'communicate_update', 'board', 'update_board']);
    expect(worker.extensions.instructions).toContain('You are a sub-session of the bot');
    expect(worker.extensions.instructions).not.toContain('Your mission');
    await h.runtime.tick();
    expect(h.sessions.get(worker.id)!.deliveries).toEqual([{ text: expect.stringMatching(/^\[Sub-session \S+ · brief · from Chief\]\nTask: Collect logs\n/), delivery: 'immediate' }]);
    // The bot keeps its own tools: its seat in the sub-session carries none.
    expect(await h.runtime.extensions(h.ref('codex', 'worker'))).toBeUndefined();
  });

  it('holds the result until the bot is idle, outside the CLI\'s own queue, and keeps the idle session for more work', async () => {
    const h = await harness();
    await h.host(createSub);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.busy('worker', true);
    await end(h, 'The logs are in /tmp/logs.');
    await h.runtime.tick();
    // The bot's provider has a native next-turn queue; a result still waits for the turn to end.
    expect(h.sessions.get('worker')!.deliveries).toEqual([]);
    // The sub-session is idle with its context: its seat stays, so it can be given more work.
    expect(h.team(taskOf(h).id).task).toMatchObject({ state: 'idle', result: { outcome: 'finished', text: 'The logs are in /tmp/logs.' } });
    expect(await h.runtime.extensions(h.ref('codex', worker.id))).toBeDefined();
    h.busy('worker', false);
    await h.runtime.tick();
    const result = [{ text: expect.stringMatching(/^\[Sub-session \S+ · result · Collect logs\]\nThe logs are in \/tmp\/logs\.\n/), delivery: 'immediate' }];
    expect(h.sessions.get('worker')!.deliveries).toEqual(result);
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries).toEqual(result);
    // More work reaches the same session, which works again.
    const bots = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Chief' });
    await tool(bots.namespace(() => h.ref('codex', 'worker'), false).tools, 'send_to_sub_session').execute({ sub_session_id: 'Collect logs', message: 'Compress them.', title: 'Compress' });
    await h.runtime.tick();
    expect(h.sessions.get(worker.id)!.deliveries.map(delivery => parseTaskInputs(delivery.text)?.[0]?.kind)).toEqual(['brief', 'message']);
    expect(h.created).toHaveLength(1);
    expect(h.team(taskOf(h).id).task).toMatchObject({ state: 'working', lastWork: { title: 'Compress' } });
  });

  it('gives the session its tools as one namespace where the provider takes one, so reporting needs no approval', async () => {
    const h = await harness(true);
    await h.host(createSub);
    const { extensions } = h.created[0]!;
    expect(extensions.tools).toBeUndefined();
    expect(extensions.toolNamespaces?.map(namespace => [namespace.name, namespace.tools.map(item => item.name)])).toEqual([['agent_remote_sub', ['communicate_update', 'board', 'update_board', 'read_main_session']]]);
    const report = tool(extensions.toolNamespaces![0]!.tools, 'communicate_update');
    expect(JSON.parse(await report.execute({ current_step: 'Reading the logs' }) as string)).toEqual({ message: 'Recorded.' });
    expect(taskOf(h).task).toMatchObject({ currentStep: 'Reading the logs' });
  });

  it('delivers the results of several sub-sessions that finished during one turn as one input', async () => {
    const h = await harness();
    await h.host(createSub);
    await h.host({ ...createSub, operationId: 'op-2', name: 'Run tests', prompt: 'Run the unit tests.' });
    await h.runtime.tick();
    h.busy('worker', true);
    await end(h, 'Logs attached.', 0);
    await end(h, 'Two tests fail.', 1, 'failed');
    await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries).toEqual([]);
    h.busy('worker', false);
    await h.runtime.tick();
    const deliveries = h.sessions.get('worker')!.deliveries;
    expect(deliveries).toHaveLength(1);
    const results = parseTaskInputs(deliveries[0]!.text)?.map(input => [input.kind, input.kind === 'brief' || input.kind === 'message' ? '' : input.title]);
    expect(results).toEqual(expect.arrayContaining([['failed', 'Run tests'], ['done', 'Collect logs']]));
    expect(results).toHaveLength(2);
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries).toHaveLength(1);
  });

  it('tells its bot of a pending interaction in the session, and goes on when it is answered', async () => {
    const h = await harness();
    await h.host(createSub);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.busy(worker.id, true); h.interaction(worker.id, 'Run npm test?');
    await h.runtime.tick();
    expect(taskOf(h).task).toMatchObject({ state: 'needs_input', waiting: { reason: 'interaction', text: 'Run npm test? npm test' } });
    h.interaction(worker.id);
    await h.runtime.tick();
    expect(taskOf(h).task?.state).toBe('working');
    h.busy(worker.id, false);
    await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []).map(input => input.kind)).toEqual(['needs_you']);
  });

  it('tells its bot what the person typed to the session, and not the inputs the Relay sent it', async () => {
    const h = await harness();
    await h.host(createSub);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.userMessage(worker.id, h.sessions.get(worker.id)!.deliveries[0]!.text, 'brief');
    h.userMessage(worker.id, 'Skip the old logs.', 'u1');
    await new Promise(resolve => setTimeout(resolve, 20));
    await h.runtime.tick();
    const told = h.sessions.get('worker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []);
    expect(told).toEqual([expect.objectContaining({ kind: 'told', body: 'Skip the old logs.' })]);
  });

  it('does not tell its bot the board notices and item-tagged messages the Relay wrote to the session as if the person typed them', async () => {
    const h = await harness();
    await h.host(createSub);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.userMessage(worker.id, itemChangedText({ title: 'Collect logs', what: 'brief changed' }), 'n1');
    h.userMessage(worker.id, taskUpdateText({ taskId: 't', kind: 'message', label: 'Chief', body: 'More.', tag: itemTagText({ key: 7, title: 'Collect logs', from: 'Chief' }) }), 'n3');
    h.userMessage(worker.id, 'Skip the old logs.', 'u1');
    await new Promise(resolve => setTimeout(resolve, 20));
    await h.runtime.tick();
    const told = h.sessions.get('worker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []);
    expect(told).toEqual([expect.objectContaining({ kind: 'told', body: 'Skip the old logs.' })]);
  });

  it('stops an ended sub-session\'s running turn and lets its runtime go', async () => {
    const h = await harness();
    await h.host(createSub);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.busy(worker.id, true);
    await h.runtime.tick();
    const bots = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Chief' });
    expect(JSON.parse(await tool(bots.namespace(() => h.ref('codex', 'worker'), false).tools, 'stop_sub_session').execute({ sub_session_id: 'Collect logs' }) as string)).toMatchObject({ message: expect.stringContaining('ended') });
    expect(taskOf(h).task?.state).toBe('ended');
    await h.runtime.tick();
    expect(h.cancelled).toEqual([worker.id]);
    expect(h.released).toContain(worker.id);
  });

  it('starts a read-only session that may not write, and a worktree session of its own', async () => {
    const h = await harness();
    await h.host({ ...createSub, operationId: 'read', workspace: 'read_only' });
    expect(h.created[0]!.extensions).toMatchObject({ access: 'read_only' });
    expect(h.created[0]!.extensions.instructions).toContain('without changing it');
    await h.host({ ...createSub, operationId: 'tree', name: 'Edit', workspace: 'worktree', commit: h.commit });
    const worker = h.created[1]!;
    expect(worker.creation.cwd).not.toBe(h.directory);
    await writeFile(join(worker.creation.cwd!, 'a.txt'), 'two\n');
    expect(worker.extensions.instructions).toContain('worktree');
    // Once ended and its deliveries settled, the session is forgotten and its worktree goes.
    await h.host({ action: 'stop_sub_session', owner: { providerId: 'codex', nativeSessionId: 'worker' }, subSessionId: 'Edit' });
    await h.runtime.tick(); await h.runtime.tick();
    expect(await stat(worker.creation.cwd!).then(() => true, () => false)).toBe(false);
  });

  it('reports the status of its bot\'s sub-sessions', async () => {
    const h = await harness();
    await h.host(createSub);
    expect(await h.host({ action: 'get_sub_session_status', owner: { providerId: 'codex', nativeSessionId: 'worker' } }))
      .toMatchObject({ sub_sessions: [expect.objectContaining({ name: 'Collect logs', lifecycle: 'live', turn_in_flight: true })] });
  });
});

describe('a standing bot another bot creates', () => {
  it('starts its session with its mission and every bot\'s tools, joins its chief\'s group, and reads its first message', async () => {
    const h = await harness();
    const chief = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Chief' });
    const created = JSON.parse(await tool(chief.namespace(() => h.ref('codex', 'worker'), false).tools, 'create_bot')
      .execute({ name: 'Scribe', mission: 'Keep the release notes.', message: 'Start from v0.3.' }) as string);
    expect(created).toMatchObject({ status: 'ready' });
    const scribe = h.created[0]!;
    expect(scribe.creation.cwd).toBe(h.directory);
    expect(scribe.extensions.instructions).toContain('Your mission:\nKeep the release notes.');
    expect(scribe.extensions.tools?.map(item => item.name)).toEqual(BOT_TOOLS);
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.sessions.get(scribe.id)!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? [])).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Chief', body: 'Start from v0.3.' })]);
  });
});

describe('the main session\'s task tools', () => {
  async function support(tasks: boolean) {
    const directory = await mkdtemp(join(tmpdir(), 'task-tools-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const calls: TeamHostCall[] = [];
    // The Relay names the bots' main sessions in its enablement; this one is the only bot.
    const worker = new BotTools({ request: async call => { if (call.action === 'bot_enablement') return { bots: [{ providerId: 'codex', nativeSessionId: 'main', botId: 'b_' + '9'.repeat(32) }] };
      calls.push(call); return { ok: true }; }, tasks: () => tasks, title: async () => 'Chief' });
    return { worker, calls };
  }
  const ref = { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'main' };
  it('offers a bot\'s main session every bot\'s tools while the Relay runs bots, and starts a sub-session as the session', async () => {
    const { worker, calls } = await support(true);
    expect(worker.tools(ref)).toBe('none');
    await worker.refresh('controller');
    expect(worker.tools(ref)).toBe('tasks');
    // A session that is no bot gets nothing.
    expect(worker.tools({ ...ref, nativeSessionId: 'plain' })).toBe('none');
    const tools = worker.namespace(() => ref, false).tools;
    expect(tools.map(item => item.name)).toEqual(BOT_TOOLS);
    await tool(tools, 'create_sub_session').execute({ name: 'Collect logs', prompt: 'Collect them.', tracked_task_keys: [3], operationId: 'op' });
    expect(calls).toEqual([{ action: 'create_sub_session', owner: { providerId: 'codex', nativeSessionId: 'main', title: 'Chief' }, operationId: 'op', name: 'Collect logs', prompt: 'Collect them.', trackedTaskKeys: [3] }]);
    await tool(tools, 'list_bots').execute({});
    expect(calls[1]).toEqual({ action: 'list_bots', owner: { providerId: 'codex', nativeSessionId: 'main' } });
    // Where a bot works is chosen from what list_hosts shows, and passed to the Relay as named.
    await tool(tools, 'list_hosts').execute({});
    await tool(tools, 'create_bot').execute({ name: 'Builder', mission: 'Build it.', operationId: 'op2', host: 'studio', new_folder: { name: 'shop-api', under: '/work' } });
    await tool(tools, 'create_bot').execute({ name: 'Fixer', mission: 'Fix it.', operationId: 'op3', host: 'studio', cwd: '/work/shop' });
    expect(calls.slice(2)).toEqual([{ action: 'list_hosts', owner: { providerId: 'codex', nativeSessionId: 'main' } },
      expect.objectContaining({ action: 'create_bot', operationId: 'op2', host: 'studio', newFolder: { name: 'shop-api', under: '/work' } }),
      expect.objectContaining({ action: 'create_bot', operationId: 'op3', host: 'studio', cwd: '/work/shop' })]);
    calls.length = 2;
    // A provider that cannot keep a session read-only is refused before anything is asked of the Relay.
    await expect(tool(tools, 'create_sub_session').execute({ name: 'T', prompt: 'B', workspace: 'read_only' })).rejects.toThrow('cannot work read-only');
    expect(calls).toHaveLength(2);
    // After the person's input, a call carries its cause, and the turn's end reports to the turn's chain.
    worker.causes.set(ref, { kind: 'person', messageId: 'u1' });
    await tool(tools, 'message').execute({ to: 'Tracker', text: 'Status?', operationId: 'm1' });
    expect(calls[2]).toMatchObject({ action: 'bot_message', cause: { kind: 'person', messageId: 'u1' } });
    worker.turnEnded(ref, { cause: { kind: 'person', messageId: 'u1' }, tokens: 42 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls[3]).toEqual({ action: 'chain_turn', owner: { providerId: 'codex', nativeSessionId: 'main' }, cause: { kind: 'person', messageId: 'u1' }, tokens: 42 });
    // A session that is no bot reports no turn.
    worker.turnEnded({ ...ref, nativeSessionId: 'plain' }, { cause: { kind: 'framed' }, tokens: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toHaveLength(4);
  });
  it('maps the board tools to the Host calls of the calling session, and lets create_bot and message name an item', async () => {
    const { worker, calls } = await support(true);
    await worker.refresh('controller');
    const tools = worker.namespace(() => ref, false).tools, owner = { providerId: 'codex', nativeSessionId: 'main' };
    await tool(tools, 'board').execute({});
    await tool(tools, 'board').execute({ bot: 'Tracker', item: 3 });
    await tool(tools, 'update_board').execute({ items: [{ title: 'Run it', assignee: 'Tracker' }, { key: 3, version: 2, status: 'done', parent: null, result: 'Green.' }], plan: { text: 'Run, then ship.', why: 'The build is green.' } });
    await tool(tools, 'create_bot').execute({ name: 'Regression', mission: 'Run the suite.', item: 3, operationId: 'op' });
    await tool(tools, 'message').execute({ to: 'Tracker', text: 'Watch the build.', item: 3, status: 'progress', operationId: 'm1' });
    expect(calls).toEqual([
      { action: 'board', owner },
      { action: 'board', owner, bot: 'Tracker', item: 3 },
      { action: 'update_board', owner, items: [{ title: 'Run it', assignee: 'Tracker' }, { key: 3, version: 2, status: 'done', parent: null, result: 'Green.' }], plan: { text: 'Run, then ship.', why: 'The build is green.' } },
      expect.objectContaining({ action: 'create_bot', name: 'Regression', item: 3 }),
      expect.objectContaining({ action: 'bot_message', to: 'Tracker', item: 3, status: 'progress' }),
    ]);
    // The tool schemas refuse what the Relay would: a write without anything to write, an unknown status or link kind.
    const schema = (name: string) => tools.find(item => item.name === name)!.inputSchema as { properties: Record<string, any> };
    expect(schema('update_board').properties.items.items.properties.status.enum).toEqual(['open', 'working', 'waiting', 'done', 'cancelled']);
    expect(schema('update_board').properties.items.items.properties.links.items.properties.kind.enum).toContain('pr');
    expect(schema('message').properties.item).toEqual({ type: 'integer', minimum: 1 });
  });
  it('keeps the tools declared but refuses them while the Relay does not run tasks', async () => {
    const { worker, calls } = await support(false);
    await worker.refresh('controller');
    expect(worker.enabled(ref)).toBe(false);
    await expect(tool(worker.namespace(() => ref, true).tools, 'create_bot').execute({ name: 'T', mission: 'B' })).rejects.toThrow('Update the Relay to use tasks.');
    expect(calls).toEqual([]);
  });
});

describe('messages between assistants', () => {
  const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'worker'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
    binding: { hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) }, bots: { rank: 'm', members: { v1: { botId: 'b_' + '1'.repeat(32), name: 'Chief', mode: 'coordinator' }, v2: { botId: 'b_' + '2'.repeat(32), name: 'Tracker', mode: 'coordinator' } } } }] as never;
  it('delivers a bot\'s standing instructions from its inbox between its turns, once', async () => {
    const bots = [{ window: { id: 'g', title: 'g', revision: 1, views: [{ id: 'v1', placement: 'primary', binding: { hostId: 'host', providerId: 'codex', nativeSessionId: 'tracker', title: 'tracker' } }] },
      bots: { rank: 'm', members: { v1: { botId: 'b_' + 'd'.repeat(32), name: 'Tracker', mission: 'Track the release.' } } } }] as never;
    const h = await botsHarness({ tasks: true, groups: bots, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    h.busy('tracker', true);
    await h.host({ action: 'bot_enablement' });
    await h.runtime.tick();
    expect(h.sessions.get('tracker')!.deliveries).toEqual([]);
    h.busy('tracker', false);
    await h.runtime.tick();
    expect(h.sessions.get('tracker')!.deliveries).toEqual([{ delivery: 'immediate', text: expect.stringMatching(new RegExp(`^\\[Your standing instructions · v${BOT_INSTRUCTIONS_VERSION}\\]\\n[\\s\\S]*Your mission:\\nTrack the release\\.$`)) }]);
    await h.host({ action: 'bot_enablement' });
    await h.runtime.tick();
    expect(h.sessions.get('tracker')!.deliveries).toHaveLength(1);
  });

  it('reaches the other main session between its turns, after its task updates, and the reply comes back', async () => {
    const h = await botsHarness({ tasks: true, groups, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    const chief = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Chief' });
    const tracker = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Tracker' });
    const tools = (worker: BotTools, id: string) => worker.namespace(() => h.ref('codex', id), false).tools;
    // Both bots first receive their standing instructions in their inboxes.
    await h.host({ action: 'bot_enablement' });
    await h.runtime.tick();
    for (const id of ['worker', 'tracker']) h.sessions.get(id)!.deliveries.length = 0;
    expect(JSON.parse(await tool(tools(chief, 'worker'), 'list_bots').execute({}) as string)).toEqual({ bots: [{ id: 'b_' + '2'.repeat(32), name: 'Tracker' }] });
    h.busy('tracker', true);
    const sent = JSON.parse(await tool(tools(chief, 'worker'), 'message').execute({ to: 'Tracker', text: 'Is the branch cut?' }) as string);
    expect(sent).toMatchObject({ outcome: 'delivered' });
    await h.runtime.tick();
    // A message never steers or queues into a running turn.
    expect(h.sessions.get('tracker')!.deliveries).toEqual([]);
    h.busy('tracker', false);
    await h.runtime.tick();
    // The first message brings the receiver's standing instructions along, in the same input.
    expect(h.sessions.get('tracker')!.deliveries.map(delivery => [delivery.delivery, parseTaskInputs(delivery.text)?.map(input => input.kind === 'standing' ? input.kind : input)])).toEqual([['immediate', ['standing', { kind: 'assistant', messageId: sent.messageId, from: 'Chief', body: 'Is the branch cut?' }]]]);
    await tool(tools(tracker, 'tracker'), 'message').execute({ to: 'Chief', text: 'Yes.', reply_to: sent.messageId });
    await h.runtime.tick();
    expect(parseTaskInputs(h.sessions.get('worker')!.deliveries[0]!.text)?.filter(input => input.kind !== 'standing')).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Tracker', replyTo: sent.messageId, body: 'Yes.' })]);
    // The main sessions keep their own tools.
    expect(await h.runtime.extensions(h.ref('codex', 'tracker'))).toBeUndefined();
  });

  it('does not start a turn for an acknowledgement; it reaches the bot with the next input, in the same delivery', async () => {
    const h = await botsHarness({ tasks: true, groups, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    const chief = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Chief' });
    const tools = chief.namespace(() => h.ref('codex', 'worker'), false).tools;
    await h.host({ action: 'bot_enablement' });
    await h.runtime.tick();
    // The first message brings the receiver's standing instructions; after it the bot is ordinarily idle.
    await tool(tools, 'message').execute({ to: 'Tracker', text: 'Hello.' });
    await h.runtime.tick();
    for (const id of ['worker', 'tracker']) h.sessions.get(id)!.deliveries.length = 0;
    expect(JSON.parse(await tool(tools, 'message').execute({ to: 'Tracker', text: 'Thanks, noted.', status: 'ack' }) as string)).toMatchObject({ outcome: 'delivered' });
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.sessions.get('tracker')!.deliveries).toEqual([]);
    await tool(tools, 'message').execute({ to: 'Tracker', text: 'Is the branch cut?' });
    await h.runtime.tick();
    expect(h.sessions.get('tracker')!.deliveries).toHaveLength(1);
    expect(parseTaskInputs(h.sessions.get('tracker')!.deliveries[0]!.text)?.map(input => input.kind === 'assistant' ? input.body : input.kind)).toEqual(expect.arrayContaining(['Thanks, noted.', 'Is the branch cut?']));
  });

  it('stops the running turn of a bot whose chain the person stopped, once', async () => {
    const h = await botsHarness({ tasks: true, groups, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    const chief = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Chief' });
    await h.host({ action: 'bot_enablement' });
    await h.runtime.tick();
    // The person asked Chief; Chief's message carries that chain to Tracker, which starts a turn in it.
    chief.causes.set(h.ref('codex', 'worker'), { kind: 'person', messageId: 'u1' });
    await tool(chief.namespace(() => h.ref('codex', 'worker'), false).tools, 'message').execute({ to: 'Tracker', text: 'Cut the branch.' });
    await h.runtime.tick();
    h.busy('tracker', true);
    const [chain] = h.broker.chainView().chains;
    await h.broker.chainAction({ action: 'stop', chainId: chain!.id });
    await h.runtime.tick();
    expect(h.cancelled).toEqual(['tracker']);
    await h.runtime.tick();
    expect(h.cancelled).toEqual(['tracker']);
  });

  it('asks the members of a room in turn, between their turns, and takes their answers', async () => {
    const h = await botsHarness({ tasks: true, groups, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    const support = (title: string) => new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => title });
    const tools = (worker: BotTools, id: string) => worker.namespace(() => h.ref('codex', id), false).tools;
    const { roomId } = JSON.parse(await tool(tools(support('Chief'), 'worker'), 'open_room').execute({ name: 'Release', topic: 'Ready?', members: ['Tracker'], minutes: 30 }) as string);
    await h.runtime.tick();
    const turn = parseTaskInputs(h.sessions.get('tracker')!.deliveries[0]!.text);
    expect(turn).toEqual([{ kind: 'room', roomId, name: 'Release', count: 1, body: 'Chief: Ready?' }]);
    await tool(tools(support('Tracker'), 'tracker'), 'message').execute({ to: roomId, text: 'Yes.', status: 'done' });
    expect(h.team(roomId).room).toMatchObject({ state: 'done', result: { text: 'Yes.' } });
  });
});
