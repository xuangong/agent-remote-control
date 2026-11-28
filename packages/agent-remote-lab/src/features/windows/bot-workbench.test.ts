// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWindowView, type TaskView, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { projectBotWorkbench, workbenchBotId, workbenchMainView, type WorkbenchInput } from './bot-workbench.js';

const main = { hostId: 'local', providerId: 'claude', nativeSessionId: 'main-1' };
const binding = (id: string) => ({ ...main, nativeSessionId: id, title: id });
const mainView = (): WindowView => ({ ...createWindowView('m', binding('main-1'), 'primary'), feature: { kind: 'bot', id: 'b1' }, bindingPolicy: 'managed' });
const windowOf = (views: WindowView[]): WorkspaceWindow => ({ schemaVersion: 3, id: 'w', revision: 1, title: 'Bot', selectedPrimaryViewId: 'm', selectedViewId: 'm', views });
const sub = (id: string, state: TaskView['state'], at: number, extra: Partial<TaskView> = {}): TaskView => ({ taskId: id, title: `T ${id}`, state, worker: { hostId: 'local', providerId: 'claude', nativeSessionId: `n-${id}` },
  owner: main, createdAt: at, updatedAt: at, ...extra }) as TaskView;
const input = (over: Partial<WorkbenchInput> = {}): WorkbenchInput => ({ window: windowOf([mainView()]), botId: 'b1', mainSession: main, tasks: [], answers: [], expanded: new Set(), held: [], previous: [], ...over });
const ids = (tiles: readonly { id: string }[]) => tiles.map(tile => tile.id);

describe('the binding', () => {
  it('is the first primary view tagged for a bot, and nothing else', () => {
    const window = windowOf([createWindowView('p', binding('x'), 'primary'), mainView()]);
    expect(workbenchBotId(window)).toBe('b1');
    expect(workbenchMainView(window)?.id).toBe('m');
    expect(workbenchBotId(windowOf([createWindowView('p', binding('x'), 'primary')]))).toBeUndefined();
  });
  it('ignores a second tagged view', () => {
    const second = { ...mainView(), id: 'm2', feature: { kind: 'bot', id: 'b2' } };
    expect(workbenchBotId(windowOf([mainView(), second]))).toBe('b1');
    expect(ids(projectBotWorkbench(input({ window: windowOf([mainView(), second]) })).stored)).toEqual(['m2']);
  });
});

describe('derived tiles', () => {
  it('orders needs you, working, idle, oldest first within a state, all folded', () => {
    const model = projectBotWorkbench(input({ tasks: [sub('i', 'idle', 1), sub('w2', 'working', 5), sub('n', 'needs_input', 9), sub('w1', 'queued', 2)] }));
    expect(ids(model.derived)).toEqual(['sub:n', 'sub:w1', 'sub:w2', 'sub:i']);
    expect(model.derived.every(tile => tile.folded)).toBe(true);
  });
  it('expands a tile only when the person expanded it', () => {
    const model = projectBotWorkbench(input({ tasks: [sub('n', 'needs_input', 1)], expanded: new Set(['sub:n']) }));
    expect(model.derived[0]!.folded).toBe(false);
  });
  it('folds ended sub-sessions, newest first, at most ten', () => {
    const ended = Array.from({ length: 12 }, (_, index) => sub(`e${index}`, 'ended', index));
    const model = projectBotWorkbench(input({ tasks: ended }));
    expect(model.derived).toEqual([]);
    expect(ids(model.ended)).toEqual(Array.from({ length: 10 }, (_, index) => `sub:e${11 - index}`));
  });
  it('marks the person\'s own sides and keeps them out of the bot\'s count', () => {
    const model = projectBotWorkbench(input({ tasks: [sub('a', 'working', 1), sub('s', 'working', 2, { startedBy: 'person' })] }));
    expect(model.derived.map(tile => [tile.id, tile.mark])).toEqual([['sub:a', undefined], ['sub:s', 'you']]);
    expect(model.botSubSessions).toBe(1);
  });
  it('leaves out a sub-session another session owns', () => {
    const other = sub('o', 'working', 1, { owner: { ...main, nativeSessionId: 'elsewhere' } });
    expect(projectBotWorkbench(input({ tasks: [other] })).derived).toEqual([]);
  });
  it('shows a side started from one of its sub-sessions', () => {
    const side = sub('s', 'working', 3, { startedBy: 'person', owner: { ...main, nativeSessionId: 'n-a' } });
    expect(ids(projectBotWorkbench(input({ tasks: [sub('a', 'working', 1), side] })).derived)).toEqual(['sub:a', 'sub:s']);
  });
});

describe('stored and derived tiles', () => {
  it('shows a session once, the stored tile winning and carrying the state', () => {
    const stored = createWindowView('v1', binding('n-a'), 'primary');
    const model = projectBotWorkbench(input({ window: windowOf([mainView(), stored]), tasks: [sub('a', 'needs_input', 1)] }));
    expect(ids(model.derived)).toEqual([]);
    expect(model.stored[0]).toMatchObject({ id: 'v1', source: 'stored', state: 'needs_input', taskId: 'a' });
  });
  it('passes person-added tiles through in stored order, folded as stored', () => {
    const views = [mainView(), createWindowView('a', binding('x'), 'primary'), { ...createWindowView('b', binding('y'), 'primary'), collapsed: true }];
    const model = projectBotWorkbench(input({ window: windowOf(views) }));
    expect(model.stored.map(tile => [tile.id, tile.folded])).toEqual([['a', false], ['b', true]]);
  });
  it('does not list attached views as tiles of their own', () => {
    const side = { ...createWindowView('s', binding('c'), 'attached'), attachedTo: 'm' };
    expect(projectBotWorkbench(input({ window: windowOf([mainView(), side]) })).stored).toEqual([]);
  });
});

describe('the hold rule', () => {
  it('keeps a held tile where it was while the others reorder', () => {
    const before = projectBotWorkbench(input({ tasks: [sub('a', 'idle', 1), sub('b', 'idle', 2), sub('c', 'idle', 3)] }));
    expect(ids(before.derived)).toEqual(['sub:a', 'sub:b', 'sub:c']);
    const after = projectBotWorkbench(input({ tasks: [sub('a', 'idle', 1), sub('b', 'idle', 2), sub('c', 'needs_input', 3)], held: ['sub:a'], previous: ids(before.derived) }));
    expect(ids(after.derived)).toEqual(['sub:a', 'sub:c', 'sub:b']);
  });
  it('keeps a held tile that ended, marked ended, until released', () => {
    const tasks = [sub('a', 'ended', 1)];
    const held = projectBotWorkbench(input({ tasks, held: ['sub:a'], previous: ['sub:a'] }));
    expect(held.derived.map(tile => [tile.id, tile.ended])).toEqual([['sub:a', true]]);
    expect(held.ended).toEqual([]);
    expect(ids(projectBotWorkbench(input({ tasks })).ended)).toEqual(['sub:a']);
  });
});

describe('answers and loading', () => {
  it('lists answer sessions newest first', () => {
    const model = projectBotWorkbench(input({ answers: [{ teamId: 't1', conversation: 'A', lastAt: 1, count: 1 }, { teamId: 't2', conversation: 'B', lastAt: 5, count: 2 }] }));
    expect(model.answers.map(answer => answer.teamId)).toEqual(['t2', 't1']);
  });
  it('reports unknown tasks as not loaded, never as none', () => {
    expect(projectBotWorkbench(input({ tasks: undefined })).loaded).toBe(false);
    expect(projectBotWorkbench(input({ tasks: [] })).loaded).toBe(true);
  });
  it('is the free workbench\'s tiles when the Window is not bound', () => {
    const free = windowOf([createWindowView('a', binding('x'), 'primary')]);
    const model = projectBotWorkbench(input({ window: free, botId: undefined, tasks: [sub('a', 'working', 1)] }));
    expect(model.main).toBeUndefined();
    expect(ids(model.stored)).toEqual(['a']);
    expect(model.derived).toEqual([]);
  });
});

describe('the shared contract fixture', () => {
  it('is read as a bot workbench with the person\'s tile after the main tile', () => {
    const group = JSON.parse(readFileSync(new URL('../../../../agent-remote-protocol/src/fixtures/window-bot-workbench.v1.json', import.meta.url), 'utf8'));
    const model = projectBotWorkbench(input({ window: group.window, botId: workbenchBotId(group.window), mainSession: { hostId: 'local', providerId: 'claude', nativeSessionId: 'native-main' } }));
    expect(model.botId).toBe('bot_dango');
    expect(model.main?.id).toBe('main');
    expect(model.stored.map(tile => [tile.id, tile.folded])).toEqual([['note', true]]);
  });
});
