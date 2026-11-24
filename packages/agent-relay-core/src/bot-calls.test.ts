import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { attachmentLines, isBotMessageResult, parseTaskInputs, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { committed, detached } from './drafts.js';
import type { SavedTeam } from './team-delivery.js';
import { temporaryBotId } from './bot-calls.js';
import { memoryAttachmentStorage, PortableAttachmentStore } from './attachments.js';
import { instructionsHash } from './inboxes.js';

// Bots call as their own sessions. The groups and the Hosts are stubs; the broker, tasks, inboxes and their validation are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } }) as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 100, workers = 0, offline = false;
  const groups = [group()], placed: Array<{ groupId: string; viewId: string; details: Record<string, unknown> }> = [];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    // Drafts as the Relay's state makes them.
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (_hostId, seat) => offline ? Promise.reject(new Error('Host offline.')) : ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }),
    attachments: new PortableAttachmentStore(memoryAttachmentStorage()),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true,
      placeBot: async (groupId, view, details) => {
        const target = groups.find(item => item.window.id === groupId)!;
        (target.window.views as unknown[]).push({ id: view.id, placement: 'primary', binding: view.binding });
        target.bots!.members[view.id] = details; placed.push({ groupId, viewId: view.id, details: details as Record<string, unknown> });
      },
      setMission: async (groupId, viewId, mission) => { groups.find(item => item.window.id === groupId)!.bots!.members[viewId] = { ...groups.find(item => item.window.id === groupId)!.bots!.members[viewId], mission }; } },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'codex', nativeSessionId });
  const task = () => state.find(team => team.task)!;
  const inputs = (team: SavedTeam, to: number) => team.messages.filter(message => message.to === team.members[to]!.id).flatMap(message => parseTaskInputs(message.text) ?? []);
  /** Everything queued so far reached its seat and started its turn. */
  const settle = () => { state = state.map(team => ({ ...team, messages: team.messages.map(message => message.status === 'queued' ? { ...message, status: 'accepted' as const, acceptance: 'started' as const } : message) })); };
  return { broker, as, task, inputs, placed, settle, groups, state: () => state, goOffline: () => { offline = true; } };
}

describe('bots calling as their own sessions', () => {
  it('starts a temporary bot that its chief lists, and that reports, asks and tells progress to it', async () => {
    const f = fixture();
    const created = await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review the release branch.', lifetime: 'temporary', message: 'Start with the changelog.' }) as { botId: string; status: string };
    expect(created).toMatchObject({ botId: temporaryBotId(f.task().id), status: 'working' });
    expect(f.inputs(f.task(), 0)).toEqual([expect.objectContaining({ kind: 'brief', title: 'Reviewer', brief: 'Review the release branch.\n\nStart with the changelog.' })]);
    expect(await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('chief') })).toEqual({ bots: [
      { id: created.botId, name: 'Reviewer', kind: 'temporary', chief: 'you', status: 'working', mission: 'Review the release branch.\n\nStart with the changelog.' },
      { id: ids.tracker, name: 'Tracker', kind: 'standing' }] });
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'p1', to: 'chief', text: 'Changelog read.', status: 'progress' });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'q1', to: 'Chief', text: 'Include the hotfix?', status: 'needs_input' });
    expect(f.task().task!.state).toBe('needs_input');
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a1', to: 'Reviewer', text: 'Yes.' });
    expect(f.task().task!.state).toBe('working');
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'd1', to: 'chief', text: 'Two issues, both in the notes.', status: 'done' });
    expect(f.task().task!.state).toBe('done');
    expect(f.inputs(f.task(), 1).map(input => input.kind)).toEqual(['progress', 'question', 'done']);
  });

  it('lets other bots write to a temporary bot, which messages standing bots in their inboxes, and only its chief stops it', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 't1', to: 'Reviewer', text: 'The build is green.' });
    expect(f.inputs(f.task(), 0).at(-1)).toMatchObject({ kind: 'message', from: 'Tracker', body: 'The build is green.' });
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'r1', to: 'Tracker', text: 'Thanks.' })).toMatchObject({ outcome: 'delivered' });
    const inbox = f.state().find(team => team.inbox?.botId === ids.tracker)!;
    expect(parseTaskInputs(inbox.messages.at(-1)!.text)).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Reviewer', body: 'Thanks.' })]);
    await expect(f.broker.hostCall('mac', { action: 'stop_bot', owner: f.as('tracker'), bot: 'Reviewer' })).rejects.toThrow('None of your staff');
    expect(await f.broker.hostCall('mac', { action: 'bot_session', owner: f.as('chief'), bot: 'Reviewer' })).toEqual(worker);
    // Any standing bot can be read, which is where a cut reply points; a bot that does not exist cannot.
    expect(await f.broker.hostCall('mac', { action: 'bot_session', owner: f.as('chief'), bot: 'Tracker' })).toEqual(f.as('tracker'));
    await expect(f.broker.hostCall('mac', { action: 'bot_session', owner: f.as('chief'), bot: 'Nobody' })).rejects.toThrow('No bot of this account');
    expect(await f.broker.hostCall('mac', { action: 'stop_bot', owner: f.as('chief'), bot: 'Reviewer' })).toMatchObject({ status: 'cancelled' });
  });

  it('starts a temporary bot the person asks for, with the session they ask it from as its chief (/side)', async () => {
    const f = fixture();
    const team = await f.broker.startBot({ operationId: 's1', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'chief', title: 'Chief' }, bot: { name: 'Notes', mission: 'Write the release notes.' } });
    expect(team.task).toMatchObject({ title: 'Notes', brief: 'Write the release notes.', state: 'working' });
    expect(team.members[1]).toMatchObject({ role: 'requester', nativeSessionId: 'chief' });
    expect(f.inputs(f.task(), 0)).toEqual([expect.objectContaining({ kind: 'brief', title: 'Notes', brief: 'Write the release notes.' })]);
    expect(await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('chief') })).toMatchObject({ bots: expect.arrayContaining([expect.objectContaining({ name: 'Notes', kind: 'temporary', chief: 'you' })]) });
  });

  it('keeps a /side bot beside its conversation: its result is recorded on the task and nothing reaches the chief as input', async () => {
    const f = fixture();
    await f.broker.startBot({ operationId: 's1', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'chief', title: 'Chief' }, bot: { name: 'Notes', mission: 'Write the release notes.' } });
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    expect(f.task().task!.side).toBe(true);
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'p1', to: 'chief', text: 'Reading the log.', status: 'progress' })).toMatchObject({ outcome: 'delivered' });
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'd1', to: 'chief', text: 'Two notes written.', status: 'done' })).toMatchObject({ outcome: 'delivered' });
    expect(f.task().task).toMatchObject({ state: 'done', result: { status: 'done', summary: 'Two notes written.' } });
    expect(f.inputs(f.task(), 1)).toEqual([]);
    expect(f.task().messages.filter(message => message.to === f.task().members[1]!.id && message.status !== 'canceled')).toEqual([]);
  });

  it('still reports a temporary bot another bot created to its chief as input', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    expect(f.task().task!.side).toBeUndefined();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as(f.task().members[0]!.nativeSessionId!), operationId: 'd1', to: 'chief', text: 'Fine.', status: 'done' });
    expect(f.inputs(f.task(), 1).map(input => input.kind)).toEqual(['done']);
  });

  it('holds a bot\'s acknowledgement back from the Host until another input is queued for the same seat, then sends them together', async () => {
    const f = fixture();
    const polled = async (nativeSessionId: string) => ((await f.broker.hostCall('mac', { action: 'poll' }) as SavedTeam[]).find(team => team.inbox && team.members[0]!.nativeSessionId === nativeSessionId)?.messages ?? [])
      .filter(message => message.status === 'queued').flatMap(message => parseTaskInputs(message.text) ?? []).filter(input => input.kind === 'assistant');
    // The standing instructions went in with the first input and settled.
    await f.broker.hostCall('mac', { action: 'bot_enablement' }); await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'first', to: 'Chief', text: 'Hello.' }); f.settle();
    const send = (operationId: string, text: string, status?: 'ack') => f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId, to: 'Chief', text, ...(status ? { status } : {}) });
    expect(await send('a1', 'Received.', 'ack')).toMatchObject({ outcome: 'delivered' });
    expect(await send('a2', 'Thanks.', 'ack')).toMatchObject({ outcome: 'delivered' });
    // Nothing the Host is given starts a turn: the acknowledgements wait on the Relay.
    expect((await polled('chief')).map(input => 'body' in input ? input.body : '')).toEqual([]);
    const chiefInbox = f.state().find(team => team.inbox?.botId === ids.chief)!;
    expect(chiefInbox.messages.filter(message => message.ack && message.status === 'queued')).toHaveLength(2);
    await send('r1', 'The branch is cut.');
    expect((await polled('chief')).map(input => 'body' in input ? input.body : '')).toEqual(['Received.', 'Thanks.', 'The branch is cut.']);
  });

  it('holds an acknowledgement to a temporary bot and to its chief the same way, and an acknowledgement does not answer what a bot waits for', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'q1', to: 'chief', text: 'Include the hotfix?', status: 'needs_input' });
    f.settle();
    const given = async (to: number) => { const team = (await f.broker.hostCall('mac', { action: 'poll' }) as SavedTeam[]).find(item => item.task)!; return team.messages.filter(message => message.to === team.members[to]!.id && message.status === 'queued').map(message => parseTaskInputs(message.text)![0]); };
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'k1', to: 'Reviewer', text: 'Noted.', status: 'ack' });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'p1', to: 'chief', text: 'Got it.', status: 'ack' });
    // Both wait on the Relay; the worker still waits for its answer.
    expect([await given(0), await given(1), f.task().task!.state]).toEqual([[], [], 'needs_input']);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a1', to: 'Reviewer', text: 'Yes.' });
    expect((await given(0)).map(input => 'body' in input ? input.body : '')).toEqual(['Noted.', 'Yes.']);
    // Nothing else was queued for the chief, so its acknowledgement still waits.
    expect([await given(1), f.task().task!.state]).toEqual([[], 'working']);
  });

  it('records a request to a peer on its sender\'s inbox, and the peer\'s answer under it, but not messages to a chief or to staff', async () => {
    const f = fixture();
    const say = (from: string, to: string, text: string, extra: Record<string, unknown> = {}) => f.broker.hostCall('mac', { action: 'bot_message', owner: f.as(from), operationId: `${from}-${text}`, to, text, ...extra }) as Promise<{ messageId?: string }>;
    const asked = (botId: string) => f.state().find(team => team.inbox?.botId === botId)?.inbox?.asked;
    await say('tracker', 'Chief', 'Hello.');
    const request = await say('chief', 'Tracker', 'Is the build green?');
    expect(asked(ids.chief)).toEqual([{ id: request.messageId, to: ids.tracker, text: 'Is the build green?', at: expect.any(Number) }]);
    await say('tracker', 'Chief', 'Yes, green.', { reply_to: request.messageId, replyTo: request.messageId });
    expect(asked(ids.chief)![0]!.answer).toEqual({ text: 'Yes, green.', at: expect.any(Number) });
    // A bot's own staff and its chief are told, not asked.
    f.groups[0]!.bots!.members.v2!.chief = ids.chief;
    await say('chief', 'Tracker', 'Please start the release.');
    await say('tracker', 'Chief', 'Started.');
    await say('tracker', 'Chief', 'Done.', { status: 'done' });
    expect(asked(ids.chief)).toHaveLength(1);
    expect(asked(ids.tracker)).toBeUndefined();
  });

  it('keeps a temporary bot as a standing bot of its chief\'s group when the person asks, and ends its task as done', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review the release branch.', lifetime: 'temporary' });
    await f.broker.action({ teamId: f.task().id, action: 'keep_task' });
    expect(f.placed).toEqual([{ groupId: 'g', viewId: expect.stringMatching(/^bot-/), details: { botId: expect.stringMatching(/^b_[0-9a-f]{32}$/), name: 'Reviewer', mission: 'Review the release branch.', chief: ids.chief } }]);
    expect(f.task().task!.state).toBe('done');
  });

  it('creates a standing bot in its chief\'s group, with its mission and chief, whose first message waits in its inbox', async () => {
    const f = fixture();
    const created = await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Scribe', mission: 'Keep the release notes.', lifetime: 'standing', message: 'Start from v0.3.' }) as { botId: string; status: string };
    expect(created).toMatchObject({ botId: expect.stringMatching(/^b_[0-9a-f]{32}$/), status: 'ready' });
    expect(f.placed).toEqual([{ groupId: 'g', viewId: expect.stringMatching(/^bot-/), details: { botId: created.botId, name: 'Scribe', mission: 'Keep the release notes.', chief: ids.chief } }]);
    const inbox = f.state().find(team => team.inbox?.botId === created.botId)!;
    // Its session was created with its standing instructions, so only its first message waits.
    expect(inbox.inbox).toEqual({ botId: created.botId, instructions: expect.stringMatching(/^[0-9a-f]{64}$/), recent: [expect.objectContaining({ from: ids.chief, hop: 1 })] });
    expect(inbox.members).toEqual([expect.objectContaining({ role: 'leader', creation: 'ready', nativeSessionId: expect.stringMatching(/^worker-/) })]);
    expect(inbox.messages.map(message => parseTaskInputs(message.text)?.[0])).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Chief', body: 'Start from v0.3.' })]);
    expect((await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('chief') }) as { bots: Array<{ name: string }> }).bots.map(bot => bot.name)).toEqual(['Tracker', 'Scribe']);
    // The new bot answers its first message with reply_to.
    const scribe = f.as(inbox.members[0]!.nativeSessionId!), first = inbox.inbox!.recent![0]!.id;
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: scribe, operationId: 'r1', to: 'Chief', text: 'The file exists.', replyTo: first })).toMatchObject({ outcome: 'delivered' });
  });

  it('lets a standing bot record a lasting change to its own mission, without sending it its instructions again', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'hi', to: 'Chief', text: 'Hello.' });
    const before = f.state().find(team => team.inbox?.botId === ids.chief)!.messages.length;
    expect(await f.broker.hostCall('mac', { action: 'update_mission', owner: f.as('chief'), mission: 'Lead the release; review every change first.' })).toEqual({ mission: 'Lead the release; review every change first.' });
    expect((await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('tracker') }) as { bots: Array<{ name: string; mission?: string }> }).bots).toEqual([expect.objectContaining({ name: 'Chief', mission: 'Lead the release; review every change first.' })]);
    // Its inbox counts the new standing instructions as sent, so the next poll queues nothing.
    expect(f.state().find(team => team.inbox?.botId === ids.chief)!.inbox!.instructions).toBe(instructionsHash('Lead the release; review every change first.'));
    expect(f.state().find(team => team.inbox?.botId === ids.chief)!.messages).toHaveLength(before);
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    await expect(f.broker.hostCall('mac', { action: 'update_mission', owner: f.as(f.task().members[0]!.nativeSessionId!), mission: 'Something else.' })).rejects.toThrow('mission is its brief');
  });
  it('answers every message with one of the five outcomes, each of them a valid result of the protocol', async () => {
    const f = fixture();
    const send = (owner: ReturnType<typeof f.as>, to: string, operationId: string, extra: Record<string, unknown> = {}) =>
      f.broker.hostCall('mac', { action: 'bot_message', owner, operationId, to, text: 'Hello.', ...extra } as never) as Promise<{ outcome: string }>;
    const results = [
      await send(f.as('chief'), 'Tracker', 'o1'),
      await send(f.as('chief'), 'Tracker', 'o1'),
      await send(f.as('chief'), 'Nobody', 'o2'),
      await send(f.as('chief'), 'Chief', 'o3'),
    ];
    expect(results.map(result => result.outcome)).toEqual(['delivered', 'duplicate', 'unreachable', 'forbidden']);
    // A temporary bot: reached while it runs, unreachable once it finished, and a repeated report queues nothing new.
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    results.push(await send(f.as('tracker'), 'Reviewer', 't1'), await send(worker, 'chief', 'p1', { status: 'progress' }), await send(worker, 'chief', 'p1', { status: 'progress' }));
    expect(results.slice(4).map(result => result.outcome)).toEqual(['delivered', 'delivered', 'duplicate']);
    await send(worker, 'chief', 'd1', { status: 'done' });
    results.push(await send(f.as('tracker'), 'Reviewer', 't2'), await send(f.as('chief'), 'Reviewer', 't3'));
    expect(results.slice(7).map(result => result.outcome)).toEqual(['unreachable', 'unreachable']);
    // What the sender is told is what the fixtures of the protocol allow.
    const fixtures = JSON.parse(readFileSync(new URL('../../agent-remote-protocol/src/fixtures/bot-messages.v1.json', import.meta.url), 'utf8'));
    expect(fixtures.results.valid.every(isBotMessageResult)).toBe(true);
    expect(results.every(isBotMessageResult)).toBe(true);
  });

  it('holds a message for a bot whose session is not ready, and tells the sender so', async () => {
    const f = fixture();
    f.goOffline();
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'o2', to: 'Tracker', text: 'Again.' })).toMatchObject({ outcome: 'held' });
  });

  it('tells a bot\'s chief what the person wrote to the bot, once, and nobody when the person is its chief', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Scribe', mission: 'Keep the release notes.', lifetime: 'standing' });
    const scribe = f.as(f.state().find(team => team.inbox?.pending === undefined && team.members[0]!.nativeSessionId?.startsWith('worker-'))!.members[0]!.nativeSessionId!);
    const wrote = { action: 'bot_told' as const, owner: scribe, text: 'Skip   the\nflaky test.', cause: { kind: 'person' as const, messageId: 'u1' } };
    expect(await f.broker.hostCall('mac', wrote)).toMatchObject({ outcome: 'delivered' });
    const chief = f.state().find(team => team.inbox?.botId === ids.chief)!;
    expect(parseTaskInputs(chief.messages.at(-1)!.text)).toEqual([{ kind: 'person_wrote', bot: 'Scribe', body: 'Skip the flaky test.' }]);
    expect(await f.broker.hostCall('mac', wrote)).toMatchObject({ outcome: 'duplicate' });
    expect(f.state().find(team => team.inbox?.botId === ids.chief)!.messages).toHaveLength(chief.messages.length);
    // Its chief is the person, or it is a temporary bot, whose chief hears the person through its task.
    expect(await f.broker.hostCall('mac', { ...wrote, owner: f.as('tracker') })).toMatchObject({ outcome: 'unreachable' });
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op2', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    expect(await f.broker.hostCall('mac', { ...wrote, owner: f.as(f.task().members[0]!.nativeSessionId!) })).toMatchObject({ outcome: 'forbidden' });
  });

  describe('attachments', () => {
    const bytes = Buffer.from('--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-draft\n+final\n');
    const upload = async (f: ReturnType<typeof fixture>, owner: ReturnType<typeof f.as>, name = 'notes.patch') => {
      const begun = await f.broker.hostCall('mac', { action: 'attachment_begin', owner, name, mediaType: 'text/x-diff', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) as { id: string };
      await f.broker.hostCall('mac', { action: 'attachment_chunk', owner, attachment: begun.id, offset: 0, contentBase64: bytes.toString('base64') });
      return await f.broker.hostCall('mac', { action: 'attachment_finish', owner, attachment: begun.id }) as { id: string; sha256: string };
    };

    it('lists the files a message carries after its words, and lets the receiver read them back whole', async () => {
      const f = fixture(), file = await upload(f, f.as('chief'));
      expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a1', to: 'Tracker', text: 'The notes patch.', attachments: [file.id] })).toMatchObject({ outcome: 'delivered' });
      const tracker = f.state().find(team => team.inbox?.botId === ids.tracker)!, [input] = parseTaskInputs(tracker.messages.at(-1)!.text)!;
      expect((input as { body: string }).body).toBe(`The notes patch.\n${attachmentLines([{ id: file.id, name: 'notes.patch', mediaType: 'text/x-diff', byteLength: bytes.length, sha256: file.sha256 }])}`);
      const read = await f.broker.hostCall('mac', { action: 'attachment_read', owner: f.as('tracker'), attachment: file.id, offset: 0 }) as { attachment: { byteLength: number }; contentBase64: string };
      expect(Buffer.from(read.contentBase64, 'base64')).toEqual(bytes);
      expect(read.attachment.byteLength).toBe(bytes.length);
    });

    it('carries a temporary bot\'s report with a file, and refuses files that are not stored, in a room, or from a session that is no bot', async () => {
      const f = fixture();
      await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
      const worker = f.as(f.task().members[0]!.nativeSessionId!), file = await upload(f, worker, 'review.log');
      await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'd1', to: 'chief', text: 'Two issues.', status: 'done', attachments: [file.id] });
      expect(f.inputs(f.task(), 1).at(-1)).toMatchObject({ kind: 'done', body: expect.stringContaining(`- ${file.id} · review.log`) });
      await expect(f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a2', to: 'Tracker', text: 'Look.', attachments: ['a_' + '1'.repeat(32)] })).rejects.toThrow('no longer stored');
      await expect(f.broker.hostCall('mac', { action: 'attachment_begin', owner: f.as('stranger'), name: 'x.log', mediaType: 'text/plain', byteLength: 1, sha256: 'a'.repeat(64) })).rejects.toThrow('Only an assistant');
      await expect(f.broker.hostCall('mac', { action: 'attachment_chunk', owner: worker, attachment: file.id, offset: 0, contentBase64: 'aGVsbG8' })).rejects.toThrow('Invalid file chunk');
    });
  });

  describe('replies from the final text of a turn', () => {
    const inboxOf = (f: ReturnType<typeof fixture>, botId: string) => f.state().find(team => team.inbox?.botId === botId)!;
    const received = async (f: ReturnType<typeof fixture>, text = 'Is the branch cut?') => {
      await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'q1', to: 'Chief', text });
      return inboxOf(f, ids.chief).inbox!.recent!.at(-1)!.id;
    };

    it('sends the text back to the sender as a reply that names the message, once', async () => {
      const f = fixture();
      const asked = await received(f);
      const reply = { action: 'bot_reply' as const, owner: f.as('chief'), text: 'Yes, cut at noon.', cause: { kind: 'framed' as const, answers: asked } };
      expect(await f.broker.hostCall('mac', reply)).toMatchObject({ outcome: 'delivered', messageId: expect.stringMatching(/^m[0-9a-f]{12}$/) });
      const tracker = inboxOf(f, ids.tracker);
      expect(parseTaskInputs(tracker.messages.at(-1)!.text)).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Chief', replyTo: asked, body: 'Yes, cut at noon.' })]);
      expect(await f.broker.hostCall('mac', reply)).toMatchObject({ outcome: 'duplicate' });
      expect(inboxOf(f, ids.tracker).messages).toHaveLength(tracker.messages.length);
    });

    it('cuts a final text at 300 characters with a pointer to the rest', async () => {
      const f = fixture();
      const asked = await received(f);
      await f.broker.hostCall('mac', { action: 'bot_reply', owner: f.as('chief'), text: 'x'.repeat(2000), cause: { kind: 'framed', answers: asked } });
      const [input] = parseTaskInputs(inboxOf(f, ids.tracker).messages.at(-1)!.text)!;
      const body = (input as { body: string }).body;
      expect(body).toHaveLength(300);
      expect(body).toMatch(/^x+ … \[cut; read the rest of Chief's answer with read_bot\]$/);
    });

    it('sends nothing when the turn already answered its sender with message, to whom it was said or by reply_to', async () => {
      const f = fixture();
      const asked = await received(f);
      const turn = { kind: 'framed' as const, answers: asked };
      await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a1', to: 'Tracker', text: 'Working on it.', cause: turn });
      const before = inboxOf(f, ids.tracker).messages.length;
      expect(await f.broker.hostCall('mac', { action: 'bot_reply', owner: f.as('chief'), text: 'Done.', cause: turn })).toMatchObject({ outcome: 'duplicate' });
      expect(inboxOf(f, ids.tracker).messages).toHaveLength(before);
      // A message to another bot in that turn does not count as answering the sender.
      const f2 = fixture();
      const asked2 = await received(f2);
      await f2.broker.hostCall('mac', { action: 'create_bot', owner: f2.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
      await f2.broker.hostCall('mac', { action: 'bot_message', owner: f2.as('chief'), operationId: 'a2', to: 'Reviewer', text: 'Look.', cause: { kind: 'framed', answers: asked2 } });
      expect(await f2.broker.hostCall('mac', { action: 'bot_reply', owner: f2.as('chief'), text: 'Asked the reviewer.', cause: { kind: 'framed', answers: asked2 } })).toMatchObject({ outcome: 'delivered' });
    });

    it('answers a temporary bot that wrote, refuses a message that is not in the bot\'s inbox, and says so when the sender is gone', async () => {
      const f = fixture();
      await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
      const worker = f.as(f.task().members[0]!.nativeSessionId!);
      await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'w1', to: 'Tracker', text: 'Which branch?' });
      const asked = inboxOf(f, ids.tracker).inbox!.recent!.at(-1)!.id;
      expect(await f.broker.hostCall('mac', { action: 'bot_reply', owner: f.as('tracker'), text: 'release/0.3', cause: { kind: 'framed', answers: asked } })).toMatchObject({ outcome: 'delivered' });
      expect(f.inputs(f.task(), 0).at(-1)).toMatchObject({ kind: 'message', from: 'Tracker', body: 'release/0.3' });
      expect(await f.broker.hostCall('mac', { action: 'bot_reply', owner: f.as('tracker'), text: 'Hi', cause: { kind: 'framed', answers: 'm000000000000' } })).toMatchObject({ outcome: 'forbidden' });
      // A temporary bot has no inbox, so it never answers from final text.
      expect(await f.broker.hostCall('mac', { action: 'bot_reply', owner: worker, text: 'Hi', cause: { kind: 'framed', answers: asked } })).toMatchObject({ outcome: 'forbidden' });
      await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'w2', to: 'Tracker', text: 'And the tag?' });
      const second = inboxOf(f, ids.tracker).inbox!.recent!.at(-1)!.id;
      await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'w3', to: 'chief', text: 'Done.', status: 'done' });
      expect(await f.broker.hostCall('mac', { action: 'bot_reply', owner: f.as('tracker'), text: 'v0.3', cause: { kind: 'framed', answers: second } })).toMatchObject({ outcome: 'unreachable' });
    });
  });
});
