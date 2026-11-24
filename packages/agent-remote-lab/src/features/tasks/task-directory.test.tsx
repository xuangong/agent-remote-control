import { act } from 'react';
const act_ = (work: () => void) => act(async () => work());
import { describe, expect, it, vi } from 'vitest';
import type { BoardItem, Team, TeamTask, WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TaskDirectoryContext } from '@orchardworks/agent-client-web/react';
import { render } from '../../test/setup.js';
import { TasksList } from '../../conversation/assistant/TasksList.js';
import { BoardList } from '../../conversation/assistant/BoardList.js';
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

  it('shows a standing bot\'s board items from its inbox: open ones with their status and latest report first, then the finished', async () => {
    const item = (key: number, status: BoardItem['status'], updatedAt: number, report?: string, result?: string): BoardItem => ({ key, title: `Item ${key}`, status, assignee: 'self', links: [], version: 1, changedAt: {},
      updatedBy: 'person', updatedAt, ...(report ? { report } : {}), ...(result ? { result } : {}) });
    const inbox = { ...taskTeam('i', {}), task: undefined, members: [{ ...taskTeam('i', {}).members[1]!, nativeSessionId: 'scribe' }],
      inbox: { botId: 'b_' + '3'.repeat(32), board: { next: 4, items: [item(1, 'done', 9, undefined, 'Shipped.'), item(2, 'waiting', 5, 'Needs the build.'), item(3, 'working', 7)] } } } as Team;
    const directory = taskDirectory([inbox], () => {});
    expect(directory.board!({ providerId: 'claude', nativeSessionId: 'other' })).toEqual([]);
    const container = await render(<BoardList board={directory.board!({ providerId: 'claude', nativeSessionId: 'scribe' })} />);
    const rows = [...container.querySelectorAll('li')];
    expect(rows.map(row => row.querySelector('.lab-assistant-session-title')!.textContent)).toEqual(['Item 3', 'Item 2', 'Item 1']);
    expect(rows[1]!.textContent).toContain('Waiting');
    for (const row of rows) await act_(() => row.querySelector<HTMLButtonElement>('.lab-assistant-session-toggle')!.click());
    expect(rows[1]!.textContent).toContain('Needs the build.');
    expect(rows[2]!.textContent).toContain('Result: Shipped.');
  });

  it('lists a bot\'s standing staff, from their records', () => {
    const groups = [{ window: { id: 'g', views: [] }, bots: { rank: 'm', members: { a: { botId: 'b_' + '1'.repeat(32), name: 'Chief' }, b: { botId: 'b_' + '2'.repeat(32), name: 'Scribe', chief: 'b_' + '1'.repeat(32) } } } }] as never;
    const directory = taskDirectory([], () => {}, undefined, groups);
    expect(directory.staff!('b_' + '1'.repeat(32))).toEqual([{ botId: 'b_' + '2'.repeat(32), name: 'Scribe' }]);
    expect(directory.staff!('b_' + '2'.repeat(32))).toEqual([]);
  });

  it('names a bot\'s chief and the standing bots it may move to: not itself and not its own staff', async () => {
    const id = (n: number) => 'b_' + String(n).repeat(32);
    const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [] }, bots: { rank: 'm', members: {
      v1: { botId: id(1), name: 'Chief' }, v2: { botId: id(2), name: 'Tracker', chief: id(1) }, v3: { botId: id(3), name: 'Reviewer', chief: id(2) }, v4: { botId: id(4), name: 'Scribe' } } } }] as unknown as WindowGroup[];
    const moved: Array<[string, string | null]> = [];
    const directory = taskDirectory([], () => {}, async () => {}, groups, async (botId, chief) => { moved.push([botId, chief]); });
    expect(directory.chief!(id(2))).toEqual({ current: { botId: id(1), name: 'Chief' }, choices: [{ botId: id(1), name: 'Chief' }, { botId: id(4), name: 'Scribe' }] });
    expect(directory.chief!(id(4))).toEqual({ choices: [{ botId: id(1), name: 'Chief' }, { botId: id(2), name: 'Tracker' }, { botId: id(3), name: 'Reviewer' }] });
    await directory.setChief!(id(3), null);
    expect(moved).toEqual([[id(3), null]]);
    expect(taskDirectory([], () => {}).setChief).toBeUndefined();
  });
});
