import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FORK_TURNS_LIMIT, isBotMessageResult, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { BotTools, botToolsGiven, workerToolsIn, WORKER_NAMESPACE } from './bot-tools.js';

// The Relay names the bots' main sessions on this Host with their missions; the stub answers as it would.
function fixture(bots: Array<{ nativeSessionId: string; primary?: true; mission?: string; memory?: Array<{ id: string; text: string }> }>, tasks = true, takesTools = true) {
  const calls: TeamHostCall[] = [];
  let listed = bots;
  const tools = new BotTools({ request: async call => { calls.push(call); return { bots: listed.map(bot => ({ providerId: 'codex', ...bot })) }; }, tasks: () => tasks, takesTools: () => takesTools });
  return { tools, calls, set: (next: typeof bots) => { listed = next; } };
}
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });

it('follows the bots the Relay names, with their missions, and tells listeners when they change', async () => {
  const f = fixture([{ nativeSessionId: 'chief', mission: 'Lead the release.' }]);
  let changes = 0; f.tools.onChange(() => { changes++; });
  await f.tools.refresh('controller');
  expect(f.calls).toEqual([{ action: 'bot_enablement' }]);
  expect(f.tools.tools(ref('chief'))).toBe('tasks');
  expect(f.tools.tools(ref('plain'))).toBe('none');
  expect(f.tools.standing(ref('chief'))).toContain('Your mission:\nLead the release.');
  expect(f.tools.standing(ref('plain'))).toBeUndefined();
  expect(changes).toBe(1);
  await f.tools.refresh('controller');
  expect(changes).toBe(1);
  f.set([{ nativeSessionId: 'chief', mission: 'Ship on Friday.' }]);
  await f.tools.refresh('controller');
  expect(changes).toBe(2);
  expect(f.tools.standing(ref('chief'))).toContain('Ship on Friday.');
});

it('offers nothing, and asks nothing, while the Relay has not acknowledged bots', async () => {
  const f = fixture([{ nativeSessionId: 'chief' }], false);
  await f.tools.refresh('controller');
  expect(f.calls).toEqual([]);
  expect(f.tools.enabled(ref('chief'))).toBe(false);
  await expect(f.tools.namespace(() => ref('chief'), false).tools.find(tool => tool.name === 'list_bots')!.execute({})).rejects.toThrow('Update the Relay to use tasks.');
});

it('counts a listed bots namespace as the tools a session was given, and a deferred one as none', () => {
  const namespace = fixture([]).tools.namespace(() => ref('chief'), false);
  expect(namespace.name).toBe(WORKER_NAMESPACE);
  expect(workerToolsIn([namespace])).toBe('tasks');
  expect(workerToolsIn([{ ...namespace, deferred: true }])).toBe('none');
  expect(workerToolsIn(undefined)).toBe('none');
});

it('returns the outcome of a message to the bot as the tool result, whichever of the five the Relay names', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../agent-remote-protocol/src/fixtures/bot-messages.v1.json', import.meta.url), 'utf8')) as { results: { valid: unknown[] } };
  const answers = [...fixtures.results.valid], calls: TeamHostCall[] = [];
  const tools = new BotTools({ request: async call => { calls.push(call); return answers.shift(); }, tasks: () => true });
  const message = tools.namespace(() => ref('chief'), false).tools.find(tool => tool.name === 'message')!;
  expect(message.description).toMatch(/delivered.*held.*duplicate.*forbidden.*unreachable/s);
  const told = [];
  for (let index = 0; index < fixtures.results.valid.length; index++) told.push(JSON.parse(await message.execute({ to: 'Tracker', text: 'Hello.' }) as string));
  expect(told).toEqual(fixtures.results.valid);
  expect(told.every(isBotMessageResult)).toBe(true);
  expect(calls[0]).toMatchObject({ action: 'bot_message', to: 'Tracker', text: 'Hello.' });
});

describe('the routine tools', () => {
  const routineTools = () => {
    const calls: TeamHostCall[] = [], tools = new BotTools({ request: async call => { calls.push(call); return { routines: [] }; }, tasks: () => true });
    const tool = (name: string) => tools.namespace(() => ref('chief'), false).tools.find(item => item.name === name)!;
    return { calls, tool };
  };
  it('turns each way of saying when into the one schedule the Relay stores, and refuses to guess between them', async () => {
    const { calls, tool } = routineTools(), set = tool('set_routine');
    await set.execute({ name: 'A', quiet_minutes: 10, until_minutes: 60 });
    await set.execute({ name: 'B', every_minutes: 30, prompt: 'Look.', model: 'claude-haiku-4-5', max_runs_per_day: 4 });
    await set.execute({ name: 'C', daily_at: '08:30' });
    await set.execute({ name: 'D', weekdays: [1, 2, 3, 4, 5], at: '09:00' });
    const before = Date.now();
    await set.execute({ name: 'E', in_minutes: 90 });
    expect(calls.map(call => (call as { schedule: unknown }).schedule)).toEqual([{ kind: 'quiet', minutes: 10 }, { kind: 'every', minutes: 30 }, { kind: 'daily', time: '08:30' }, { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '09:00' },
      { kind: 'once', at: expect.any(Number) }]);
    expect(((calls[4] as { schedule: { at: number } }).schedule.at)).toBeGreaterThanOrEqual(before + 90 * 60_000);
    expect(calls[0]).toMatchObject({ action: 'set_routine', untilMinutes: 60 });
    expect(calls[1]).toMatchObject({ prompt: 'Look.', model: 'claude-haiku-4-5', maxRunsPerDay: 4 });
    await expect(set.execute({ name: 'F', daily_at: '08:30', every_minutes: 10 })).rejects.toThrow('exactly one');
    await expect(set.execute({ name: 'G' })).rejects.toThrow('exactly one');
    await expect(set.execute({ name: 'H', weekdays: [1] })).rejects.toThrow('at');
    expect(calls).toHaveLength(5);
  });
  it('lists, pauses and deletes by name, and has no tool to set an event routine', async () => {
    const { calls, tool } = routineTools();
    await tool('list_routines').execute({}); await tool('pause_routine').execute({ name: 'A', paused: true }); await tool('delete_routine').execute({ name: 'A' });
    expect(calls.map(call => call.action)).toEqual(['list_routines', 'pause_routine', 'delete_routine']);
    expect(JSON.stringify(tool('set_routine'))).not.toContain('event');
  });
});

describe('the reply a bot\'s ended turn sends', () => {
  const asked = { kind: 'framed' as const, answers: 'm0123456789ab' };
  const ended = async (turn: Parameters<BotTools['turnEnded']>[1], takesTools = false) => {
    const f = fixture([{ nativeSessionId: 'chief' }], true, takesTools);
    await f.tools.refresh('controller');
    f.calls.length = 0;
    f.tools.turnEnded(ref('chief'), turn);
    return f.calls;
  };

  it('is the final text of a bot whose provider takes no tools, as a call the Host makes, when one message started the turn', async () => {
    expect(await ended({ cause: asked, tokens: 5, finalText: 'Yes, cut at noon.' })).toEqual([
      { action: 'chain_turn', owner: { providerId: 'codex', nativeSessionId: 'chief' }, cause: asked, tokens: 5 },
      { action: 'bot_reply', owner: { providerId: 'codex', nativeSessionId: 'chief' }, text: 'Yes, cut at noon.', cause: asked }]);
  });

  it('is never the final text of a bot that has the tools: it answers with message, so its closing words go to no sender', async () => {
    expect((await ended({ cause: asked, tokens: 5, finalText: 'Noted, nothing more to do.' }, true)).map(call => call.action)).toEqual(['chain_turn']);
  });

  it('is sent for no turn that answers no message, that said nothing, or that a session without bots ran', async () => {
    expect((await ended({ cause: { kind: 'framed' }, tokens: 5, finalText: 'Done.' })).map(call => call.action)).toEqual(['chain_turn']);
    expect((await ended({ cause: { kind: 'person', messageId: 'u1' }, tokens: 5, finalText: 'Done.' })).map(call => call.action)).toEqual(['chain_turn']);
    expect((await ended({ cause: asked, tokens: 5 })).map(call => call.action)).toEqual(['chain_turn']);
    const f = fixture([{ nativeSessionId: 'chief' }]);
    await f.tools.refresh('controller');
    f.calls.length = 0;
    f.tools.turnEnded(ref('plain'), { cause: asked, tokens: 5, finalText: 'Done.' });
    expect(f.calls).toEqual([]);
  });
});

describe('the end of a sub-session\'s turn', () => {
  const turn = (finalText?: string, outcome?: 'finished' | 'failed' | 'interrupted') => ({ cause: { kind: 'framed' as const }, tokens: 5, ...(finalText ? { finalText } : {}), ...(outcome ? { outcome } : {}) });
  const seat = { teamId: 'team', memberId: 'member' };
  const workerTools = (calls: TeamHostCall[], patch?: string) => new BotTools({ request: async call => { calls.push(call); return {}; }, tasks: () => true,
    workerSeat: candidate => candidate.nativeSessionId === 'worker' ? seat : undefined, ...(patch ? { patch: async () => patch } : {}) });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it('is sent as a call the Host makes with no tool: how it ended and its final text, kept to the size a result keeps', async () => {
    const calls: TeamHostCall[] = [], tools = workerTools(calls);
    tools.turnEnded(ref('worker'), turn('Two notes written.'));
    tools.turnEnded(ref('worker'), turn('x'.repeat(5000)));
    tools.turnEnded(ref('worker'), turn('The runner is offline.', 'failed'));
    tools.turnEnded(ref('worker'), turn(undefined, 'interrupted'));
    await flush();
    expect(calls).toEqual([
      { action: 'sub_turn_end', ...seat, outcome: 'finished', text: 'Two notes written.' },
      { action: 'sub_turn_end', ...seat, outcome: 'finished', text: `${'x'.repeat(3999)}…` },
      { action: 'sub_turn_end', ...seat, outcome: 'failed', text: 'The runner is offline.' },
      { action: 'sub_turn_end', ...seat, outcome: 'interrupted' }]);
  });

  it('carries the patch of a worktree session after its text, and is sent for no session that is not a sub-session\'s', async () => {
    const calls: TeamHostCall[] = [], tools = workerTools(calls, 'Patch (apply with git apply): /tmp/x.patch');
    tools.turnEnded(ref('worker'), turn('Changed a.txt.'));
    tools.turnEnded(ref('plain'), turn('Done.'));
    await flush();
    expect(calls).toEqual([{ action: 'sub_turn_end', ...seat, outcome: 'finished', text: 'Changed a.txt.\n\nPatch (apply with git apply): /tmp/x.patch' }]);
  });

  it('counts only a finished turn in a chain: a failed or interrupted one reports nothing else', async () => {
    const calls: TeamHostCall[] = [], tools = workerTools(calls);
    tools.turnEnded(ref('worker'), turn('x', 'failed'));
    await flush();
    expect(calls.map(call => call.action)).toEqual(['sub_turn_end']);
  });
});

describe('what the person wrote to a bot', () => {
  it('goes to the Relay as the person\'s own words, at most 300 characters, only for a bot\'s session', async () => {
    const f = fixture([{ nativeSessionId: 'tracker' }]);
    await f.tools.refresh('controller');
    f.calls.length = 0;
    f.tools.personWrote(ref('tracker'), { messageId: 'u1', text: 'x'.repeat(1000) });
    f.tools.personWrote(ref('plain'), { messageId: 'u2', text: 'Hello.' });
    expect(f.calls).toEqual([{ action: 'bot_told', owner: { providerId: 'codex', nativeSessionId: 'tracker' }, text: 'x'.repeat(300), cause: { kind: 'person', messageId: 'u1' } }]);
  });
});

it('starts every session of a bot with its memory after its mission, and tells listeners when the memory changes', async () => {
  const fact = { id: 'f0a1b2c3d', text: 'Releases ship on Thursdays.' };
  const f = fixture([{ nativeSessionId: 'chief', mission: 'Lead the release.', memory: [fact] }]);
  let changes = 0; f.tools.onChange(() => { changes++; });
  await f.tools.refresh('controller');
  expect(f.tools.standing(ref('chief'))).toMatch(/Your mission:\nLead the release\.\n\nYour memory[^\n]*\n- f0a1b2c3d · Releases ship on Thursdays\.$/);
  f.set([{ nativeSessionId: 'chief', mission: 'Lead the release.', memory: [{ ...fact, text: 'Releases ship on Fridays.' }] }]);
  await f.tools.refresh('controller');
  expect(changes).toBe(2);
  expect(f.tools.standing(ref('chief'))).toContain('Releases ship on Fridays.');
  f.set([{ nativeSessionId: 'chief', mission: 'Lead the release.' }]);
  await f.tools.refresh('controller');
  expect(f.tools.standing(ref('chief'))).not.toContain('Your memory');
});

it('maps remember, forget and set_chief to the Host calls of the calling session, naming no other bot\'s memory', async () => {
  const f = fixture([{ nativeSessionId: 'chief' }]);
  const tools = f.tools.namespace(() => ref('chief'), false).tools, owner = { providerId: 'codex', nativeSessionId: 'chief' };
  const tool = (name: string) => tools.find(item => item.name === name)!;
  await f.tools.refresh('controller');
  f.calls.length = 0;
  await tool('remember').execute({ text: 'Releases ship on Thursdays.' });
  await tool('remember').execute({ text: 'Releases ship on Fridays.', replace: 'f0a1b2c3d' });
  await tool('forget').execute({ fact: 'f0a1b2c3d' });
  await tool('set_chief').execute({ bot: 'Reviewer', chief: 'person' });
  expect(f.calls).toEqual([
    { action: 'remember', owner, text: 'Releases ship on Thursdays.' },
    { action: 'remember', owner, text: 'Releases ship on Fridays.', replace: 'f0a1b2c3d' },
    { action: 'forget', owner, fact: 'f0a1b2c3d' },
    { action: 'set_chief', owner, bot: 'Reviewer', chief: 'person' },
  ]);
  for (const name of ['remember', 'forget']) expect(Object.keys((tool(name).inputSchema as { properties: object }).properties)).not.toContain('bot');
  expect((tool('remember').inputSchema as { properties: { text: { maxLength: number } } }).properties.text.maxLength).toBe(300);
});

it('states the 300-character limit of a message where its text is declared, and in the tool description', () => {
  const message = new BotTools({ request: async () => ({}), tasks: () => true }).namespace(() => ref('chief'), false).tools.find(tool => tool.name === 'message')!;
  const text = (message.inputSchema as { properties: { text: { maxLength: number; description?: string } } }).properties.text;
  expect(text).toMatchObject({ maxLength: 300, description: expect.stringContaining('at most 300 characters') });
  expect(message.description).toContain('at most 300 characters');
});

describe('whether a session was given the bots\' tools, which decides if its final text answers a message', () => {
  it('is what the Controller gave the session, not what its provider can take', () => {
    // A session of a tool-capable provider that was never given them answers by final text; one that was given them does not.
    expect(botToolsGiven({ capability: 'attachment', applied: 'none', isBot: true })).toBe(false);
    expect(botToolsGiven({ capability: 'attachment', applied: 'tasks', isBot: true })).toBe(true);
    expect(botToolsGiven({ capability: 'live', applied: 'none', isBot: true })).toBe(false);
    expect(botToolsGiven({ capability: 'live', applied: 'tasks', isBot: true })).toBe(true);
    expect(botToolsGiven({ capability: undefined, applied: 'none', isBot: true })).toBe(false);
  });

  it('counts the deferred namespace of a session fixed at creation once it is a bot, since the bot finds it by tool search', () => {
    expect(botToolsGiven({ capability: 'creation', applied: 'none', isBot: true })).toBe(true);
    expect(botToolsGiven({ capability: 'creation', applied: 'none', isBot: false })).toBe(false);
  });
});

describe('reading a sub-session and reading a bot', () => {
  const owner = { providerId: 'codex', nativeSessionId: 'main' };
  const page = { entries: [{ id: 'a1', type: 'user_message', turnId: 't1' }, { id: 'a2', type: 'assistant_message', turnId: 't1' }, { id: 'b1', type: 'user_message', turnId: 't2' }, { id: 'b2', type: 'assistant_message', turnId: 't2' }], truncated: false };
  function reader() {
    const calls: TeamHostCall[] = [], read: Array<[string, unknown]> = [];
    const tools = new BotTools({ request: async call => { calls.push(call); return { providerId: 'codex', nativeSessionId: 'worker-1' }; }, tasks: () => true,
      read: async (target, before) => { read.push([target.nativeSessionId, before]); return page; } });
    return { calls, read, tools: tools.namespace(() => ref('main'), false).tools };
  }
  const named = (tools: ReturnType<typeof reader>['tools'], name: string) => tools.find(item => item.name === name)!;

  it('reads a sub-session by id or name with read_sub_session, not with read_bot, and limits the page to its last turns', async () => {
    const { calls, read, tools } = reader();
    const parsed = async (args: Record<string, unknown>) => JSON.parse(await named(tools, 'read_sub_session').execute(args) as string);
    expect((await parsed({ sub_session_id: 's_' + '1'.repeat(32) })).entries.map((item: { id: string }) => item.id)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect((await parsed({ sub_session_id: 'Collect logs', mode: 'last_turn' })).entries.map((item: { id: string }) => item.id)).toEqual(['b1', 'b2']);
    expect((await parsed({ sub_session_id: 'Collect logs', max_turns: 2 })).entries).toHaveLength(4);
    expect(calls).toEqual([{ action: 'read_sub_session', owner, subSessionId: 's_' + '1'.repeat(32) }, { action: 'read_sub_session', owner, subSessionId: 'Collect logs' }, { action: 'read_sub_session', owner, subSessionId: 'Collect logs' }]);
    expect(read.every(([session]) => session === 'worker-1')).toBe(true);
    // read_bot still reads a bot, through the bot call, and says it reads bots.
    await named(tools, 'read_bot').execute({ bot: 'Tracker' });
    expect(calls.at(-1)).toEqual({ action: 'bot_session', owner, bot: 'Tracker' });
    const description = named(tools, 'read_bot').description;
    // It reads bots only, and says where a sub-session is read instead.
    expect(description).not.toMatch(/one of your (own )?sub-sessions/);
    expect(description).toContain('A sub-session is not a bot: read it with read_sub_session.');
    expect(named(tools, 'read_sub_session').description).toMatch(/not a bot/);
  });

  it('is offered with the other sub-session tools, and to no session that is not a bot', async () => {
    const { tools } = reader();
    const names = tools.map(item => item.name);
    expect(names.slice(names.indexOf('create_sub_session'), names.indexOf('create_sub_session') + 5)).toEqual(['create_sub_session', 'send_to_sub_session', 'get_sub_session_status', 'read_sub_session', 'stop_sub_session']);
    const schema = named(tools, 'read_sub_session').inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.required).toEqual(['sub_session_id']);
    expect(schema.properties.mode!.enum).toEqual(['last_turn', 'recent']);
  });
});

describe('a sub-session forked from the conversation of its bot', () => {
  const carry = { turns: 2, context: 'CONTEXT', shortened: false };
  const forking = (fork?: (ref: unknown, turns: number) => Promise<typeof carry>) => {
    const calls: TeamHostCall[] = [], forked: Array<[unknown, number]> = [];
    const tools = new BotTools({ request: async call => { calls.push(call); return { sub_session_id: 's' }; }, tasks: () => true,
      ...(fork ? { fork: async (ref: unknown, turns: number) => { forked.push([ref, turns]); return fork(ref, turns); } } : {}) } as never);
    const create = (args: Record<string, unknown>) => (tools.namespace(() => ref('chief'), false).tools.find(item => item.name === 'create_sub_session')!.execute({ name: 'Plan', prompt: 'Plan it.', ...args }) as Promise<string>);
    return { calls, forked, create };
  };

  it('asks for the last fork_turns turns of the caller\'s main conversation and sends them with the call', async () => {
    const f = forking(async () => carry);
    await f.create({ fork_from: 'main', fork_turns: 2 });
    expect(f.forked).toEqual([[expect.objectContaining({ nativeSessionId: 'chief' }), 2]]);
    expect(f.calls[0]).toMatchObject({ action: 'create_sub_session', fork: { turns: 2, context: 'CONTEXT' } });
    expect(f.calls[0]).not.toHaveProperty('fork.shortened');
  });
  it('marks a context that had to be shortened', async () => {
    const f = forking(async () => ({ ...carry, shortened: true }));
    await f.create({ fork_from: 'main', fork_turns: 2 });
    expect(f.calls[0]).toMatchObject({ fork: { shortened: true } });
  });
  it('requires fork_turns with fork_from, refuses fork_turns alone, and starts nothing', async () => {
    const f = forking(async () => carry);
    await expect(f.create({ fork_from: 'main' })).rejects.toThrow('fork_turns');
    await expect(f.create({ fork_turns: 2 })).rejects.toThrow('fork_from');
    expect(f.calls).toEqual([]); expect(f.forked).toEqual([]);
  });
  it('is refused with the reason when the provider cannot fork, and never starts a fresh session instead', async () => {
    const f = forking(async () => { throw new Error('dsh cannot carry its conversation into a sub-session; start it without fork_from.'); });
    await expect(f.create({ fork_from: 'main', fork_turns: 3 })).rejects.toThrow('dsh cannot carry');
    expect(f.calls).toEqual([]);
  });
  it('is refused on a Host that cannot read conversations', async () => {
    await expect(forking().create({ fork_from: 'main', fork_turns: 3 })).rejects.toThrow('not available on this Host');
  });
  it('declares fork_from as main and fork_turns as a bounded count', () => {
    const tools = forking().create && new BotTools({ request: async () => ({}), tasks: () => true } as never).namespace(() => ref('chief'), false).tools;
    const schema = tools.find(item => item.name === 'create_sub_session')!.inputSchema as { properties: Record<string, { enum?: string[]; maximum?: number }>; required: string[] };
    expect(schema.properties.fork_from!.enum).toEqual(['main']);
    expect(schema.properties.fork_turns!.maximum).toBe(FORK_TURNS_LIMIT);
    expect(schema.required).toEqual(['name', 'prompt']);
  });
});

it('gives the primary section to the session of the bot the Relay names primary, and to no other, and tells listeners when the role changes', async () => {
  const f = fixture([{ nativeSessionId: 'chief', primary: true }, { nativeSessionId: 'scout' }]);
  let changes = 0; f.tools.onChange(() => { changes++; });
  await f.tools.refresh('controller');
  expect(f.tools.standing(ref('chief'))).toContain('You are the person\'s primary bot');
  expect(f.tools.standing(ref('scout'))).not.toContain('primary bot');
  f.set([{ nativeSessionId: 'chief' }, { nativeSessionId: 'scout', primary: true }]);
  await f.tools.refresh('controller');
  expect(changes).toBe(2);
  expect(f.tools.standing(ref('chief'))).not.toContain('primary bot');
  expect(f.tools.standing(ref('scout'))).toContain('You are the person\'s primary bot');
});

it('maps write_page and read_page to the Host calls of the calling session, and bounds a page at 8000 characters', async () => {
  const f = fixture([{ nativeSessionId: 'chief' }]);
  const tools = f.tools.namespace(() => ref('chief'), false).tools, owner = { providerId: 'codex', nativeSessionId: 'chief' };
  const tool = (name: string) => tools.find(item => item.name === name)!;
  await f.tools.refresh('controller');
  f.calls.length = 0;
  await tool('write_page').execute({ title: 'Tracker', contents: '| a |', team: true });
  await tool('write_page').execute({ title: 'Tracker', contents: '| b |', page_id: 'pg_0a1b2c3d4e5f' });
  await tool('read_page').execute({});
  await tool('read_page').execute({ page_id: 'pg_0a1b2c3d4e5f', bot: 'Tracker' });
  expect(f.calls).toEqual([
    { action: 'write_page', owner, title: 'Tracker', contents: '| a |', team: true },
    { action: 'write_page', owner, title: 'Tracker', contents: '| b |', pageId: 'pg_0a1b2c3d4e5f' },
    { action: 'read_page', owner },
    { action: 'read_page', owner, pageId: 'pg_0a1b2c3d4e5f', bot: 'Tracker' },
  ]);
  expect((tool('write_page').inputSchema as { properties: { contents: { maxLength: number } } }).properties.contents.maxLength).toBe(8000);
});
