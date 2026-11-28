import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Team, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { workbenchGroup } from '../features/windows/bot-workbench-binding.js';
import { renderHook, mockScope } from '../test/render-hook.js';
import { useBotWorkbench } from './useBotWorkbench.js';

const seat = (nativeSessionId: string, role: 'leader' | 'requester' = 'leader') => ({ id: nativeSessionId, hostId: 'local', providerId: 'claude', role, name: nativeSessionId, nativeSessionId, creation: 'ready' as const });
const inbox = { id: 'inbox', inbox: { botId: 'b1' }, members: [seat('main')], status: 'active' } as unknown as Team;
const sub = (id: string, state: string, at = 1) => ({ id: `team-${id}`, status: 'active', source: { nativeSessionId: 'main' },
  task: { title: `Task ${id}`, state, subSessionId: id, createdAt: at, updatedAt: at }, members: [seat(`n-${id}`), seat('main', 'requester')] }) as unknown as Team;
const window: WorkspaceWindow = workbenchGroup('b1', 'Dango', { hostId: 'local', providerId: 'claude', nativeSessionId: 'main', title: 'Dango' }, 'wb').window;
type Scope = Parameters<typeof useBotWorkbench>[0];

function setup(initial: Team[]) {
  const operate = vi.fn();
  let tasks = initial;
  const scope = () => mockScope<typeof useBotWorkbench>({ baseUrl: 'https://wb/', sharedWindow: window, teamRoster: { baseUrl: 'https://wb/', teams: [], tasks }, windowWorkspace: { authority: { operate } } }) as Scope;
  return { operate, set: (next: Team[]) => { tasks = next; }, scope };
}
beforeEach(() => localStorage.clear());

it('shows sub-sessions as they start and end without writing the Window', async () => {
  const f = setup([inbox]);
  const hook = await renderHook(() => useBotWorkbench(f.scope()));
  expect(hook.result.current.model?.derived).toEqual([]);
  f.set([inbox, sub('s_1', 'working'), sub('s_2', 'needs_input')]);
  await hook.rerender();
  expect(hook.result.current.model?.derived.map(tile => tile.taskId)).toEqual(['team-s_2', 'team-s_1']);
  f.set([inbox, sub('s_1', 'ended'), sub('s_2', 'needs_input')]);
  await hook.rerender();
  expect(hook.result.current.model?.derived.map(tile => tile.taskId)).toEqual(['team-s_2']);
  expect(hook.result.current.model?.ended.map(tile => tile.taskId)).toEqual(['team-s_1']);
  expect(f.operate).not.toHaveBeenCalled();
});

it('keeps the selected tile where it is while a tile that needs the person arrives before it', async () => {
  const f = setup([inbox, sub('s_1', 'idle', 1), sub('s_2', 'idle', 2)]);
  const hook = await renderHook(() => useBotWorkbench(f.scope()));
  await act(async () => hook.result.current.select('sub:team-s_1'));
  f.set([inbox, sub('s_1', 'idle', 1), sub('s_2', 'idle', 2), sub('s_3', 'needs_input', 3)]);
  await hook.rerender();
  const order = hook.result.current.model!.derived.map(tile => tile.taskId);
  expect(order[0]).toBe('team-s_1');
  expect(order).toContain('team-s_3');
});

it('remembers expanded tiles on this device and folds a tile that is folded again', async () => {
  const f = setup([inbox, sub('s_1', 'working')]);
  const hook = await renderHook(() => useBotWorkbench(f.scope()));
  expect(hook.result.current.model?.derived[0]!.folded).toBe(true);
  await act(async () => hook.result.current.setFolded('sub:team-s_1', false));
  expect(hook.result.current.model?.derived[0]!.folded).toBe(false);
  const again = await renderHook(() => useBotWorkbench(f.scope()));
  expect(again.result.current.model?.derived[0]!.folded).toBe(false);
  await act(async () => hook.result.current.setFolded('sub:team-s_1', true));
  expect(hook.result.current.model?.derived[0]!.folded).toBe(true);
  expect(f.operate).not.toHaveBeenCalled();
});

it('writes exactly one view when a tile is kept, and the tile stops being derived', async () => {
  const f = setup([inbox, sub('s_1', 'working')]);
  const hook = await renderHook(() => useBotWorkbench(f.scope()));
  await act(async () => hook.result.current.keep(hook.result.current.model!.derived[0]!));
  expect(f.operate).toHaveBeenCalledTimes(1);
  expect(f.operate.mock.calls[0]![0]).toMatchObject({ type: 'view.create', view: { placement: 'primary', binding: { nativeSessionId: 'n-s_1' } } });
});

it('is not bound for a free Window', async () => {
  const free = { ...window, views: window.views.map(({ feature: _feature, bindingPolicy: _policy, ...view }) => view) };
  const scope = mockScope<typeof useBotWorkbench>({ baseUrl: 'https://wb/', sharedWindow: free, teamRoster: { baseUrl: 'https://wb/', teams: [], tasks: [sub('s_1', 'working')] }, windowWorkspace: {} }) as Scope;
  const hook = await renderHook(() => useBotWorkbench(scope));
  expect(hook.result.current.bound).toBe(false);
  expect(hook.result.current.model?.derived).toEqual([]);
});

it('brings an ended sub-session back as a tile while the person has it open, and returns it to Ended when they leave', async () => {
  const f = setup([inbox, sub('s_1', 'ended'), sub('s_2', 'working')]);
  const hook = await renderHook(() => useBotWorkbench(f.scope()));
  expect(hook.result.current.model?.ended.map(tile => tile.taskId)).toEqual(['team-s_1']);
  await act(async () => hook.result.current.focus('sub:team-s_1'));
  expect(hook.result.current.model?.derived.map(tile => [tile.taskId, tile.ended, tile.folded])).toEqual([['team-s_2', undefined, true], ['team-s_1', true, false]]);
  await act(async () => hook.result.current.select('sub:team-s_2'));
  expect(hook.result.current.model?.ended.map(tile => tile.taskId)).toEqual(['team-s_1']);
});

it('owns the group folds and the tiles of an opened answer session', async () => {
  const f = setup([inbox]);
  const hook = await renderHook(() => useBotWorkbench(f.scope()));
  expect(hook.result.current.owns('group:ended')).toBe(true);
  expect(hook.result.current.owns('main')).toBe(false);
});
