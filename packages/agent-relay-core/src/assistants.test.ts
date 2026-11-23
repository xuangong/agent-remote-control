import { describe, expect, it } from 'vitest';
import { BOT_INSTRUCTIONS_VERSION, isTeam, parseTaskInputs, type TeamSeat, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';

// Assistants message each other on links: Teams of two main sessions the Relay binds where they are. The groups and the Hosts are
// stubs; the broker, its validation and the framing are real.
const group = (id: string, views: Array<[string, string, string]>, bots?: WindowGroup['bots']): WindowGroup => ({
  window: { id, title: id, revision: 1, views: views.map(([viewId, hostId, nativeSessionId]) => ({ id: viewId, placement: 'primary',
    binding: { hostId, providerId: 'claude', nativeSessionId, title: `Session ${nativeSessionId}` } })) } as unknown as WindowGroup['window'],
  ...(bots ? { bots } : {}) });

const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32), quiet: 'b_' + '3'.repeat(32), solo: 'b_' + '4'.repeat(32) };
function fixture(options: { capable?: (hostId: string) => boolean; offline?: string; groups?: WindowGroup[] } = {}) {
  let state: SavedTeam[] = [], now = 100;
  const seats: TeamSeat[] = [];
  const groups = options.groups ?? [group('g1', [['v1', 'mac', 'chief'], ['v2', 'pc', 'tracker'], ['v3', 'mac', 'quiet'], ['v4', 'mac', 'solo']], { rank: 'm', members: {
    v1: { botId: ids.chief, name: 'Chief', mode: 'coordinator' }, v2: { botId: ids.tracker, name: 'Tracker', mode: 'coordinator' },
    v3: { botId: ids.quiet, name: 'Quiet', hidden: true, mode: 'coordinator' }, v4: { botId: ids.solo, name: 'Solo' } } })];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async (hostId, seat) => { if (hostId === options.offline) throw new Error('The Host is offline.'); seats.push(seat); return { ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo' }; },
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: options.capable ?? (() => true) },
  });
  const chief = { providerId: 'claude', nativeSessionId: 'chief' }, tracker = { providerId: 'claude', nativeSessionId: 'tracker' };
  const solo = { providerId: 'claude', nativeSessionId: 'solo' };
  return { broker, seats, state: () => state, chief, tracker, solo };
}

describe('assistants messaging one another', () => {
  it('names an assistant by its bot id, which a move between groups keeps', async () => {
    const botId = 'b_' + 'c'.repeat(32);
    const moved = [group('g2', [['v7', 'mac', 'chief'], ['v2', 'pc', 'tracker']], { rank: 'm', members: {
      v7: { botId, name: 'Chief', mode: 'coordinator' }, v2: { name: 'Tracker', mode: 'coordinator' } } })];
    const f = fixture({ groups: moved });
    expect(await f.broker.hostCall('pc', { action: 'list_assistants', owner: f.tracker })).toEqual({ assistants: [{ id: botId, name: 'Chief' }] });
  });

  it('lets every bot reach every other bot, and a session that is no bot start nothing', async () => {
    const f = fixture();
    expect(await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.solo, to: 'Chief', text: 'Hello.', operationId: 'op' })).toMatchObject({ outcome: 'delivered' });
    expect(await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'Solo', text: 'Hello.', operationId: 'op' })).toMatchObject({ outcome: 'delivered' });
    const stranger = { providerId: 'claude', nativeSessionId: 'stranger' };
    for (const call of [{ action: 'list_assistants', owner: stranger }, { action: 'message_assistant', owner: stranger, to: 'Chief', text: 'Hello.', operationId: 'op' },
      { action: 'create_task', owner: stranger, operationId: 'task', title: 'Fix', brief: 'Fix it.' }] as const)
      await expect(f.broker.hostCall('mac', call)).rejects.toThrow('Only an assistant');
  });

  it('lists the account\'s other assistants by name to an assistant\'s main session, and to nothing else', async () => {
    const f = fixture();
    expect(await f.broker.hostCall('mac', { action: 'list_assistants', owner: f.chief })).toEqual({ assistants: [{ id: ids.tracker, name: 'Tracker' }, { id: ids.solo, name: 'Solo' }] });
    await expect(f.broker.hostCall('mac', { action: 'list_assistants', owner: { providerId: 'claude', nativeSessionId: 'worker' } })).rejects.toThrow('Only an assistant');
  });

  it('delivers a framed message to the other bot\'s inbox, after its standing instructions, once per operation', async () => {
    const f = fixture();
    const sent = await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'tracker', text: 'Is the release branch cut?', operationId: 'op' }) as { messageId: string; outcome: string };
    expect(sent).toEqual({ messageId: expect.stringMatching(/^m[0-9a-f]{12}$/), outcome: 'delivered' });
    expect(await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'Tracker', text: 'Is the release branch cut?', operationId: 'op' })).toEqual({ ...sent, outcome: 'duplicate' });
    const [inbox] = f.state();
    expect(inbox!.inbox?.botId).toBe(ids.tracker);
    expect(inbox!.members.map(member => [member.role, member.hostId, member.nativeSessionId, member.creation])).toEqual([['requester', 'pc', 'tracker', 'ready']]);
    expect(f.seats.map(seat => seat.inbox?.botId)).toEqual([ids.tracker]);
    expect(inbox!.messages.map(message => message.text.split('\n')[0])).toEqual([`[Your standing instructions · v${BOT_INSTRUCTIONS_VERSION}]`, expect.stringContaining('[Message from Chief')]);
    expect(parseTaskInputs(inbox!.messages[1]!.text)).toEqual([{ kind: 'assistant', messageId: sent.messageId, from: 'Chief', body: 'Is the release branch cut?' }]);
    // The receiving Controller sees the inbox, which stays a valid Team; the sender's does not.
    expect(await f.broker.hostCall('pc', { action: 'poll' })).toEqual([expect.objectContaining({ id: inbox!.id })]);
    expect(await f.broker.hostCall('mac', { action: 'poll' })).toEqual([]);
    expect(isTeam(inbox)).toBe(true);
  });

  it('answers a message it received, and goes on however long the replies run: the chain records their depth', async () => {
    const f = fixture();
    let last = (await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'Tracker', text: 'Ping 1', operationId: 'p1' }) as { messageId: string }).messageId;
    await expect(f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'Tracker', text: 'Self', operationId: 'self', replyTo: last })).rejects.toThrow('reply_to must name');
    const sides = [['pc', f.tracker, 'Chief'], ['mac', f.chief, 'Tracker']] as const;
    for (let hop = 2; hop <= 10; hop++) {
      const [hostId, owner, to] = sides[hop % 2]!;
      last = (await f.broker.hostCall(hostId, { action: 'message_assistant', owner, to, text: `Ping ${hop}`, operationId: `p${hop}`, replyTo: last }) as { messageId: string }).messageId;
    }
    expect(f.state().map(team => team.inbox?.botId).sort()).toEqual([ids.chief, ids.tracker].sort());
    const replies = f.state().flatMap(team => team.messages).map(message => parseTaskInputs(message.text)?.[0]).filter(input => input?.kind === 'assistant' && input.replyTo);
    expect(replies).toHaveLength(9);
  });

  it('refuses unknown, hidden-by-name ambiguity and self the same way, and holds a message for an offline Host', async () => {
    const f = fixture({ offline: 'pc' });
    for (const to of ['Nobody', 'Chief']) await expect(f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to, text: 'Hi', operationId: to })).rejects.toThrow('No assistant of this account');
    expect(await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: ids.tracker, text: 'Hi', operationId: 'held' })).toMatchObject({ outcome: 'held' });
  });

  it('is refused to a Controller that does not run links', async () => {
    const f = fixture({ capable: hostId => hostId !== 'mac' });
    await expect(f.broker.hostCall('mac', { action: 'list_assistants', owner: f.chief })).rejects.toThrow('Update the Controller');
  });
});
