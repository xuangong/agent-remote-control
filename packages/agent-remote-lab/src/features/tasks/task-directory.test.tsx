import { act } from 'react';
const act_ = (work: () => void) => act(async () => work());
import { describe, expect, it, vi } from 'vitest';
import type { BoardItem, Team, TeamTask, WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TaskDirectoryContext } from '@orchardworks/agent-client-web/react';
import { render } from '../../test/setup.js';
import { TasksList } from '../../conversation/assistant/TasksList.js';
import { bringBackText, taskDirectory } from './task-directory.js';
import { translator } from '@orchardworks/agent-client';

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

  describe('the boards of bots', () => {
    const id = (n: number) => 'b_' + String(n).repeat(32);
    const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [] }, bots: { rank: 'm', members: { v1: { botId: id(1), name: 'Chief' }, v2: { botId: id(2), name: 'Tracker', chief: id(1) } } } }] as unknown as WindowGroup[];
    const item = (key: number, status: BoardItem['status'], updatedAt: number): BoardItem => ({ key, title: `Item ${key}`, status, assignee: 'self', links: [], version: 1, changedAt: {}, updatedBy: 'person', updatedAt });
    const inbox = (bot: number, session: string, items: BoardItem[]): Team => ({ ...taskTeam(`i${bot}`, {}), task: undefined, members: [{ ...taskTeam(`i${bot}`, {}).members[1]!, name: `Bot ${bot}`, nativeSessionId: session }],
      inbox: { botId: id(bot), board: { next: 9, items, plan: { text: 'Plan.', version: 1, changes: [] } } } } as Team);

    it('gives a standing bot\'s whole board by its id, and its items newest first by its session', () => {
      const teams = [inbox(1, 'chief', [item(1, 'done', 9), item(2, 'waiting', 5), item(3, 'working', 7)])];
      const directory = taskDirectory(teams, () => {}, undefined, groups);
      expect(directory.boardOf!(id(1))?.plan?.text).toBe('Plan.');
      expect(directory.boardOf!(id(1))?.items.map(entry => entry.key)).toEqual([1, 2, 3]);
      expect(directory.boardOf!(id(7))).toBeUndefined();
      expect(directory.board!({ providerId: 'claude', nativeSessionId: 'chief' }).map(entry => entry.key)).toEqual([1, 3, 2]);
    });

    it('names assignees, standing or temporary, offers the standing staff and the temporary bots at work, and opens the session doing an item', () => {
      const working = { ...taskTeam('t1', { botId: id(5), title: 'Regression' }, { owner: 'chief' }) }, finished = taskTeam('t2', { botId: id(6), title: 'Old run', state: 'done', result: { status: 'done', summary: 'Ok.', reportedAt: 3 } }, { owner: 'chief' });
      const strangers = taskTeam('t3', { botId: id(7), title: 'Other chief' }, { owner: 'someone' });
      const open = vi.fn();
      const directory = taskDirectory([inbox(1, 'chief', []), inbox(2, 'tracker', []), working, finished, strangers], open, undefined, groups);
      expect(directory.botName!(id(2))).toBe('Tracker');
      expect(directory.botName!(id(6))).toBe('Old run');
      expect(directory.assignees!(id(1))).toEqual([{ botId: id(2), name: 'Tracker' }, { botId: id(5), name: 'Regression' }]);
      expect(directory.canOpenBot!(id(2))).toBe(true);
      expect(directory.canOpenBot!(id(9))).toBe(false);
      directory.openBot!(id(2));
      directory.openBot!(id(5));
      expect(open.mock.calls).toEqual([[{ hostId: 'mac', providerId: 'claude', nativeSessionId: 'tracker', title: 'Tracker' }], [{ hostId: 'mac', providerId: 'claude', nativeSessionId: 't1-session', title: 'Regression' }]]);
    });
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

  describe('the answer sessions of mentions', () => {
    const id = (n: number) => 'b_' + String(n).repeat(32);
    const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [] }, bots: { rank: 'm', members: { v1: { botId: id(1), name: 'Reviewer' }, v2: { botId: id(2), name: 'Tracker' } } } }] as unknown as WindowGroup[];
    const session = (teamId: string, bot: string, conversation: string, status: 'active' | 'archived', entries: Array<{ id: string; at: number; answer?: string }>): Team => {
      const member = { id: `${teamId}-m`, hostId: 'mac', providerId: 'claude', role: 'leader' as const, name: 'Bot', responsibility: '', creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1, nativeSessionId: `${teamId}-s` };
      return { id: teamId, operationId: teamId, revision: 1, title: 'Answers', status, createdAt: 1, updatedAt: 1, source: { hostId: 'mac', providerId: 'claude', nativeSessionId: 'main', title: 'Bot' }, messages: [], members: [member],
        ask: { botId: bot, from: { hostId: 'mac', providerId: 'claude', nativeSessionId: conversation, name: `Conversation ${conversation}` }, lastAt: Math.max(...entries.map(entry => entry.at)),
          entries: entries.map(entry => ({ id: entry.id, text: `Question ${entry.id}`, at: entry.at, ...(entry.answer ? { answer: { text: entry.answer, at: entry.at + 1 } } : {}) })) } } as Team;
    };
    const teams = [session('a', id(1), 'x', 'active', [{ id: 'q1', at: 10, answer: 'Fine.' }, { id: 'q3', at: 30 }]), session('b', id(2), 'x', 'active', [{ id: 'q2', at: 20, answer: 'Two open.' }]),
      session('c', id(1), 'y', 'archived', [{ id: 'q4', at: 5 }]), session('d', id(1), 'z', 'active', [{ id: 'q5', at: 40 }])];

    it('lists what a conversation asked, oldest first, with the bot\'s name and its answer when it has one', () => {
      const directory = taskDirectory(teams, () => {}, async () => {}, groups);
      expect(directory.asks!({ providerId: 'claude', nativeSessionId: 'x' }).map(line => [line.id, line.bot, line.text, line.answer?.text])).toEqual([
        ['q1', 'Reviewer', 'Question q1', 'Fine.'], ['q2', 'Tracker', 'Question q2', 'Two open.'], ['q3', 'Reviewer', 'Question q3', undefined]]);
      expect(directory.asks!({ providerId: 'claude', nativeSessionId: 'nowhere' })).toEqual([]);
      expect(directory.asks!({ providerId: 'codex', nativeSessionId: 'x' })).toEqual([]);
    });

    it('lists a bot\'s open answer sessions, newest first, without the retired ones', () => {
      const directory = taskDirectory(teams, () => {}, async () => {}, groups);
      expect(directory.answering!(id(1))).toEqual([{ teamId: 'd', conversation: 'Conversation z', lastAt: 40, count: 1 }, { teamId: 'a', conversation: 'Conversation x', lastAt: 30, count: 2 }]);
      expect(directory.answering!(id(2)).map(item => item.teamId)).toEqual(['b']);
    });

    it('offers the standing bots to mention, and asks through the call the page gave', async () => {
      const asked: unknown[] = [];
      const directory = taskDirectory([], () => {}, async () => {}, groups, undefined, async (source, bot, text) => { asked.push([source.nativeSessionId, bot.botId, text]); });
      expect(directory.bots!()).toEqual([{ botId: id(1), name: 'Reviewer' }, { botId: id(2), name: 'Tracker' }]);
      await directory.ask!({ hostId: 'mac', providerId: 'claude', nativeSessionId: 'x', title: 'X' }, { botId: id(1), name: 'Reviewer' }, 'Hello?');
      expect(asked).toEqual([['x', id(1), 'Hello?']]);
      expect(taskDirectory([], () => {}).ask).toBeUndefined();
    });

    it('shows a bot\'s open answer sessions in its details', async () => {
      const directory = taskDirectory(teams, () => {}, async () => {}, groups);
      const { AnsweringList } = await import('../../conversation/assistant/AnsweringList.js');
      const container = await render(<AnsweringList sessions={directory.answering!(id(1))} />);
      expect([...container.querySelectorAll('li')].map(item => item.textContent?.replace(/ · last .*/, ''))).toEqual(['Conversation z · 1 asked', 'Conversation x · 2 asked']);
    });
  });

  it('lists the sides asked from a conversation once they have reported, oldest first, and quotes an answer to bring it back', () => {
    const result = (summary: string, reportedAt: number) => ({ status: 'done' as const, summary, reportedAt });
    const directory = taskDirectory([taskTeam('s2', { side: true, state: 'done', result: result('Second.\nMore.', 9) }), taskTeam('s1', { side: true, state: 'done', result: result('First.', 4) }),
      taskTeam('working', { side: true }), taskTeam('bot', { state: 'done', result: result('Not a side.', 3) }), taskTeam('elsewhere', { side: true, state: 'done', result: result('Other chat.', 1) }, { owner: 'other' })], vi.fn());
    const cards = directory.sides!({ providerId: 'claude', nativeSessionId: 'main' });
    expect(cards.map(card => [card.taskId, card.at])).toEqual([['s1', 4], ['s2', 9]]);
    expect(bringBackText(cards[1]!, translator('en'))).toBe('From the side "Task s2":\n\n> Second.\n> More.');
  });
});
