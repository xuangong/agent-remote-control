import { act } from 'react';
const act_ = (work: () => void) => act(async () => work());
import { describe, expect, it, vi } from 'vitest';
import type { Team, TeamTask, WorkItem } from '@orchardworks/agent-remote-protocol';
import { TaskDirectoryContext } from '@orchardworks/agent-client-web/react';
import { render } from '../../test/setup.js';
import { TasksList } from '../../conversation/assistant/TasksList.js';
import { WorkList } from '../../conversation/assistant/WorkList.js';
import { taskDirectory } from './task-directory.js';

function taskTeam(id: string, task: Partial<TeamTask>, worker: { ready?: boolean; owner?: string } = {}): Team {
  const member = { hostId: 'mac', providerId: 'claude', responsibility: '', activity: 'idle' as const, summary: '', updatedAt: 1 };
  return { id, operationId: id, revision: 1, title: 'T', status: 'active', createdAt: 1, updatedAt: 1, source: { hostId: 'mac', providerId: 'claude', nativeSessionId: 'main', title: 'Chief' }, messages: [],
    members: [{ ...member, id: `${id}-w`, role: 'leader', name: 'Worker', creation: worker.ready === false ? 'pending' : 'ready', ...(worker.ready === false ? {} : { nativeSessionId: `${id}-session` }) },
      { ...member, id: `${id}-o`, role: 'requester', name: 'Chief', creation: 'ready', nativeSessionId: worker.owner ?? 'main' }],
    task: { title: `Task ${id}`, brief: 'B', state: 'working', createdAt: 1, updatedAt: 1, ...task } as TeamTask } as Team;
}

describe('the task directory', () => {
  it('opens a task\'s worker once its session exists, and lists a session\'s own tasks newest first', () => {
    const open = vi.fn();
    const directory = taskDirectory([taskTeam('a', { updatedAt: 1 }), taskTeam('b', { updatedAt: 5 }, { ready: false }), taskTeam('c', {}, { owner: 'other' })], open);
    expect(directory.canOpen('a')).toBe(true);
    expect(directory.canOpen('b')).toBe(false);
    directory.open('b');
    directory.open('a');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ hostId: 'mac', providerId: 'claude', nativeSessionId: 'a-session', title: 'Task a' });
    expect(directory.owned({ providerId: 'claude', nativeSessionId: 'main' }).map(task => [task.taskId, task.state])).toEqual([['b', 'queued'], ['a', 'working']]);
  });

  it('groups a session\'s tasks in its details, and a row opens the worker', async () => {
    const open = vi.fn();
    const teams = [taskTeam('w', {}), taskTeam('n', { state: 'needs_input', waiting: { reason: 'question', text: 'Which branch?', since: 2 } }),
      taskTeam('d', { state: 'done', result: { status: 'done', summary: 'Logs attached.', reportedAt: 3 } })];
    const directory = taskDirectory(teams, open);
    const container = await render(<TaskDirectoryContext.Provider value={directory}><TasksList tasks={directory.owned({ providerId: 'claude', nativeSessionId: 'main' })} /></TaskDirectoryContext.Provider>);
    expect([...container.querySelectorAll('section')].map(section => [section.getAttribute('aria-label'), [...section.querySelectorAll('li')].length]))
      .toEqual([['Needs you', 1], ['Working', 1], ['Done', 1]]);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button.lab-assistant-session-title')].find(button => button.textContent === 'Task n')!.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'n-session' }));
  });

  it('stops a running task, marks it done or keeps its bot from its row, and offers only keeping on a finished one', async () => {
    const act = vi.fn(async () => {});
    const directory = taskDirectory([taskTeam('w', {}), taskTeam('d', { state: 'done', result: { status: 'done', summary: 'Done.', reportedAt: 3 } })], () => {}, act);
    const container = await render(<TaskDirectoryContext.Provider value={directory}><TasksList tasks={directory.owned({ providerId: 'claude', nativeSessionId: 'main' })} /></TaskDirectoryContext.Provider>);
    const rows = [...container.querySelectorAll('li')];
    for (const row of rows) await act_(() => row.querySelector<HTMLButtonElement>('.lab-assistant-session-toggle')!.click());
    expect(rows.map(row => [...row.querySelectorAll('.lab-assistant-task-actions button')].map(button => button.textContent))).toEqual([['Mark done', 'Stop', 'Keep as a bot'], ['Keep as a bot']]);
    await act_(() => [...rows[0]!.querySelectorAll<HTMLButtonElement>('.lab-assistant-task-actions button')].find(button => button.textContent === 'Stop')!.click());
    expect(act).toHaveBeenCalledWith('w', 'cancel_task');
    await act_(() => rows[1]!.querySelector<HTMLButtonElement>('.lab-assistant-task-actions button')!.click());
    expect(act).toHaveBeenCalledWith('d', 'keep_task');
  });

  it('shows a standing bot\'s work items from its inbox: open ones with their phase and next step first', async () => {
    const item = (id: string, phase: WorkItem['phase'], updatedAt: number, next?: string): WorkItem => ({ id, title: `Work ${id}`, phase, summary: `Summary ${id}`, updatedAt, ...(next ? { next } : {}) });
    const inbox = { ...taskTeam('i', {}), task: undefined, members: [{ ...taskTeam('i', {}).members[1]!, nativeSessionId: 'scribe' }],
      inbox: { botId: 'b_' + '3'.repeat(32), work: [item('w_000000000001', 'done', 9), item('w_000000000002', 'waiting', 5, 'Ask the person.'), item('w_000000000003', 'in_progress', 7)] } } as Team;
    const directory = taskDirectory([inbox], () => {});
    expect(directory.work!({ providerId: 'claude', nativeSessionId: 'other' })).toEqual([]);
    const container = await render(<WorkList work={directory.work!({ providerId: 'claude', nativeSessionId: 'scribe' })} />);
    const rows = [...container.querySelectorAll('li')];
    expect(rows.map(row => row.querySelector('.lab-assistant-session-title')!.textContent)).toEqual(['Work w_000000000003', 'Work w_000000000002', 'Work w_000000000001']);
    expect(rows[1]!.textContent).toContain('Waiting');
    for (const row of rows) await act_(() => row.querySelector<HTMLButtonElement>('.lab-assistant-session-toggle')!.click());
    expect(rows[1]!.textContent).toContain('Next: Ask the person.');
  });

  it('lists the standing bots a bot organizes, from their records', () => {
    const groups = [{ window: { id: 'g', views: [] }, bots: { rank: 'm', members: { a: { botId: 'b_' + '1'.repeat(32), name: 'Chief' }, b: { botId: 'b_' + '2'.repeat(32), name: 'Scribe', organizer: 'b_' + '1'.repeat(32) } } } }] as never;
    const directory = taskDirectory([], () => {}, undefined, groups);
    expect(directory.organized!('b_' + '1'.repeat(32))).toEqual([{ botId: 'b_' + '2'.repeat(32), name: 'Scribe' }]);
    expect(directory.organized!('b_' + '2'.repeat(32))).toEqual([]);
  });
});
