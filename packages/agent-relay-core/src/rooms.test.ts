import { describe, expect, it } from 'vitest';
import { isTeam, parseTaskInputs, ROOM_TURN_LIMIT, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';
import { ROOM_TURN_TIMEOUT_MS } from './rooms.js';

// A room asks one member at a time with the messages it has not seen. Groups and Hosts are stubs; the broker is real.
const group: WindowGroup = { window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker'], ['v3', 'scribe']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } })) } as unknown as WindowGroup['window'],
  bots: { rank: 'm', members: { v1: { name: 'Chief', mode: 'coordinator' }, v2: { name: 'Tracker', mode: 'coordinator' }, v3: { name: 'Scribe', mode: 'coordinator' } } } };

function fixture() {
  let state: SavedTeam[] = [], now = 1_000_000;
  const broker = new TeamBroker({
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => now, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async (_, seat) => ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: '/repo' }),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => [group], capable: () => true },
  });
  const owner = (nativeSessionId: string) => ({ providerId: 'claude', nativeSessionId });
  const room = () => state[0]!;
  const asked = () => { const team = room(); return team.members.find(member => member.id === team.room!.speaker)?.name; };
  const turns = (name: string) => room().messages.filter(message => message.to === room().members.find(member => member.name === name)!.id).map(message => parseTaskInputs(message.text)?.[0]);
  return { broker, owner, room, asked, turns, advance: (ms: number) => { now += ms; } };
}

describe('rooms', () => {
  it('asks one member at a time with what it has not seen, and ends when a member says it is done', async () => {
    const f = fixture();
    const opened = await f.broker.hostCall('mac', { action: 'open_room', owner: f.owner('chief'), operationId: 'op', name: 'Release', topic: 'Is 1.2 ready to ship?', members: ['Tracker', 'Scribe'], minutes: 30 }) as { roomId: string };
    expect(opened).toEqual({ roomId: f.room().id, members: ['Chief', 'Tracker', 'Scribe'] });
    expect(f.asked()).toBe('Tracker');
    expect(f.turns('Tracker')).toEqual([{ kind: 'room', roomId: opened.roomId, name: 'Release', count: 1, body: 'Chief: Is 1.2 ready to ship?' }]);
    await expect(f.broker.hostCall('mac', { action: 'room_say', owner: f.owner('scribe'), roomId: opened.roomId, text: 'Me first' })).rejects.toThrow('not your turn');
    await f.broker.hostCall('mac', { action: 'room_say', owner: f.owner('tracker'), roomId: opened.roomId, text: 'Two bugs are open.' });
    expect(f.asked()).toBe('Scribe');
    expect(f.turns('Scribe')[0]).toMatchObject({ count: 2, body: 'Chief: Is 1.2 ready to ship?\nTracker: Two bugs are open.' });
    await f.broker.hostCall('mac', { action: 'room_pass', owner: f.owner('scribe'), roomId: opened.roomId });
    // Chief has not seen Tracker's words; Scribe passed.
    expect(f.asked()).toBe('Chief');
    expect(f.turns('Chief')[0]).toMatchObject({ count: 1, body: 'Tracker: Two bugs are open.' });
    // The person writes; it waits for the member asked now, then reaches the others.
    await f.broker.action({ teamId: opened.roomId, action: 'room_post', operationId: 'p1', text: 'Ship without the second bug.' });
    await f.broker.action({ teamId: opened.roomId, action: 'room_post', operationId: 'p1', text: 'Ship without the second bug.' });
    expect(f.room().room!.transcript.filter(entry => entry.from === 'person')).toHaveLength(1);
    expect(f.asked()).toBe('Chief');
    const result = await f.broker.hostCall('mac', { action: 'room_say', owner: f.owner('chief'), roomId: opened.roomId, text: 'Ship 1.2 after fixing the first bug.', done: true });
    expect(result).toEqual({ roomId: opened.roomId, state: 'done' });
    expect(f.room().room).toMatchObject({ state: 'done', result: { text: 'Ship 1.2 after fixing the first bug.' } });
    expect(f.room().room!.speaker).toBeUndefined();
    await expect(f.broker.action({ teamId: opened.roomId, action: 'room_post', operationId: 'p2', text: 'More' })).rejects.toThrow('ended');
    expect((await f.broker.hostCall('mac', { action: 'poll' }) as unknown[]).every(isTeam)).toBe(true);
  });

  it('waits for something new when everyone passed, and closes when its time runs out or the person ends it', async () => {
    const f = fixture();
    const { roomId } = await f.broker.hostCall('mac', { action: 'open_room', owner: f.owner('chief'), operationId: 'op', name: 'Quiet', topic: 'Anything?', members: ['Tracker'], minutes: 5 }) as { roomId: string };
    await f.broker.hostCall('mac', { action: 'room_pass', owner: f.owner('tracker'), roomId });
    expect(f.asked()).toBeUndefined();
    expect(f.room().room!.state).toBe('open');
    f.advance(6 * 60_000);
    await f.broker.action({ teamId: roomId, action: 'room_post', operationId: 'late', text: 'Still there?' });
    expect(f.room().room!.state).toBe('closed');
    const g = fixture();
    const second = await g.broker.hostCall('mac', { action: 'open_room', owner: g.owner('chief'), operationId: 'op', name: 'R', topic: 'T', members: ['Tracker'], minutes: 5 }) as { roomId: string };
    await g.broker.action({ teamId: second.roomId, action: 'close_room' });
    expect(g.room().room).toMatchObject({ state: 'closed' });
    expect(g.room().room!.speaker).toBeUndefined();
  });

  it('moves on from a member that does not answer, and stops after its turns', async () => {
    const f = fixture();
    const { roomId } = await f.broker.hostCall('mac', { action: 'open_room', owner: f.owner('chief'), operationId: 'op', name: 'R', topic: 'T', members: ['Tracker', 'Scribe'], minutes: 240 }) as { roomId: string };
    expect(f.asked()).toBe('Tracker');
    f.advance(ROOM_TURN_TIMEOUT_MS);
    await f.broker.action({ teamId: roomId, action: 'room_post', operationId: 'nudge', text: 'Anyone?' });
    expect(f.asked()).toBe('Scribe');
    let speaker = 'scribe';
    for (let turn = 0; f.room().room!.state === 'open' && turn < ROOM_TURN_LIMIT + 2; turn++) {
      const name = f.asked()!.toLowerCase();
      await f.broker.hostCall('mac', { action: 'room_say', owner: f.owner(name), roomId, text: `Turn ${turn}` });
      speaker = name;
    }
    expect(speaker).toBeDefined();
    expect(f.room().room).toMatchObject({ state: 'closed', turns: ROOM_TURN_LIMIT });
  });

  it('lets a member speak from the session the room bound, even after its bot shows another session', async () => {
    const f = fixture();
    const { roomId } = await f.broker.hostCall('mac', { action: 'open_room', owner: f.owner('chief'), operationId: 'op', name: 'R', topic: 'T', members: ['Tracker'], minutes: 30 }) as { roomId: string };
    // The person opened another session in Tracker's tile: the directory no longer names tracker's session.
    (group.window.views[1] as { binding: { nativeSessionId: string } }).binding.nativeSessionId = 'elsewhere';
    try {
      expect(await f.broker.hostCall('mac', { action: 'room_say', owner: f.owner('tracker'), roomId, text: 'Here.', done: true })).toEqual({ roomId, state: 'done' });
      await expect(f.broker.hostCall('mac', { action: 'room_say', owner: f.owner('elsewhere'), roomId, text: 'Me?' })).rejects.toThrow('Room not found');
    } finally { (group.window.views[1] as { binding: { nativeSessionId: string } }).binding.nativeSessionId = 'tracker'; }
  });
});
