import { describe, expect, it } from 'vitest';
import { ASSISTANT_MESSAGE_HOP_LIMIT, isTeam, parseTaskInputs, type TeamSeat, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';

// Assistants message each other on links: Teams of two main sessions the Relay binds where they are. The groups and the Hosts are
// stubs; the broker, its validation and the framing are real.
const group = (id: string, views: Array<[string, string, string]>, bots?: WindowGroup['bots']): WindowGroup => ({
  window: { id, title: id, revision: 1, views: views.map(([viewId, hostId, nativeSessionId]) => ({ id: viewId, placement: 'primary',
    binding: { hostId, providerId: 'claude', nativeSessionId, title: `Session ${nativeSessionId}` } })) } as unknown as WindowGroup['window'],
  ...(bots ? { bots } : {}) });

function fixture(options: { capable?: (hostId: string) => boolean; offline?: string } = {}) {
  let state: SavedTeam[] = [], now = 100;
  const seats: TeamSeat[] = [];
  const groups = [group('g1', [['v1', 'mac', 'chief'], ['v2', 'pc', 'tracker'], ['v3', 'mac', 'quiet']], { rank: 'm', members: { v1: { name: 'Chief' }, v2: { name: 'Tracker' }, v3: { name: 'Quiet', hidden: true } } })];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async (hostId, seat) => { if (hostId === options.offline) throw new Error('The Host is offline.'); seats.push(seat); return { ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo' }; },
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: options.capable ?? (() => true) },
  });
  const chief = { providerId: 'claude', nativeSessionId: 'chief' }, tracker = { providerId: 'claude', nativeSessionId: 'tracker' };
  return { broker, seats, state: () => state, chief, tracker };
}

describe('assistants messaging one another', () => {
  it('lists the account\'s other assistants by name to an assistant\'s main session, and to nothing else', async () => {
    const f = fixture();
    expect(await f.broker.hostCall('mac', { action: 'list_assistants', owner: f.chief })).toEqual({ assistants: [{ id: 'g1/v2', name: 'Tracker' }] });
    await expect(f.broker.hostCall('mac', { action: 'list_assistants', owner: { providerId: 'claude', nativeSessionId: 'worker' } })).rejects.toThrow('Only an assistant');
  });

  it('delivers a framed message on a link of the two main sessions, once per operation', async () => {
    const f = fixture();
    const sent = await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'tracker', text: 'Is the release branch cut?', operationId: 'op' }) as { messageId: string; outcome: string };
    expect(sent).toEqual({ messageId: expect.stringMatching(/^m[0-9a-f]{12}$/), outcome: 'delivered' });
    expect(await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'Tracker', text: 'Is the release branch cut?', operationId: 'op' })).toEqual(sent);
    const [link] = f.state();
    expect(link!.link?.assistants).toEqual(['g1/v1', 'g1/v2']);
    expect(link!.members.map(member => [member.role, member.hostId, member.nativeSessionId, member.creation])).toEqual([['requester', 'mac', 'chief', 'ready'], ['requester', 'pc', 'tracker', 'ready']]);
    expect(f.seats.map(seat => seat.link?.peer)).toEqual(['Tracker', 'Chief']);
    expect(link!.messages).toHaveLength(1);
    expect(parseTaskInputs(link!.messages[0]!.text)).toEqual([{ kind: 'assistant', messageId: sent.messageId, from: 'Chief', body: 'Is the release branch cut?' }]);
    expect(link!.messages[0]!.to).toBe(link!.members[1]!.id);
    // Each Controller sees the link, which stays a valid Team.
    expect(await f.broker.hostCall('pc', { action: 'poll' })).toEqual([expect.objectContaining({ id: link!.id })]);
    expect((await f.broker.hostCall('mac', { action: 'poll' }) as unknown[]).every(isTeam)).toBe(true);
  });

  it('answers a message on the same link and stops a chain of replies at its limit', async () => {
    const f = fixture();
    let last = (await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'Tracker', text: 'Ping 1', operationId: 'p1' }) as { messageId: string }).messageId;
    await expect(f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'Tracker', text: 'Self', operationId: 'self', replyTo: last })).rejects.toThrow('reply_to must name');
    const sides = [['pc', f.tracker, 'Chief'], ['mac', f.chief, 'Tracker']] as const;
    for (let hop = 2; hop <= ASSISTANT_MESSAGE_HOP_LIMIT; hop++) {
      const [hostId, owner, to] = sides[hop % 2]!;
      last = (await f.broker.hostCall(hostId, { action: 'message_assistant', owner, to, text: `Ping ${hop}`, operationId: `p${hop}`, replyTo: last }) as { messageId: string }).messageId;
    }
    const [hostId, owner, to] = sides[(ASSISTANT_MESSAGE_HOP_LIMIT + 1) % 2]!;
    await expect(f.broker.hostCall(hostId, { action: 'message_assistant', owner, to, text: 'One more', operationId: 'more', replyTo: last })).rejects.toThrow('tell the person');
    expect(f.state()).toHaveLength(1);
    const replies = f.state()[0]!.messages.map(message => parseTaskInputs(message.text)?.[0]).filter(input => input?.kind === 'assistant' && input.replyTo);
    expect(replies).toHaveLength(ASSISTANT_MESSAGE_HOP_LIMIT - 1);
  });

  it('refuses unknown, hidden-by-name ambiguity and self the same way, and holds a message for an offline Host', async () => {
    const f = fixture({ offline: 'pc' });
    for (const to of ['Nobody', 'Chief']) await expect(f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to, text: 'Hi', operationId: to })).rejects.toThrow('No assistant of this account');
    expect(await f.broker.hostCall('mac', { action: 'message_assistant', owner: f.chief, to: 'g1/v2', text: 'Hi', operationId: 'held' })).toMatchObject({ outcome: 'held' });
  });

  it('is refused to a Controller that does not run links', async () => {
    const f = fixture({ capable: hostId => hostId !== 'mac' });
    await expect(f.broker.hostCall('mac', { action: 'list_assistants', owner: f.chief })).rejects.toThrow('Update the Controller');
  });
});
