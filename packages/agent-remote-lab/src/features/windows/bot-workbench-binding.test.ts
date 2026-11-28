import { describe, expect, it } from 'vitest';
import { applyGroupOperation, createWindowView, isWorkspaceWindow, type WindowGroup, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { adoptedView, bindWorkbench, resolveWorkbench, standingBots, unbindWorkbench, workbenchGroup, workbenchWindowId } from './bot-workbench-binding.js';
import { workbenchBotId } from './bot-workbench.js';
import type { WorkbenchTile } from './bot-workbench.js';

const binding = (id: string): WindowSessionBinding => ({ hostId: 'local', providerId: 'claude', nativeSessionId: id, title: id });
const free = (views: WindowView[]): WorkspaceWindow => ({ schemaVersion: 3, id: 'w', revision: 4, title: 'Free', selectedPrimaryViewId: views[0]?.id ?? null, selectedViewId: views[0]?.id ?? null, views });
const apply = (window: WorkspaceWindow, layout: ReturnType<typeof bindWorkbench>) => applyGroupOperation({ window }, { type: 'layout.apply', layout }).window;

describe('creating a bot workbench', () => {
  it('is a Window-only group with one tagged, managed main tile', () => {
    const group = workbenchGroup('b1', 'Dango', binding('main-1'), 'wb-b1');
    expect(group.presentation).toEqual({ bots: false });
    expect(group.bots).toBeUndefined();
    expect(isWorkspaceWindow(group.window)).toBe(true);
    expect(workbenchBotId(group.window)).toBe('b1');
    expect(group.window.views[0]).toMatchObject({ placement: 'primary', bindingPolicy: 'managed' });
    expect(group.window.title).toBe('Dango');
  });
  it('takes the deterministic id unless it is taken', () => {
    expect(workbenchWindowId('b1', new Set())).toBe('wb-b1');
    expect(workbenchWindowId('b1', new Set(['wb-b1']))).not.toBe('wb-b1');
  });
});

describe('binding and unbinding', () => {
  it('tags the view that already shows the bot\'s main session and puts it first', () => {
    const window = free([createWindowView('a', binding('x'), 'primary'), createWindowView('m', binding('main-1'), 'primary')]);
    const bound = apply(window, bindWorkbench(window, 'b1', binding('main-1')));
    expect(bound.views.map(view => view.id)).toEqual(['m', 'a']);
    expect(bound.views[0]).toMatchObject({ feature: { kind: 'bot', id: 'b1' }, bindingPolicy: 'managed' });
    expect(workbenchBotId(bound)).toBe('b1');
  });
  it('adds the main tile first when the Window does not show it, keeping every other view', () => {
    const side = { ...createWindowView('s', binding('c'), 'attached'), attachedTo: 'a' };
    const window = free([createWindowView('a', binding('x'), 'primary'), side]);
    const bound = apply(window, bindWorkbench(window, 'b1', binding('main-1')));
    expect(bound.views.map(view => view.id).slice(1)).toEqual(['a', 's']);
    expect(bound.views[0]!.binding?.nativeSessionId).toBe('main-1');
  });
  it('unbinds by dropping the tag and the managed policy and keeps the tile', () => {
    const group = workbenchGroup('b1', 'Dango', binding('main-1'), 'wb-b1');
    const adopted: WorkbenchTile = { id: 'sub:s_1', source: 'derived', title: 'Research', folded: false, taskId: 's_1', locator: { hostId: 'local', providerId: 'claude', nativeSessionId: 'n1' } };
    const layout = unbindWorkbench(group.window, [adopted]);
    const unbound = apply(group.window, layout);
    expect(workbenchBotId(unbound)).toBeUndefined();
    expect(unbound.views[0]).not.toHaveProperty('bindingPolicy');
    expect(unbound.views.map(view => view.binding?.nativeSessionId)).toEqual(['main-1', 'n1']);
    expect(unbound.views[1]).toMatchObject({ placement: 'primary', collapsed: false });
  });
  it('keeps a folded derived tile folded when it is kept', () => {
    const tile: WorkbenchTile = { id: 'sub:s_1', source: 'derived', title: 'R', folded: true, taskId: 's_1', locator: { hostId: 'local', providerId: 'claude', nativeSessionId: 'n1' } };
    expect(adoptedView(tile, 'v')).toMatchObject({ collapsed: true });
  });
});

describe('opening a bot\'s workbench', () => {
  const group = (id: string, botId?: string): WindowGroup => botId ? workbenchGroup(botId, botId, binding('m'), id) : { window: free([createWindowView('a', binding('x'), 'primary')]) };
  it('finds the tagged Window, the most recently used first', () => {
    const groups = [group('w1', 'b1'), group('w2', 'b1'), group('w3', 'b2'), group('w4')];
    expect(resolveWorkbench(groups, 'b1', ['w2', 'w1'])?.window.id).toBe('w2');
    expect(resolveWorkbench(groups, 'b1', [])?.window.id).toBe('w1');
    expect(resolveWorkbench(groups, 'b9', [])).toBeUndefined();
  });
});

describe('standing bots', () => {
  it('lists the bots of groups with bot details, with their chief, and skips plain Windows', () => {
    const section: WindowGroup = { window: free([createWindowView('main', binding('m1'), 'primary'), createWindowView('v2', binding('m2'), 'primary')]),
      bots: { rank: 'm', members: { main: { botId: 'b1' }, v2: { botId: 'b2', chief: 'b1', hidden: true } } } };
    const plain: WindowGroup = { window: { ...free([createWindowView('a', binding('x'), 'primary')]), id: 'p' } };
    expect(standingBots([plain, section]).map(bot => [bot.botId, bot.chief, bot.binding.nativeSessionId])).toEqual([['b1', undefined, 'm1'], ['b2', 'b1', 'm2']]);
  });
});
