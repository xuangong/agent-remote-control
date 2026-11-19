import { describe, expect, it, vi } from 'vitest';
import { buildView, buildWindow } from '../test/window-builders.js';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useOpenWindows } from './useOpenWindows.js';

const root = buildOpened('root'), side = buildOpened('side');

function scopeOf(facts: Record<string, unknown> = {}) {
  return mockScope<typeof useOpenWindows>({
    addressSession: root, baseUrl: 'https://relay', focusCatchUp: vi.fn(), initialState: undefined, isViewVisible: () => true, mountedViewSessions: {},
    primaryBinding: { current: { baseUrl: 'https://relay', transport: 'transport', agentId: root.agentId } }, replicas: new Map([[root.agentId, 'replica']]),
    sharedSlots: undefined, sharedWindow: undefined, sideSessions: [side], stackRoot: root, succession: { active: false, binding: undefined, isCurrent: () => true },
    transport: 'transport', windowMode: true, windowStageVisible: true, ...facts,
  });
}

describe('whether the primary session is bound to this page', () => {
  const bound = async (facts: Record<string, unknown>) => (await renderHook(() => useOpenWindows(scopeOf(facts)))).result.current.primaryIsBound;
  it('follows the succession model while one is active', async () => {
    expect(await bound({ succession: { active: true, isCurrent: () => true } })).toBe(true);
    expect(await bound({ succession: { active: true, isCurrent: () => false } })).toBe(false);
  });
  it('is true for the session of the initial state', async () => {
    expect(await bound({ initialState: { agent: { id: root.agentId } }, primaryBinding: { current: undefined } })).toBe(true);
  });
  it('is true for the binding of this page, scope and transport', async () => {
    expect(await bound({})).toBe(true);
  });
  it.each([['scope', { baseUrl: 'https://other' }], ['transport', { transport: 'other' }], ['agent', { stackRoot: buildOpened('else') }]])('is false for a binding of another %s', async (_name, change) => {
    expect(await bound(change)).toBe(false);
  });
});

describe('the sessions open without a shared Window', () => {
  it('are the bound primary session and the Sides', async () => {
    const { result } = await renderHook(() => useOpenWindows(scopeOf()));
    expect(result.current.openWindows).toEqual([root, side]);
  });
  it('leave out a primary session that is not bound', async () => {
    const { result } = await renderHook(() => useOpenWindows(scopeOf({ primaryBinding: { current: undefined } })));
    expect(result.current.openWindows).toEqual([side]);
  });
});

describe('the sessions open in a shared Window', () => {
  const primary = buildView('p', 'primary'), dock = buildView('d', 'dock'), unbound = { ...buildView('u', 'dock'), binding: undefined };
  const sharedWindow = buildWindow([primary, dock, unbound]);
  const slot = (view: ReturnType<typeof buildView>) => ({ id: view.id, intent: { kind: 'session', target: { hostId: 'local', native: { providerId: 'codex', nativeSessionId: view.binding!.nativeSessionId } } },
    metadata: { agentId: `agent-${view.id}`, title: 'from slot' } });
  const sharedSlots = new Map([[primary.id, slot(primary)], [dock.id, slot(dock)]]);
  it('are the views with a binding that are primary or mounted, titled as their binding', async () => {
    const mounted = buildOpened('d', { agentId: 'mounted-d', title: 'mounted' });
    const { result } = await renderHook(() => useOpenWindows(scopeOf({ sharedWindow, sharedSlots, mountedViewSessions: { d: mounted } })));
    expect(result.current.openWindows.map(session => [session.agentId, session.title])).toEqual([['agent-p', 'p'], ['mounted-d', 'd']]);
  });
  it('leave out a dock that is not mounted, and a view without a binding', async () => {
    const { result } = await renderHook(() => useOpenWindows(scopeOf({ sharedWindow, sharedSlots })));
    expect(result.current.openWindows.map(session => session.agentId)).toEqual(['agent-p']);
  });
  it('take the session of the slot when the mounted one belongs to another binding', async () => {
    const { result } = await renderHook(() => useOpenWindows(scopeOf({ sharedWindow, sharedSlots, mountedViewSessions: { d: buildOpened('other', { agentId: 'mounted-other' }) } })));
    expect(result.current.openWindows.map(session => session.agentId)).toEqual(['agent-p', 'agent-d']);
  });
  it('leave out a view whose slot holds another session than its binding', async () => {
    const moved = { ...slot(primary), intent: { kind: 'session', target: { hostId: 'local', native: { providerId: 'codex', nativeSessionId: 'moved' } } } };
    const { result } = await renderHook(() => useOpenWindows(scopeOf({ sharedWindow, sharedSlots: new Map([[primary.id, moved]]) })));
    expect(result.current.openWindows).toEqual([]);
  });
});

describe('the sessions a person can see', () => {
  it('are the open ones whose view is visible, while the sessions stage is shown', async () => {
    const isViewVisible = (key: string) => key === root.viewId;
    const { result } = await renderHook(() => useOpenWindows(scopeOf({ isViewVisible })));
    expect(result.current.visibleWindows).toEqual([root]);
  });
  it('are none while the stage is hidden', async () => {
    const { result } = await renderHook(() => useOpenWindows(scopeOf({ windowStageVisible: false })));
    expect(result.current.visibleWindows).toEqual([]);
  });
});

describe('catching up the focused session', () => {
  it('reads the replica of the address session in Window mode', async () => {
    const focusCatchUp = vi.fn();
    await renderHook(() => useOpenWindows(scopeOf({ focusCatchUp })));
    expect(focusCatchUp).toHaveBeenCalledWith('replica');
  });
  it('does not run outside Window mode, or while a succession has no binding yet', async () => {
    const outside = vi.fn(), waiting = vi.fn();
    await renderHook(() => useOpenWindows(scopeOf({ focusCatchUp: outside, windowMode: false })));
    await renderHook(() => useOpenWindows(scopeOf({ focusCatchUp: waiting, succession: { active: true, binding: undefined, isCurrent: () => true } })));
    expect(outside).not.toHaveBeenCalled();
    expect(waiting).not.toHaveBeenCalled();
  });
  it('runs without a replica when there is no address session', async () => {
    const focusCatchUp = vi.fn();
    await renderHook(() => useOpenWindows(scopeOf({ focusCatchUp, addressSession: undefined })));
    expect(focusCatchUp).toHaveBeenCalledWith(undefined);
  });
});
