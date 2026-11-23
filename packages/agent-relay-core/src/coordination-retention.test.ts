import { describe, expect, it } from 'vitest';
import type { TeamMember } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, type SavedTeam } from './team-delivery.js';
import { LINK_KEEP, pruneCoordination, ROOM_ENDED_KEEP, TASK_FINISHED_KEEP } from './coordination-retention.js';

// Teams as the broker stores them; only their kind, state, age and the status of their last delivery matter here.
const seat = (id: string, role: TeamMember['role']): TeamMember => ({ id, role, hostId: 'mac', providerId: 'codex', nativeSessionId: id, name: id, responsibility: '',
  creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 });
type Delivery = 'queued' | 'accepted';
function base(id: string, at: number, delivery: Delivery): SavedTeam {
  return { id, operationId: id, revision: 1, source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'a', title: 'A' }, title: id, status: 'active', createdAt: at, updatedAt: at,
    members: [seat('a', 'requester'), seat('b', 'requester')],
    messages: [{ id: `m-${id}`, from: 'a', to: 'b', text: 'x', status: delivery, ...(delivery === 'accepted' ? { acceptance: 'started' as const } : {}), createdAt: at }] };
}
const task = (id: string, at: number, state: 'working' | 'done', delivery: Delivery = 'accepted'): SavedTeam => ({ ...base(id, at, delivery),
  task: { title: 'T', brief: 'B', state, ...(state === 'done' ? { result: { status: 'done' as const, summary: 'S', reportedAt: at } } : {}), createdAt: at, updatedAt: at } });
const room = (id: string, at: number, state: 'open' | 'closed', delivery: Delivery = 'accepted'): SavedTeam => ({ ...base(id, at, delivery),
  room: { name: 'R', topic: 'T', state, deadline: at + 1, turns: 0, seen: {}, passed: [], transcript: [] } });
const link = (id: string, at: number, delivery: Delivery = 'accepted'): SavedTeam => ({ ...base(id, at, delivery), link: { assistants: ['g/a', 'g/b'], recent: [] } });
const many = (count: number, make: (id: string, at: number) => SavedTeam, prefix: string) => Array.from({ length: count }, (_, index) => make(`${prefix}${index}`, index));
const ids = (teams: SavedTeam[]) => teams.map(team => team.id);

describe('what tasks, rooms and links leave behind', () => {
  it('keeps a bounded number of each ended kind, oldest removed first, and never what still has input on its way or is running', () => {
    const teams = [...many(TASK_FINISHED_KEEP + 2, (id, at) => task(id, at, 'done'), 't'), ...many(ROOM_ENDED_KEEP + 2, (id, at) => room(id, at, 'closed'), 'r'),
      ...many(LINK_KEEP + 2, (id, at) => link(id, at), 'l'), task('t-sending', 0, 'done', 'queued'), task('t-running', 0, 'working'), room('r-open', 0, 'open'), link('l-sending', 0, 'queued')];
    pruneCoordination(teams);
    expect(teams.filter(team => team.task?.state === 'done')).toHaveLength(TASK_FINISHED_KEEP);
    expect(teams.filter(team => team.room?.state === 'closed')).toHaveLength(ROOM_ENDED_KEEP);
    expect(teams.filter(team => team.link)).toHaveLength(LINK_KEEP);
    expect(ids(teams)).not.toEqual(expect.arrayContaining(['t0']));
    expect(ids(teams)).not.toContain('r0'); expect(ids(teams)).not.toContain('l0'); expect(ids(teams)).not.toContain('l1');
    expect(ids(teams)).toEqual(expect.arrayContaining(['t-sending', 't-running', 'r-open', 'l-sending']));
  });

  it('makes room for a new Team at the account limit by removing the oldest ended one of any kind', () => {
    const teams = [room('r-old', 1, 'closed'), link('l-newer', 2), ...many(ACCOUNT_TEAM_LIMIT - 2, (id, at) => task(id, at + 10, 'working'), 'w')];
    pruneCoordination(teams, 1);
    expect(teams).toHaveLength(ACCOUNT_TEAM_LIMIT - 1);
    expect(ids(teams)).not.toContain('r-old');
    expect(ids(teams)).toContain('l-newer');
  });
});
