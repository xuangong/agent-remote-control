import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { assistantMessageText, parseTaskInputs } from '@orchardworks/agent-remote-protocol';
import { botsHarness } from './test-utils/bots-harness.js';
import { boundary, ScriptedSession } from './test-utils/journal-scripted-session.js';
import { watchChainTurns } from './session-core/chain-turns.js';
import { BotTools } from './bot-tools.js';

// Tracker's session is watched as the Controller watches a bot's: its turn ends with a final text, and the reply travels through the
// Controller's calls to a real Relay broker and into Chief's inbox, where the team runtime delivers it.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'worker'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: 'b_' + '1'.repeat(32), name: 'Chief' }, v2: { botId: 'b_' + '2'.repeat(32), name: 'Tracker' } } } }] as never;
let sequence = 0;
const event = (value: ProviderObservation['event']): ProviderObservation => ({ type: 'observation', sourceKey: `fake:${++sequence}`, occurredAt: 0, delivery: 'live', event: value });
const input = (text: string, messageId?: string) => event({ type: 'timeline', provider: 'codex', item: { type: 'user_message', text, ...(messageId ? { messageId } : {}) } });
const said = (text: string) => event({ type: 'timeline', provider: 'codex', item: { type: 'assistant_message', text } });
const done = () => event({ type: 'turn_completed', provider: 'codex', turnId: 't' });

async function setup() {
  const h = await botsHarness({ tasks: true, groups, sessions: ['tracker'] });
  cleanups.push(() => h.close());
  const chief = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Chief' });
  const tracker = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Tracker' });
  await tracker.refresh('controller');
  const session = new ScriptedSession('codex', 'tracker', [boundary()]);
  const ref = h.ref('codex', 'tracker');
  void (async () => { for await (const _ of watchChainTurns(session, ref, tracker.causes, turn => tracker.turnEnded(ref, turn), written => tracker.personWrote(ref, written)).observe()) { /* watched */ } })();
  const settle = async () => { for (let round = 0; round < 5; round++) await new Promise(resolve => setTimeout(resolve, 0)); };
  /** What Chief's session was given, once it is idle and the runtime has ticked. */
  const chiefInputs = async () => { await h.host({ action: 'bot_enablement' }); await h.runtime.tick(); return h.sessions.get('worker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []).filter(item => item.kind !== 'standing'); };
  const ask = async (text: string, operationId = 'q1') => {
    const sent = await chief.namespace(() => h.ref('codex', 'worker'), false).tools.find(item => item.name === 'message')!.execute({ to: 'Tracker', text, operationId }) as string;
    return JSON.parse(sent).messageId as string;
  };
  return { h, session, settle, chiefInputs, ask, chief };
}

describe('a bot answers from its final text', () => {
  it('sends the final text of the turn one message started back to its sender, cut at 300 characters', async () => {
    const f = await setup();
    const asked = await f.ask('Is the branch cut?');
    f.session.push(input(assistantMessageText({ messageId: asked, from: 'Chief', body: 'Is the branch cut?' })));
    f.session.push(said('x'.repeat(500)));
    f.session.push(done());
    await f.settle();
    const [reply] = await f.chiefInputs() as Array<{ kind: string; from: string; replyTo: string; body: string }>;
    expect(reply).toMatchObject({ kind: 'assistant', from: 'Tracker', replyTo: asked });
    expect(reply!.body).toHaveLength(300);
    expect(reply!.body).toContain('read_bot');
  });

  it('answers nothing when it already messaged its sender, when a reply started the turn, or when two messages arrived together', async () => {
    const f = await setup();
    const first = await f.ask('One?', 'q1');
    const trackerTools = new BotTools({ request: call => f.h.host(call), tasks: () => true, title: async () => 'Tracker' });
    // Answered with message during the turn: its call carries the turn's cause, so the final text sends no second reply.
    trackerTools.causes.set(f.h.ref('codex', 'tracker'), { kind: 'framed', answers: first });
    await trackerTools.namespace(() => f.h.ref('codex', 'tracker'), false).tools.find(item => item.name === 'message')!.execute({ to: 'Chief', text: 'Yes, cut.' });
    f.session.push(input(assistantMessageText({ messageId: first, from: 'Chief', body: 'One?' })));
    f.session.push(said('Yes, cut.'));
    f.session.push(done());
    // A reply, and two messages together, are answered by no final text.
    f.session.push(input(assistantMessageText({ messageId: 'm0123456789ab', from: 'Chief', replyTo: first, body: 'Thanks.' })));
    f.session.push(said('You are welcome.'));
    f.session.push(done());
    const [second, third] = [await f.ask('Two?', 'q2'), await f.ask('Three?', 'q3')];
    f.session.push(input([second, third].map(id => assistantMessageText({ messageId: id, from: 'Chief', body: 'A question.' })).join('\n\n')));
    f.session.push(said('Both are yes.'));
    f.session.push(done());
    await f.settle();
    const heard = (await f.chiefInputs()).filter((item): item is typeof item & { kind: 'assistant'; body: string } => item.kind === 'assistant').map(item => item.body);
    expect(heard).toEqual(['Yes, cut.']);
  });
});

describe('the chief hears what the person wrote to its bot', () => {
  it('receives the person\'s first 300 characters framed as theirs, once, though the bot may echo the input again', async () => {
    const groupsWithChief = [{ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'worker'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
      binding: { hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
      bots: { rank: 'm', members: { v1: { botId: 'b_' + '1'.repeat(32), name: 'Chief' }, v2: { botId: 'b_' + '2'.repeat(32), name: 'Tracker', chief: 'b_' + '1'.repeat(32) } } } }] as never;
    const h = await botsHarness({ tasks: true, groups: groupsWithChief, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    const tracker = new BotTools({ request: call => h.host(call), tasks: () => true, title: async () => 'Tracker' });
    await tracker.refresh('controller');
    const session = new ScriptedSession('codex', 'tracker', [boundary()]), ref = h.ref('codex', 'tracker');
    void (async () => { for await (const _ of watchChainTurns(session, ref, tracker.causes, turn => tracker.turnEnded(ref, turn), written => tracker.personWrote(ref, written)).observe()) { /* watched */ } })();
    session.push(input('Skip the flaky test, and ' + 'x'.repeat(400), 'u1'));
    session.push(input('Skip the flaky test, and ' + 'x'.repeat(400), 'u1'));
    for (let round = 0; round < 5; round++) await new Promise(resolve => setTimeout(resolve, 0));
    await h.host({ action: 'bot_enablement' });
    await h.runtime.tick();
    const heard = h.sessions.get('worker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []).filter(item => item.kind === 'person_wrote');
    expect(heard).toEqual([{ kind: 'person_wrote', bot: 'Tracker', body: expect.stringMatching(/^Skip the flaky test, and x+$/) }]);
    expect((heard[0] as { body: string }).body).toHaveLength(300);
  });
});
