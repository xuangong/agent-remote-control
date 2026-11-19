import { describe, expect, it, vi } from 'vitest';
import { buildView, buildWindow } from '../test/window-builders.js';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useSideUnlinking } from './useSideUnlinking.js';

const source = buildOpened('source'), target = buildOpened('target'), later = buildOpened('later');
const forkOf = (overrides: Record<string, unknown> = {}) => ({ id: 'fork-1', revision: 1, linked: false, source, target, ...overrides });

function scopeOf(facts: Record<string, unknown> = {}) {
  return mockScope<typeof useSideUnlinking>({
    appliedUnlinks: new Map(), familyPath: [source, target], forkRevision: 1, forkStore: { all: () => [forkOf()] }, letterRequest: { current: { abort: vi.fn() } }, nextSideRequest: vi.fn(),
    pendingSideSources: { current: new Map() }, setDetachedSideRoot: vi.fn(), setSideAnchor: vi.fn(), setSideFocus: vi.fn(), setSideSelections: vi.fn(), sharedViewForSlot: () => undefined,
    sharedWindow: undefined, sideAnchor: 'view-source', sideFocus: 'view-source', sideSelections: { 'view-source': 'view-target' }, sideSessions: [target], trackedViews: { unlink: vi.fn() },
    visibleStackRoot: source, windowWorkspace: { authority: { operate: vi.fn() } }, ...facts,
  });
}

describe('a Side whose link is gone, without a shared Window', () => {
  it('leaves the tracked layout, asks for no pending Side request of its source, and cuts the selection', async () => {
    const scope = scopeOf();
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.trackedViews.unlink).toHaveBeenCalledWith('view-source', 'view-target');
    expect(scope.nextSideRequest).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'source' }));
    expect(scope.letterRequest.current!.abort).toHaveBeenCalled();
    const update = (scope.setSideSelections as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (values: Record<string, string | null>) => Record<string, string | null>;
    expect(update({ 'view-source': 'view-target' })).toEqual({ 'view-source': null });
    const untouched = { 'view-source': 'view-else' };
    expect(update(untouched)).toBe(untouched);
  });
  it('keeps the focus on the source when it was not inside the detached branch', async () => {
    const scope = scopeOf();
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.setSideFocus).toHaveBeenCalledWith('view-source');
    expect(scope.setSideAnchor).toHaveBeenCalledWith('view-source');
    expect(scope.setDetachedSideRoot).not.toHaveBeenCalled();
  });
  it('detaches the branch as its own root when the focus was inside it, and keeps an anchor that is still on the branch', async () => {
    const scope = scopeOf({ sideFocus: 'view-target', sideAnchor: 'view-target' });
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.setDetachedSideRoot).toHaveBeenCalledWith('view-target');
    expect(scope.setSideAnchor).not.toHaveBeenCalled();
  });
  it('moves an anchor that is not on the detached branch to the focus', async () => {
    const scope = scopeOf({ sideFocus: 'view-target', sideAnchor: 'view-elsewhere' });
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.setSideAnchor).toHaveBeenCalledWith('view-target');
  });
  it('does not touch the selection when the source did not select the target', async () => {
    const scope = scopeOf({ sideSelections: {} });
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.trackedViews.unlink).toHaveBeenCalled();
    expect(scope.setSideSelections).not.toHaveBeenCalled();
  });
  it('only unlinks the tracked layout without a primary session', async () => {
    const scope = scopeOf({ visibleStackRoot: undefined });
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.trackedViews.unlink).toHaveBeenCalled();
    expect(scope.setSideSelections).not.toHaveBeenCalled();
  });
});

describe('a link that is not to be applied', () => {
  it.each([
    ['still visible', { forkStore: { all: () => [forkOf({ linked: true })] } }],
    ['without a target', { forkStore: { all: () => [forkOf({ target: undefined })] } }],
    ['already applied at this revision', { appliedUnlinks: new Map([['fork-1', 1]]) }],
    ['whose source is not on screen', { familyPath: [target] }],
    ['whose target is not a Side on screen', { sideSessions: [later] }],
  ])('is left alone when it is %s', async (_name, change) => {
    const scope = scopeOf(change);
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.trackedViews.unlink).not.toHaveBeenCalled();
    expect(scope.nextSideRequest).not.toHaveBeenCalled();
  });
  it('is applied again at a later revision', async () => {
    const scope = scopeOf({ appliedUnlinks: new Map([['fork-1', 0]]) });
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.trackedViews.unlink).toHaveBeenCalled();
    expect(scope.appliedUnlinks.get('fork-1')).toBe(1);
  });
  it('is applied once, however often the page renders', async () => {
    const scope = scopeOf();
    const { rerender } = await renderHook(() => useSideUnlinking(scope));
    await rerender();
    expect(scope.trackedViews.unlink).toHaveBeenCalledTimes(1);
  });
  it('takes the navigation source the fork recorded before it was unlinked', async () => {
    const pending = new Map([['fork-1', later]]);
    const scope = scopeOf({ pendingSideSources: { current: pending }, familyPath: [later, target], forkStore: { all: () => [forkOf()] }, sideSelections: { 'view-later': 'view-target' } });
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.trackedViews.unlink).toHaveBeenCalledWith('view-later', 'view-target');
    expect(pending.has('fork-1')).toBe(false);
  });
});

describe('a Side whose link is gone, in a shared Window', () => {
  const attached = { ...buildView('target', 'attached'), attachedTo: 'source' };
  const sharedWindow = buildWindow([buildView('source'), attached]);
  const shared = (view: unknown) => scopeOf({ sharedWindow, sharedViewForSlot: () => view });
  it('makes its view an independent dock and selects it', async () => {
    const scope = shared(attached);
    await renderHook(() => useSideUnlinking(scope));
    const operate = scope.windowWorkspace.authority!.operate as unknown as ReturnType<typeof vi.fn>;
    const { layout, type } = operate.mock.calls[0]![0];
    expect(type).toBe('layout.apply');
    expect(layout.selectedViewId).toBe('target');
    const view = layout.views.find((item: { id: string }) => item.id === 'target');
    expect(view).toMatchObject({ placement: 'dock', collapsed: false });
    expect('attachedTo' in view).toBe(false);
    expect(layout.views.find((item: { id: string }) => item.id === 'source')).toBe(sharedWindow.views[0]);
    expect(scope.nextSideRequest).toHaveBeenCalled();
    expect(scope.trackedViews.unlink).not.toHaveBeenCalled();
  });
  it('does nothing to the layout for a view that is not attached', async () => {
    const scope = shared({ ...attached, attachedTo: undefined });
    await renderHook(() => useSideUnlinking(scope));
    expect(scope.windowWorkspace.authority!.operate).not.toHaveBeenCalled();
  });
});
