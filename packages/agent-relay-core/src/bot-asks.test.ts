import { describe, expect, it } from 'vitest';
import { ASK_IDLE_MS, WORK_LOG_KEEP, parseTaskInputs, type BotFact, type Team, type TeamSeat, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { committed, detached } from './drafts.js';
import type { SavedTeam } from './team-delivery.js';
import { memoryAttachmentStorage, PortableAttachmentStore } from './attachments.js';

// The person's mentions are answered in sessions of their own. The groups and the Hosts are stubs; the broker, its inboxes and the
// answer sessions are real.
const botId = (n: number) => 'b_' + n.toString(16).padStart(32, '0');
const names = ['Chief', 'Tracker', 'Reviewer'];

function fixture() {
  let state: SavedTeam[] = [], now = 1000, workers = 0, timer: (() => void) | undefined;
  const seats: TeamSeat[] = [];
  const members: Record<string, Record<string, unknown>> = Object.fromEntries(names.map((name, index) => [`v${index}`, { botId: botId(index + 1), name, ...(name === 'Tracker' ? { mission: 'Track the releases.', memory: [{ id: 'f00000001', text: 'Releases ship on Thursdays.' }] } : {}) }]));
  const group = { window: { id: 'g', title: 'g', revision: 1, views: names.map((_, index) => ({ id: `v${index}`, placement: 'primary',
    binding: { hostId: 'mac', providerId: 'codex', nativeSessionId: `s${index}`, title: `s${index}` } })) }, bots: { rank: 'm', members } } as unknown as WindowGroup;
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => now, assertHost: () => {},
    scheduler: { setTimeout: callback => { timer = callback; return callback; }, clearTimeout: () => { timer = undefined; } },
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_hostId, seat) => { seats.push(seat); return { ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', nativeSessionId: seat.member.nativeSessionId ?? `answer-${++workers}` }; },
    attachments: new PortableAttachmentStore(memoryAttachmentStorage()),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => [group], capable: () => true,
      setMemory: async (_groupId, viewId, memory) => { const { memory: _was, ...rest } = members[viewId]!; members[viewId] = { ...rest, ...(memory.length ? { memory } : {}) }; } },
  });
  const id = (name: string) => botId(names.indexOf(name) + 1);
  const as = (name: string) => ({ providerId: 'codex', nativeSessionId: `s${names.indexOf(name)}` });
  const conversation = (name: string) => ({ hostId: 'mac', providerId: 'codex', nativeSessionId: `conversation-${name}`, title: name });
  const ask = (bot: string, from: string, text: string, operationId = `op-${text}`) => broker.ask({ operationId, source: conversation(from), bot, text });
  const call = (action: Record<string, unknown>) => broker.hostCall('mac', action as never);
  const answering = () => state.filter(team => team.ask);
  const memory = (name: string) => members[`v${names.indexOf(name)}`]!.memory as BotFact[] | undefined;
  return { broker, id, as, ask, call, answering, memory, seats, teams: () => state, advance: (ms: number) => { now += ms; }, fire: () => timer?.() };
}
const answerSession = (team: Team) => ({ providerId: team.members[0]!.providerId, nativeSessionId: team.members[0]!.nativeSessionId! });

describe('answer sessions for the person\'s mentions', () => {
  it('opens a session of the bot for the asking conversation that starts with the question, and sends nothing to the conversation or the main session', async () => {
    const f = fixture();
    const team = await f.ask('Tracker', 'Notes', 'What shipped last week?');
    expect(team.ask).toMatchObject({ botId: f.id('Tracker'), from: { nativeSessionId: 'conversation-Notes', name: 'Notes' }, entries: [{ text: 'What shipped last week?' }] });
    expect(team.members[0]).toMatchObject({ role: 'leader', creation: 'ready', access: 'read_only', providerId: 'codex' });
    // The seat is created where the bot works, from its mission and memory as they stand.
    expect(f.seats[0]).toMatchObject({ source: { hostId: 'mac', nativeSessionId: 's1' }, ask: { botId: f.id('Tracker'), mission: 'Track the releases.', memory: [{ text: 'Releases ship on Thursdays.' }] } });
    expect(team.messages).toHaveLength(1);
    expect(parseTaskInputs(team.messages[0]!.text)).toEqual([{ kind: 'ask', from: 'Notes', body: 'What shipped last week?' }]);
    // Only the answer session's own Team exists: no inbox for the conversation, nothing queued for the bot's main session.
    expect(f.teams().filter(item => item.inbox)).toEqual([]);
    expect(f.teams().flatMap(item => item.members).filter(member => member.nativeSessionId === 'conversation-Notes')).toEqual([]);
  });

  it('reuses one session per bot and asking conversation, and opens another for another conversation or bot', async () => {
    const f = fixture();
    const first = await f.ask('Tracker', 'Notes', 'One?');
    const again = await f.ask('tracker', 'Notes', 'Two?');
    expect(again.id).toBe(first.id);
    expect(again.ask!.entries.map(entry => entry.text)).toEqual(['One?', 'Two?']);
    expect(f.seats).toHaveLength(1);
    const other = await f.ask('Tracker', 'Plans', 'Three?');
    const reviewer = await f.ask('Reviewer', 'Notes', 'Four?');
    expect(new Set([first.id, other.id, reviewer.id]).size).toBe(3);
    expect(f.answering().filter(team => team.status === 'active')).toHaveLength(3);
    // Asking twice with the same operation queues it once.
    const sent = await f.ask('Tracker', 'Notes', 'Two?');
    expect(sent.messages).toHaveLength(2);
  });

  it('retires a session an hour after the last mention, on the Relay\'s timer, and the next mention opens a fresh one', async () => {
    const f = fixture();
    const first = await f.ask('Tracker', 'Notes', 'One?');
    f.advance(ASK_IDLE_MS - 1000);
    await f.ask('Tracker', 'Notes', 'Still there?');
    f.advance(ASK_IDLE_MS - 1);
    f.fire();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.teams().find(team => team.id === first.id)!.status).toBe('active');
    f.advance(2);
    f.fire();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.teams().find(team => team.id === first.id)!.status).toBe('archived');
    const next = await f.ask('Tracker', 'Notes', 'Back again');
    expect(next.id).not.toBe(first.id);
    expect(f.seats).toHaveLength(2);
  });

  it('retires a session whose hour passed before its timer ran when a follow-up comes', async () => {
    const f = fixture();
    const first = await f.ask('Tracker', 'Notes', 'One?');
    f.advance(ASK_IDLE_MS + 1);
    const next = await f.ask('Tracker', 'Notes', 'Two?');
    expect(next.id).not.toBe(first.id);
    expect(f.teams().find(team => team.id === first.id)!.status).toBe('archived');
  });

  it('refuses a name that is no bot of the account and does not guess between two', async () => {
    const f = fixture();
    await expect(f.ask('Nobody', 'Notes', 'Hello?')).rejects.toThrow('No bot of this account');
    expect(f.answering()).toEqual([]);
  });

  it('still sends every message of another bot to the receiving bot\'s main session', async () => {
    const f = fixture();
    await f.ask('Reviewer', 'Notes', 'Anything?');
    const sent = await f.call({ action: 'bot_message', owner: f.as('Tracker'), operationId: 'm1', to: 'Reviewer', text: 'Please look at the release notes.' });
    expect(sent).toMatchObject({ outcome: 'delivered' });
    const inbox = f.teams().find(team => team.inbox?.botId === f.id('Reviewer'))!;
    expect(inbox.messages.map(message => message.text).join('\n')).toContain('Please look at the release notes.');
    expect(f.answering()[0]!.messages.map(message => message.text).join('\n')).not.toContain('release notes');
  });

  it('answers from the session\'s final text, cut at 300 characters with a pointer, once', async () => {
    const f = fixture();
    const team = await f.ask('Tracker', 'Notes', 'What shipped?');
    const owner = answerSession(team);
    const cause = { kind: 'framed', asked: true };
    expect(await f.call({ action: 'bot_answer', owner, text: 'x'.repeat(500), cause })).toEqual({ outcome: 'delivered' });
    const answered = f.answering()[0]!.ask!.entries[0]!.answer!;
    expect(answered.text.length).toBeLessThanOrEqual(300);
    expect(answered.text).toContain('read the rest');
    expect(await f.call({ action: 'bot_answer', owner, text: 'Again.', cause })).toMatchObject({ outcome: 'duplicate' });
    // A session that answers no one is refused, so a bot's main session cannot answer through this call.
    expect(await f.call({ action: 'bot_answer', owner: f.as('Tracker'), text: 'No.', cause })).toMatchObject({ outcome: 'forbidden' });
    // A follow-up gets its own answer.
    await f.ask('Tracker', 'Notes', 'And before?');
    await f.call({ action: 'bot_answer', owner, text: 'Two things.', cause });
    expect(f.answering()[0]!.ask!.entries.map(entry => entry.answer?.text.slice(0, 3))).toEqual(['xxx', 'Two']);
  });

  it('writes the bot\'s board and memory as that bot, so its main session reads them', async () => {
    const f = fixture();
    const owner = answerSession(await f.ask('Tracker', 'Notes', 'Track the release.'));
    await f.call({ action: 'update_board', owner, items: [{ title: 'Ship 1.4', status: 'working', assignee: 'self' }] });
    expect(await f.call({ action: 'board', owner: f.as('Tracker') })).toMatchObject({ items: [{ title: 'Ship 1.4', status: 'working' }] });
    expect(await f.call({ action: 'board', owner })).toMatchObject({ bot: 'Tracker', items: [{ title: 'Ship 1.4' }] });
    await f.call({ action: 'remember', owner, text: 'Release notes live in docs/changes.' });
    expect(f.memory('Tracker')!.map(fact => fact.text)).toEqual(['Releases ship on Thursdays.', 'Release notes live in docs/changes.']);
    await f.call({ action: 'forget', owner, fact: 'Release notes live in docs/changes.' });
    expect(f.memory('Tracker')!.map(fact => fact.text)).toEqual(['Releases ship on Thursdays.']);
  });

  it('cannot message bots, create bots or sub-sessions, or change the mission, timers or chief', async () => {
    const f = fixture();
    const owner = answerSession(await f.ask('Tracker', 'Notes', 'Do it all.'));
    expect(await f.call({ action: 'bot_message', owner, operationId: 'm1', to: 'Reviewer', text: 'Hello.' })).toMatchObject({ outcome: 'forbidden' });
    expect(f.teams().find(team => team.inbox?.botId === f.id('Reviewer'))?.messages ?? []).toEqual([]);
    await expect(f.call({ action: 'create_bot', owner, operationId: 'c1', name: 'Helper', mission: 'Help.' })).rejects.toThrow('answer session');
    await expect(f.call({ action: 'create_sub_session', owner, operationId: 'c2', name: 'Helper', prompt: 'Help.' })).rejects.toThrow('answer session');
    await expect(f.call({ action: 'update_mission', owner, mission: 'Something else.' })).rejects.toThrow('answer session');
    await expect(f.call({ action: 'set_routine', owner, name: 'x', schedule: { kind: 'quiet', minutes: 5 } })).rejects.toThrow('answer session');
    await expect(f.call({ action: 'set_chief', owner, bot: 'Reviewer', chief: 'person' })).rejects.toThrow('answer session');
    await expect(f.call({ action: 'stop_sub_session', owner, subSessionId: 'Helper' })).rejects.toThrow('answer session');
  });

  it('reads the asking conversation and the bot\'s main session with read_bot, and other bots as any bot does', async () => {
    const f = fixture();
    const owner = answerSession(await f.ask('Tracker', 'Notes', 'Look around.'));
    expect(await f.call({ action: 'bot_session', owner, bot: 'asking' })).toEqual({ providerId: 'codex', nativeSessionId: 'conversation-Notes' });
    expect(await f.call({ action: 'bot_session', owner, bot: 'main' })).toEqual({ providerId: 'codex', nativeSessionId: 's1' });
    expect(await f.call({ action: 'bot_session', owner, bot: 'Reviewer' })).toEqual({ providerId: 'codex', nativeSessionId: 's2' });
    // A main session has no "asking".
    await expect(f.call({ action: 'bot_session', owner: f.as('Tracker'), bot: 'asking' })).rejects.toThrow();
  });

  it('counts the session\'s turns and tokens in the mention\'s chain, a chain of the person that names the bot', async () => {
    const f = fixture();
    const owner = answerSession(await f.ask('Tracker', 'Notes', 'Count this.'));
    // The session works in the chain of the input it was given, as every bot's session does.
    await f.call({ action: 'claim', teamId: f.answering()[0]!.id, memberId: f.answering()[0]!.members[0]!.id, messageId: f.answering()[0]!.messages[0]!.id });
    const [chain] = f.broker.chains.list();
    expect(chain).toMatchObject({ cause: 'person', bot: f.id('Tracker'), bots: [f.id('Tracker')], messages: 1 });
    await f.call({ action: 'chain_turn', owner, cause: { kind: 'framed', asked: true }, tokens: 1200, costUsd: 0.5 });
    expect(f.broker.chains.list()).toHaveLength(1);
    expect(f.broker.chains.list()[0]).toMatchObject({ id: chain!.id, turns: 1, usage: { tokens: 1200, costUsd: 0.5 } });
  });

  it('gives the Controller the session in its poll, with its entries', async () => {
    const f = fixture();
    const team = await f.ask('Tracker', 'Notes', 'Poll me.');
    const polled = await f.call({ action: 'poll' }) as Team[];
    expect(polled.map(item => item.id)).toContain(team.id);
    expect(polled.find(item => item.id === team.id)!.ask!.entries).toHaveLength(1);
  });
});

describe('the work log of a bot whose answer sessions answered elsewhere', () => {
  const log = (f: ReturnType<typeof fixture>, name = 'Tracker') => f.teams().find(team => team.inbox?.botId === f.id(name))?.inbox?.worklog ?? [];
  const answerOne = async (f: ReturnType<typeof fixture>, from: string, question: string, answer: string) => {
    const team = await f.ask('Tracker', from, question);
    await f.call({ action: 'bot_answer', owner: answerSession(team), text: answer, cause: { kind: 'framed', asked: true } });
  };

  it('gets one dated entry per answered ask: where, the question and the answer, bounded', async () => {
    const f = fixture();
    await answerOne(f, 'Notes', 'q'.repeat(500), 'a'.repeat(450));
    const [entry] = log(f);
    expect(entry).toMatchObject({ seq: 1, at: 1000, where: 'Notes' });
    expect(entry!.question.length).toBeLessThanOrEqual(200);
    expect(entry!.answer.length).toBeLessThanOrEqual(300);
    // An ask that was never answered is no entry, and an answer given twice is one.
    await f.ask('Tracker', 'Plans', 'Pending?');
    expect(log(f)).toHaveLength(1);
  });

  it('keeps the latest fifty and numbers on', async () => {
    const f = fixture();
    for (let index = 0; index < WORK_LOG_KEEP + 3; index++) await answerOne(f, 'Notes', `Q${index}`, `A${index}`);
    expect(log(f)).toHaveLength(WORK_LOG_KEEP);
    expect(log(f)[0]).toMatchObject({ seq: 4, question: 'Q3' });
    expect(log(f).at(-1)).toMatchObject({ seq: WORK_LOG_KEEP + 3 });
  });

  it('is put ahead of the next input the main session is given, once, and not again', async () => {
    const f = fixture();
    await answerOne(f, 'Notes', 'Is it ready?', 'Yes.');
    await answerOne(f, 'Plans', 'Who signs off?', 'Dana.');
    // Nothing reaches the main session by itself; the next message does, with the log in front of it.
    expect(f.teams().find(team => team.inbox?.botId === f.id('Tracker'))!.messages.some(message => message.text.startsWith('[Work log'))).toBe(false);
    await f.call({ action: 'bot_message', owner: f.as('Reviewer'), operationId: 'm1', to: 'Tracker', text: 'Status?' });
    const inbox = f.teams().find(team => team.inbox?.botId === f.id('Tracker'))!;
    const inputs = inbox.messages.flatMap(message => parseTaskInputs(message.text) ?? []);
    expect(inputs.map(input => input.kind)).toEqual(['standing', 'work_log', 'assistant']);
    expect(inputs[1]).toMatchObject({ kind: 'work_log', count: 2 });
    expect((inputs[1] as { body: string }).body).toContain('Who signs off? → Dana.');
    expect(inbox.inbox!.logSeen).toBe(2);
    await f.call({ action: 'bot_message', owner: f.as('Reviewer'), operationId: 'm2', to: 'Tracker', text: 'Again?' });
    expect(f.teams().find(team => team.inbox?.botId === f.id('Tracker'))!.messages.filter(message => message.text.startsWith('[Work log'))).toHaveLength(1);
    // A later answer is told with the next input after it.
    await answerOne(f, 'Notes', 'And now?', 'Same.');
    await f.call({ action: 'bot_message', owner: f.as('Reviewer'), operationId: 'm3', to: 'Tracker', text: 'Third.' });
    const frames = f.teams().find(team => team.inbox?.botId === f.id('Tracker'))!.messages.flatMap(message => parseTaskInputs(message.text) ?? []).filter(input => input.kind === 'work_log');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ count: 1 });
  });

  it('is read by the bot with board and work_log, its own only, from the main session or an answer session', async () => {
    const f = fixture();
    const team = await f.ask('Tracker', 'Notes', 'Is it ready?');
    await f.call({ action: 'bot_answer', owner: answerSession(team), text: 'Yes.', cause: { kind: 'framed', asked: true } });
    const read = await f.call({ action: 'board', owner: f.as('Tracker'), workLog: true }) as { bot: string; workLog: Array<{ where: string; answer: string; line: string }> };
    expect(read).toMatchObject({ bot: 'Tracker', workLog: [{ where: 'Notes', answer: 'Yes.' }] });
    expect(read.workLog[0]!.line).toContain('Is it ready? → Yes.');
    expect(await f.call({ action: 'board', owner: answerSession(team), workLog: true })).toMatchObject({ workLog: [{ where: 'Notes' }] });
    await expect(f.call({ action: 'board', owner: f.as('Chief'), bot: 'Tracker', workLog: true })).rejects.toThrow();
  });
});
