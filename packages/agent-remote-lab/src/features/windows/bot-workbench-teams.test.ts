import { describe, expect, it } from 'vitest';
import { createWindowView, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { botMainSession, workbenchFromTeams } from './bot-workbench-teams.js';
import { workbenchGroup } from './bot-workbench-binding.js';
import { tileStatus } from './bot-workbench-status.js';

const seat = (nativeSessionId: string, role: 'leader' | 'requester' = 'leader') => ({ id: nativeSessionId, hostId: 'local', providerId: 'claude', role, name: nativeSessionId, nativeSessionId, creation: 'ready' as const });
const inbox = (botId: string, main: string) => ({ id: `inbox-${botId}`, inbox: { botId }, members: [seat(main)], status: 'active' }) as unknown as Team;
const task = (id: string, owner: string, state: string, extra: Record<string, unknown> = {}) => ({ id: `team-${id}`, status: 'active', source: { nativeSessionId: owner },
  task: { title: `T ${id}`, state, subSessionId: id, createdAt: 1, updatedAt: 2, ...extra }, members: [seat(`n-${id}`), seat(owner, 'requester')] }) as unknown as Team;
const ask = (botId: string, at: number) => ({ id: `ask-${at}`, status: 'active', ask: { botId, from: { name: 'Room' }, lastAt: at, entries: [{}] }, members: [seat('a')] }) as unknown as Team;
const state = { expanded: new Set<string>(), held: [], previous: [] };
const bound = (): WorkspaceWindow => workbenchGroup('b1', 'Dango', { hostId: 'local', providerId: 'claude', nativeSessionId: 'view-main', title: 'Dango' }, 'wb').window;

it('takes the bot\'s main session from its inbox seat, not from the tile\'s stored binding', () => {
  expect(botMainSession([inbox('b1', 'main-now')], 'b1')?.nativeSessionId).toBe('main-now');
  const model = workbenchFromTeams(bound(), [inbox('b1', 'main-now'), task('s_1', 'main-now', 'working'), task('s_2', 'view-main', 'working')], state);
  expect(model.derived.map(tile => tile.taskId)).toEqual(['team-s_1']);
});
it('falls back to the tile\'s binding while the inbox is unknown', () => {
  const model = workbenchFromTeams(bound(), [task('s_2', 'view-main', 'idle')], state);
  expect(model.derived.map(tile => tile.taskId)).toEqual(['team-s_2']);
});
it('lists the bot\'s open answer sessions and no other bot\'s', () => {
  const model = workbenchFromTeams(bound(), [inbox('b1', 'm'), ask('b1', 5), ask('b2', 9)], state);
  expect(model.answers.map(answer => answer.lastAt)).toEqual([5]);
});
it('is not loaded until the Teams are', () => {
  expect(workbenchFromTeams(bound(), undefined, state).loaded).toBe(false);
});
it('is the free workbench for a Window with no bot', () => {
  const free: WorkspaceWindow = { ...bound(), views: [createWindowView('a', { hostId: 'local', providerId: 'claude', nativeSessionId: 'x', title: 'x' }, 'primary')] };
  const model = workbenchFromTeams(free, [task('s_1', 'x', 'working')], state);
  expect(model.botId).toBeUndefined();
  expect(model.derived).toEqual([]);
});
it('says a folded tile\'s state and its current step', () => {
  expect(tileStatus({ state: 'needs_input', currentStep: 'Waiting for approval' })).toEqual({ state: 'needs_you', mood: 'needs_you', sentence: 'Waiting for approval' });
  expect(tileStatus({ state: 'idle', lastWork: 'Ran tests' })).toMatchObject({ state: 'idle', sentence: 'Ran tests' });
  expect(tileStatus({ state: 'ended' }).state).toBe('ended');
});

import { ownerTarget } from './bot-workbench-teams.js';
describe('an item\'s owner', () => {
  const model = (teams: Team[]) => workbenchFromTeams(bound(), teams, state);
  it('is the tile of the sub-session that owns it', () => {
    const teams = [inbox('b1', 'main'), task('s_1', 'main', 'working')];
    expect(ownerTarget(teams, model(teams), 's_1')).toEqual({ kind: 'tile', id: 'sub:team-s_1' });
  });
  it('is the kept tile when the person kept the sub-session', () => {
    const teams = [inbox('b1', 'main'), task('s_1', 'main', 'working')];
    const kept = { ...bound(), views: [...bound().views, createWindowView('kept', { hostId: 'local', providerId: 'claude', nativeSessionId: 'n-s_1', title: 'T' }, 'primary')] };
    expect(ownerTarget(teams, workbenchFromTeams(kept, teams, state), 's_1')).toEqual({ kind: 'tile', id: 'kept' });
  });
  it('is the other bot for a staff bot and nothing for an unknown owner', () => {
    const teams = [inbox('b1', 'main'), inbox('b2', 'staff-main')];
    expect(ownerTarget(teams, model(teams), 'b2')).toEqual({ kind: 'bot', botId: 'b2' });
    expect(ownerTarget(teams, model(teams), 'gone')).toBeUndefined();
  });
});
