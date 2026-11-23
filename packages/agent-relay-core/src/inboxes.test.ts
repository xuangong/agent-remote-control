import { describe, expect, it } from 'vitest';
import { isTeam, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';

// A bot's inbox is a Team of its main session alone. The groups and the Host are stubs; the broker and its validation are real.
const botId = 'b_' + 'a'.repeat(32);
function fixture(mission?: string) {
  const details: Record<string, unknown> = { botId, name: 'Chief', ...(mission ? { mission } : {}) };
  const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [{ id: 'v1', placement: 'primary', binding: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'chief', title: 'chief' } }] },
    bots: { rank: 'm', members: { v1: details } } }] as unknown as WindowGroup[];
  let state: SavedTeam[] = [];
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => 1, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo' }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true },
  });
  const inboxes = () => state.filter(team => team.inbox);
  const poll = () => broker.hostCall('mac', { action: 'bot_enablement' });
  return { broker, details, inboxes, poll };
}

describe('bot inboxes', () => {
  it('gives a bot an inbox of its main session and sends its standing instructions once, again when its mission changes', async () => {
    const f = fixture('Lead the release.');
    await f.poll();
    expect(f.inboxes()).toHaveLength(1);
    const inbox = f.inboxes()[0]!;
    expect(isTeam(inbox)).toBe(true);
    expect(inbox.members).toEqual([expect.objectContaining({ role: 'requester', hostId: 'mac', providerId: 'codex', nativeSessionId: 'chief', creation: 'ready' })]);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]!.text).toMatch(/^\[Your standing instructions · v2\]\n/);
    expect(inbox.messages[0]!.text).toContain('Your mission:\nLead the release.');
    await f.poll();
    expect(f.inboxes()[0]!.messages).toHaveLength(1);
    f.details.mission = 'Ship on Friday.';
    await f.poll();
    expect(f.inboxes()).toHaveLength(1);
    expect(f.inboxes()[0]!.messages.map(message => message.text.split('Your mission:\n')[1])).toEqual(['Lead the release.', 'Ship on Friday.']);
  });

  it('leaves a bot without a mission quiet until another bot messages it, which brings its instructions along', async () => {
    const f = fixture();
    await f.poll();
    expect(f.inboxes()).toEqual([]);
    f.details.mission = 'Watch the build.';
    await f.poll();
    expect(f.inboxes()[0]!.messages.map(message => message.text.split('\n')[0])).toEqual(['[Your standing instructions · v2]']);
  });

  it('gives a Host inboxes only for the bots whose main session it holds', async () => {
    const f = fixture();
    await f.broker.hostCall('linux', { action: 'bot_enablement' });
    expect(f.inboxes()).toEqual([]);
  });
});
