import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { askText, assistantMessageText, standingInstructionsText, workLogText, parseTaskInputs } from '@orchardworks/agent-remote-protocol';
import { botsHarness } from './test-utils/bots-harness.js';
import { boundary, ScriptedSession } from './test-utils/journal-scripted-session.js';
import { watchChainTurns, inputCause } from './session-core/chain-turns.js';
import { BotTools } from './bot-tools.js';

// The person's mention is asked through a real Relay broker; the Controller creates the answer session, delivers the framed question
// and turns the session's final text into the answer.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const trackerId = 'b_' + '2'.repeat(32);
const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'worker'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: 'b_' + '1'.repeat(32), name: 'Chief' },
    v2: { botId: trackerId, name: 'Tracker', mission: 'Track the releases.', memory: [{ id: 'f00000001', text: 'Releases ship on Thursdays.' }] } } } }] as never;
let sequence = 0;
const event = (value: ProviderObservation['event']): ProviderObservation => ({ type: 'observation', sourceKey: `fake:${++sequence}`, occurredAt: 0, delivery: 'live', event: value });
const input = (text: string) => event({ type: 'timeline', provider: 'codex', item: { type: 'user_message', text } });
const said = (text: string) => event({ type: 'timeline', provider: 'codex', item: { type: 'assistant_message', text } });
const done = () => event({ type: 'turn_completed', provider: 'codex', turnId: 't' });
const settle = async () => { for (let round = 0; round < 5; round++) await new Promise(resolve => setTimeout(resolve, 0)); };

async function setup() {
  const h = await botsHarness({ tasks: true, groups, sessions: ['tracker'] });
  cleanups.push(() => h.close());
  const mention = (text: string, operationId = 'op1') => h.broker.ask({ operationId, source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'notes', title: 'Notes' }, bot: 'Tracker', text });
  return { h, mention };
}

describe('an answer session on the Controller', () => {
  it('is created read-only in the bot\'s directory with its mission and memory, and is delivered the framed question', async () => {
    const { h, mention } = await setup();
    const team = await mention('What shipped last week?');
    expect(team.members[0]).toMatchObject({ creation: 'ready', nativeSessionId: 'native-0', cwd: h.directory });
    const [created] = h.created;
    expect(created!.creation).toMatchObject({ cwd: h.directory });
    expect(created!.extensions.access).toBe('read_only');
    expect(created!.extensions.instructions).toContain('Track the releases.');
    expect(created!.extensions.instructions).toContain('Releases ship on Thursdays.');
    expect(created!.extensions.instructions).toContain('answer session');
    await h.runtime.tick();
    const [delivered] = h.sessions.get('native-0')!.deliveries;
    expect(parseTaskInputs(delivered!.text)).toEqual([{ kind: 'ask', from: 'Notes', body: 'What shipped last week?' }]);
    // Nothing reached the conversation it was asked from, and the bot's main session was not woken.
    expect(h.sessions.get('worker')!.deliveries).toEqual([]);
    expect(h.sessions.get('tracker')!.deliveries).toEqual([]);
    expect(h.runtime.answering(h.ref('codex', 'native-0'))).toBe(true);
    expect(h.runtime.answering(h.ref('codex', 'tracker'))).toBe(false);
  });

  it('works as its provider allows when the provider cannot keep a session read-only', async () => {
    const copilot = structuredClone(groups) as unknown as Array<{ window: { views: Array<{ binding: { providerId: string } }> } }>;
    for (const view of copilot[0]!.window.views) view.binding.providerId = 'copilot';
    const h = await botsHarness({ tasks: true, groups: copilot as never, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    const team = await h.broker.ask({ operationId: 'op1', source: { hostId: 'host', providerId: 'copilot', nativeSessionId: 'notes', title: 'Notes' }, bot: 'Tracker', text: 'Hello?' });
    expect(team.members[0]!.creation).toBe('ready');
    expect(h.created[0]!.extensions.access).toBeUndefined();
  });

  it('takes the follow-up of the same conversation in the same session, and gives the session the bots\' tools', async () => {
    const { h, mention } = await setup();
    const first = await mention('One?', 'op1');
    await h.runtime.tick();
    const again = await mention('Two?', 'op2');
    expect(again.id).toBe(first.id);
    expect(h.created).toHaveLength(1);
    const names = h.created[0]!.extensions.tools?.map(tool => tool.name) ?? h.created[0]!.extensions.toolNamespaces?.flatMap(namespace => namespace.tools.map(tool => tool.name)) ?? [];
    expect(names).toEqual(expect.arrayContaining(['board', 'update_board', 'remember', 'forget', 'read_bot']));
  });

  it('answers with the turn\'s final text, counts the turn in the mention\'s chain and sends nothing to anyone else', async () => {
    const { h, mention } = await setup();
    const team = await mention('What shipped?');
    await h.runtime.tick();
    const ref = h.ref('codex', 'native-0');
    const tools = new BotTools({ request: call => h.host(call), tasks: () => true, answering: candidate => h.runtime.answering(candidate) });
    const session = new ScriptedSession('codex', 'native-0', [boundary()]);
    void (async () => { for await (const _ of watchChainTurns(session, ref, tools.causes, turn => tools.turnEnded(ref, turn), written => tools.personWrote(ref, written)).observe()) { /* watched */ } })();
    session.push(input(h.sessions.get('native-0')!.deliveries[0]!.text));
    session.push(said('Two releases shipped.'));
    session.push(done());
    await settle();
    const [entry] = h.team(team.id).ask!.entries;
    expect(entry!.answer!.text).toBe('Two releases shipped.');
    // The question was the person's, not the bot's own: its chief is not told the person wrote to it.
    expect(h.teams().filter(item => item.inbox).flatMap(item => item.messages).filter(message => message.text.includes('The person wrote'))).toEqual([]);
    const [chain] = h.broker.chains.list();
    expect(chain).toMatchObject({ cause: 'person', bot: trackerId, turns: 1 });
  });

  it('knows an input of only asks as the turn whose final text is the answer, and no other input as one', () => {
    const ask = askText({ from: 'Notes', text: 'One?' });
    expect(inputCause({ text: ask })).toEqual({ kind: 'framed', asked: true });
    expect(inputCause({ text: `${ask}\n\n${askText({ from: 'Notes', text: 'Two?' })}` })).toEqual({ kind: 'framed', asked: true });
    expect(inputCause({ text: '[The person asks from Notes] one line' })).toMatchObject({ kind: 'person' });
    expect(inputCause({ text: 'What shipped?', messageId: 'm1' })).toEqual({ kind: 'person', messageId: 'm1' });
  });

  it('reads the standing instructions and the work log ahead of one message as the message alone: the turn\'s final text still answers it', () => {
    const message = assistantMessageText({ messageId: 'm0123456789ab', from: 'Chief', body: 'Status?' });
    const log = workLogText({ lines: ['2026-11-28 10:00 · in "Notes" · the person asked: Ready? → Yes.'], total: 1 });
    expect(inputCause({ text: [standingInstructionsText(undefined), log, message].join('\n\n') })).toEqual({ kind: 'framed', answers: 'm0123456789ab' });
  });

  it('tells the main session of what the answer session answered with the next input it is given, and the bot reads the log', async () => {
    const { h, mention } = await setup();
    await mention('What shipped last week?');
    await h.runtime.tick();
    const ref = h.ref('codex', 'native-0');
    const tools = new BotTools({ request: call => h.host(call), tasks: () => true, answering: candidate => h.runtime.answering(candidate) });
    const session = new ScriptedSession('codex', 'native-0', [boundary()]);
    void (async () => { for await (const _ of watchChainTurns(session, ref, tools.causes, turn => tools.turnEnded(ref, turn), written => tools.personWrote(ref, written)).observe()) { /* watched */ } })();
    session.push(input(h.sessions.get('native-0')!.deliveries[0]!.text));
    session.push(said('Two releases shipped.'));
    session.push(done());
    await settle();
    // The main session has heard nothing yet; Chief's message reaches it with the log in front.
    expect(h.sessions.get('tracker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []).some(item => item.kind === 'work_log')).toBe(false);
    await h.host({ action: 'bot_enablement' });
    await h.host({ action: 'bot_message', owner: { providerId: 'codex', nativeSessionId: 'worker' }, operationId: 'm1', to: 'Tracker', text: 'Status?' });
    await h.runtime.tick();
    const kinds = h.sessions.get('tracker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []);
    expect(kinds.map(item => item.kind)).toEqual(expect.arrayContaining(['work_log', 'assistant']));
    expect(kinds.find(item => item.kind === 'work_log')).toMatchObject({ count: 1, body: expect.stringContaining('What shipped last week? → Two releases shipped.') });
    expect(kinds.findIndex(item => item.kind === 'work_log')).toBeLessThan(kinds.findIndex(item => item.kind === 'assistant'));
    // The bot reads the whole log with board.
    const board = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Tracker' });
    await board.refresh('controller');
    const read = JSON.parse(await board.namespace(() => h.ref('codex', 'tracker'), false).tools.find(item => item.name === 'board')!.execute({ work_log: true }) as string);
    expect(read.workLog).toEqual([expect.objectContaining({ where: 'Notes', question: 'What shipped last week?', answer: 'Two releases shipped.' })]);
  });
});
