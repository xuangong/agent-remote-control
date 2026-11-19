import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildBinding, buildView, buildWindow } from '../test/window-builders.js';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useSideSessions } from './useSideSessions.js';

const source = buildOpened('source'), side = buildOpened('side');
const sourceView = buildView('source', 'primary', { binding: buildBinding('source') });
const sharedWindow = buildWindow([sourceView]);

function scopeOf(facts: Record<string, unknown> = {}) {
  const scope = {
    editWindow: vi.fn(), expandedKeys: new Set<string>(), navigateSide: vi.fn(), navigation: { select: vi.fn() }, nextSideRequest: vi.fn(), openSession: vi.fn(async () => true),
    setSessionNotice: vi.fn(), setSideAnchor: vi.fn(), setSideFocus: vi.fn(), setSideSelections: vi.fn(), setSideSessions: vi.fn(), sharedViewForSlot: () => undefined, sharedWindow: undefined,
    stackPath: [source], succession: { document: { slots: [{ id: 'view-side' }], windowBindings: [] }, rememberSide: vi.fn(), bindWindowView: vi.fn(() => ({ id: 'slot-side' })), ensureWindowView: vi.fn(() => ({ id: 'slot-side' })) },
    viewSession: (session: object) => session, windowMode: true,
    windowWorkspace: { readWindow: () => sharedWindow, readGroup: () => undefined, operate: vi.fn(async () => undefined), operateGroup: vi.fn(async () => undefined), authority: { operate: vi.fn() } }, ...facts,
  };
  return { scope, mock: mockScope<typeof useSideSessions>(scope) };
}

async function mount(facts: Record<string, unknown> = {}) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useSideSessions(built.mock));
  return { ...built, hook: result.current };
}

describe('selecting a Side without a Window', () => {
  it('remembers the Side, selects it under its source and navigates to it', async () => {
    const { scope, hook } = await mount();
    hook.selectSide(source, side);
    expect(scope.nextSideRequest).toHaveBeenCalledWith(source);
    expect(scope.succession.rememberSide).toHaveBeenCalledWith(side);
    expect(scope.navigateSide).toHaveBeenCalledWith('view-side');
    const selections = scope.setSideSelections.mock.calls[0]![0] as (value: object) => object;
    expect(selections({ other: null })).toEqual({ other: null, 'view-source': 'view-side' });
    const sessions = scope.setSideSessions.mock.calls[0]![0] as (value: unknown[]) => unknown[];
    expect(sessions([buildOpened('side'), buildOpened('keep')])).toEqual([buildOpened('keep'), side]);
  });
});

describe('selecting a Side in a shared Window', () => {
  const shared = { sharedWindow, sharedViewForSlot: () => ({ ...sourceView }) };
  it('creates an attached view for it, binds its slot and edits the Window in Window mode', async () => {
    const { scope, hook } = await mount(shared);
    hook.selectSide(source, side);
    expect(scope.succession.bindWindowView).toHaveBeenCalledWith('W', expect.any(String), expect.objectContaining({ nativeSessionId: 'side' }), 'view-side');
    expect(scope.succession.rememberSide).toHaveBeenCalledWith(expect.objectContaining({ viewId: 'slot-side' }));
    const operation = scope.editWindow.mock.calls[0]![0];
    expect(operation.type).toBe('batch');
    expect(scope.windowWorkspace.operate).not.toHaveBeenCalled();
  });
  it('only selects the view when the Side is already shown beside its source, and reuses its slot', async () => {
    const attached = { ...buildView('side', 'attached'), attachedTo: 'source', binding: buildBinding('side') };
    const window = buildWindow([sourceView, attached]);
    const { scope, hook } = await mount({ ...shared, sharedWindow: window, windowWorkspace: { readWindow: () => window, readGroup: () => undefined, operate: vi.fn(), authority: {} } });
    hook.selectSide(source, side);
    expect(scope.succession.bindWindowView).not.toHaveBeenCalled();
    expect(scope.succession.ensureWindowView).toHaveBeenCalledWith('W', 'side', expect.anything());
    expect(scope.editWindow).toHaveBeenCalledWith({ type: 'view.select', viewId: 'side' });
  });
  it('opens the Side as a bot of the group in Bot mode, and reports a failed edit as a notice', async () => {
    const operate = vi.fn(async () => { throw new Error('rejected'); });
    const { scope, hook } = await mount({ ...shared, windowMode: false, windowWorkspace: { readWindow: () => sharedWindow, readGroup: () => undefined, operate } });
    hook.selectSide(source, side);
    await act(async () => {});
    expect(scope.setSessionNotice).toHaveBeenCalled();
    expect(scope.editWindow).not.toHaveBeenCalled();
    expect(scope.navigation.select).not.toHaveBeenCalled();
  });
  it('selects the bot view after the Window accepted the edit in Bot mode', async () => {
    const { scope, hook } = await mount({ ...shared, windowMode: false });
    hook.selectSide(source, side);
    await act(async () => {});
    expect(scope.navigation.select).toHaveBeenCalledWith({ kind: 'bot', groupId: 'W', viewId: expect.any(String) });
  });
  it('refuses a source view that changed', async () => {
    const { hook } = await mount({ ...shared, sharedViewForSlot: () => ({ ...sourceView, binding: buildBinding('else') }) });
    expect(() => hook.selectSide(source, side)).toThrow('The source view changed. Open the Side session again.');
    const none = await mount({ ...shared, sharedViewForSlot: () => undefined });
    expect(() => none.hook.selectSide(source, side)).toThrow('The source view changed.');
  });
});

describe('selecting a Side in another group in Bot mode', () => {
  it('adds the Side beside its bot in that group', async () => {
    const group = { window: sharedWindow };
    const { scope, hook } = await mount({ windowMode: false, succession: { document: { slots: [{ id: 'view-side' }], windowBindings: [{ slotId: 'view-source', windowId: 'W', viewId: 'source' }] },
      rememberSide: vi.fn(), bindWindowView: vi.fn(() => ({ id: 'slot-side' })), ensureWindowView: vi.fn(() => ({ id: 'slot-side' })) },
      windowWorkspace: { readWindow: () => undefined, readGroup: () => group, operate: vi.fn(), operateGroup: vi.fn(async () => undefined), authority: {} } });
    hook.selectSide(source, side);
    expect(scope.windowWorkspace.operateGroup).toHaveBeenCalledWith('W', expect.objectContaining({ type: 'batch' }));
    await act(async () => {});
    expect(scope.navigation.select).toHaveBeenCalledWith({ kind: 'bot', groupId: 'W', viewId: expect.any(String) });
  });
});

describe('revealing a session', () => {
  it('selects the shared view of a session that has one', async () => {
    const { scope, hook } = await mount({ sharedViewForSlot: () => ({ id: 'shared' }) });
    hook.revealSession(buildOpened('x'));
    expect(scope.windowWorkspace.authority.operate).toHaveBeenCalledWith({ type: 'view.select', viewId: 'shared' });
  });
  it('focuses a visible session of the stack and anchors on it when it is not expanded', async () => {
    const { scope, hook } = await mount();
    hook.revealSession(source);
    expect(scope.setSideFocus).toHaveBeenCalledWith('view-source');
    expect(scope.setSideAnchor).toHaveBeenCalledWith('view-source');
    const expanded = await mount({ expandedKeys: new Set(['view-source']) });
    expanded.hook.revealSession(source);
    expect(expanded.scope.setSideAnchor).not.toHaveBeenCalled();
  });
  it('opens a session that is not on screen', async () => {
    const { scope, hook } = await mount();
    hook.revealSession(buildOpened('elsewhere', { viewId: undefined }));
    expect(scope.openSession).toHaveBeenCalled();
    expect(scope.setSideFocus).not.toHaveBeenCalled();
  });
});
