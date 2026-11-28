import { beforeEach, expect, it } from 'vitest';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { readStoredTasks, writeStoredTasks } from './team-roster-store.js';

const team = (id: string) => ({ id, operationId: `op-${id}`, revision: 1, source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Worker' }, title: 'Inbox', status: 'active', inbox: { botId: 'b_' + '1'.repeat(32) },
  members: [{ id: 'm', hostId: 'mac', providerId: 'codex', role: 'requester', name: 'Coordinator', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'native' }],
  messages: [], createdAt: 1, updatedAt: 1 }) as unknown as Team;
beforeEach(() => localStorage.clear());

it('keeps the tasks last read, per scope, for the next launch', () => {
  writeStoredTasks('https://a/', [team('t1'), team('t2')]);
  expect(readStoredTasks('https://a/')?.map(item => item.id)).toEqual(['t1', 't2']);
  expect(readStoredTasks('https://b/')).toBeUndefined();
});
it('reads nothing from a damaged record and drops entries that are not Teams', () => {
  localStorage.setItem('agent-remote:recovery:https://a/:team-tasks', '{not json');
  expect(readStoredTasks('https://a/')).toBeUndefined();
  localStorage.setItem('agent-remote:recovery:https://a/:team-tasks', JSON.stringify([team('t1'), { id: 'bad' }]));
  expect(readStoredTasks('https://a/')?.map(item => item.id)).toEqual(['t1']);
});
