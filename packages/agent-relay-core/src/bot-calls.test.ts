import { describe, expect, it } from 'vitest';
import { parseTaskInputs, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { temporaryBotId } from './bot-calls.js';

// Bots call as their own sessions. The groups and the Hosts are stubs; the broker, tasks, inboxes and their validation are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = { window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } } as unknown as WindowGroup;

function fixture() {
  let state: SavedTeam[] = [], now = 100, workers = 0;
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async (_hostId, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => [group], capable: () => true },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'codex', nativeSessionId });
  const task = () => state.find(team => team.task)!;
  const inputs = (team: SavedTeam, to: number) => team.messages.filter(message => message.to === team.members[to]!.id).flatMap(message => parseTaskInputs(message.text) ?? []);
  return { broker, as, task, inputs, state: () => state };
}

describe('bots calling as their own sessions', () => {
  it('starts a temporary bot that its organizer lists, and that reports, asks and tells progress to it', async () => {
    const f = fixture();
    const created = await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review the release branch.', lifetime: 'temporary', message: 'Start with the changelog.' }) as { botId: string; status: string };
    expect(created).toMatchObject({ botId: temporaryBotId(f.task().id), status: 'working' });
    expect(f.inputs(f.task(), 0)).toEqual([expect.objectContaining({ kind: 'brief', title: 'Reviewer', brief: 'Review the release branch.\n\nStart with the changelog.' })]);
    expect(await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('chief') })).toEqual({ bots: [
      { id: created.botId, name: 'Reviewer', kind: 'temporary', organizer: 'you', status: 'working', mission: 'Review the release branch.\n\nStart with the changelog.' },
      { id: ids.tracker, name: 'Tracker', kind: 'standing' }] });
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'p1', to: 'organizer', text: 'Changelog read.', status: 'progress' });
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'q1', to: 'Chief', text: 'Include the hotfix?', status: 'needs_input' });
    expect(f.task().task!.state).toBe('needs_input');
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a1', to: 'Reviewer', text: 'Yes.' });
    expect(f.task().task!.state).toBe('working');
    await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'd1', to: 'organizer', text: 'Two issues, both in the notes.', status: 'done' });
    expect(f.task().task!.state).toBe('done');
    expect(f.inputs(f.task(), 1).map(input => input.kind)).toEqual(['progress', 'question', 'done']);
  });

  it('lets other bots write to a temporary bot, which messages standing bots in their inboxes, and only its organizer stops it', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 't1', to: 'Reviewer', text: 'The build is green.' });
    expect(f.inputs(f.task(), 0).at(-1)).toMatchObject({ kind: 'message', from: 'Tracker', body: 'The build is green.' });
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: worker, operationId: 'r1', to: 'Tracker', text: 'Thanks.' })).toMatchObject({ outcome: 'delivered' });
    const inbox = f.state().find(team => team.inbox?.botId === ids.tracker)!;
    expect(parseTaskInputs(inbox.messages.at(-1)!.text)).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Reviewer', body: 'Thanks.' })]);
    await expect(f.broker.hostCall('mac', { action: 'stop_bot', owner: f.as('tracker'), bot: 'Reviewer' })).rejects.toThrow('You do not organize');
    expect(await f.broker.hostCall('mac', { action: 'bot_session', owner: f.as('chief'), bot: 'Reviewer' })).toEqual(worker);
    expect(await f.broker.hostCall('mac', { action: 'stop_bot', owner: f.as('chief'), bot: 'Reviewer' })).toMatchObject({ status: 'cancelled' });
  });
});
