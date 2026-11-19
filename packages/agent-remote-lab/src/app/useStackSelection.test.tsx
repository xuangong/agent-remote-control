import { describe, expect, it, vi } from 'vitest';
import { buildOpened, lateScope, mockScope, renderHook } from '../test/render-hook.js';
import { useStackSelection } from './useStackSelection.js';

const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => buildOpened(id));

function scopeOf(facts: Record<string, unknown> = {}) {
  return mockScope<typeof useStackSelection>({
    compactLayout: false, sharedViewForSlot: () => undefined, sharedWindow: undefined, sideAnchor: 'view-b', sideFocus: 'view-a', sideSelections: {}, sideSessions: [b, c],
    sideTitle: (session: unknown) => session, stackPath: [a, b, c, d], trackedViews: { remember: vi.fn() }, visibleStackRoot: a, ...facts,
  });
}

describe('which sessions of the stack are expanded', () => {
  it('shows the two sessions that end at the anchor on a desktop layout', async () => {
    const late = lateScope();
    const { result } = await renderHook(() => useStackSelection(scopeOf(), late));
    expect([...result.current.expandedKeys]).toEqual(['view-a', 'view-b']);
    expect(result.current.stackRange).toEqual({ start: 0, end: 1 });
  });
  it('shows one, the focused session, on a compact layout', async () => {
    const { result } = await renderHook(() => useStackSelection(scopeOf({ compactLayout: true, sideFocus: 'view-c' }), lateScope()));
    expect([...result.current.expandedKeys]).toEqual(['view-c']);
  });
  it('leaves out a session its shared view collapsed', async () => {
    const sharedViewForSlot = (key: string) => key === 'view-a' ? { collapsed: true } : undefined;
    const { result } = await renderHook(() => useStackSelection(scopeOf({ sharedViewForSlot }), lateScope()));
    expect([...result.current.expandedKeys]).toEqual(['view-b']);
  });
  it('anchors a shared Window on the session after the selected one on a desktop layout', async () => {
    const { result } = await renderHook(() => useStackSelection(scopeOf({ sharedWindow: { views: [] }, sideFocus: 'view-c', sideAnchor: 'view-a' }), lateScope()));
    expect(result.current.stackRange).toEqual({ start: 2, end: 3 });
  });
  it('publishes the expanded keys to the later hooks that read them late', async () => {
    const late = lateScope() as { expandedKeys?: ReadonlySet<string> };
    const { result } = await renderHook(() => useStackSelection(scopeOf(), late as never));
    expect(late.expandedKeys).toBe(result.current.expandedKeys);
  });
});

describe('the family of the primary session', () => {
  it('is the selected path without a shared Window', async () => {
    const { result } = await renderHook(() => useStackSelection(scopeOf(), lateScope()));
    expect(result.current.familyPath).toEqual([a, b, c, d]);
  });
  it('is the root and every Side of a shared Window, titled as the Window shows them', async () => {
    const sideTitle = (session: { title: string }) => ({ ...session, title: `side ${session.title}` });
    const { result } = await renderHook(() => useStackSelection(scopeOf({ sharedWindow: { views: [] }, sideTitle }), lateScope()));
    expect(result.current.familyPath.map(session => session.title)).toEqual(['side a', 'side b', 'side c']);
  });
  it('is empty for a shared Window without a primary session', async () => {
    const { result } = await renderHook(() => useStackSelection(scopeOf({ sharedWindow: { views: [] }, visibleStackRoot: undefined }), lateScope()));
    expect(result.current.familyPath).toEqual([]);
  });
});

describe('remembering the layout of the tracked view', () => {
  it('records the primary slot, the focus, the anchor and the selection of every session in the path', async () => {
    const remember = vi.fn();
    const { result } = await renderHook(() => useStackSelection(scopeOf({ trackedViews: { remember }, sideSelections: { 'view-a': 'view-b' } }), lateScope()));
    result.current.rememberTrackedView();
    expect(remember).toHaveBeenCalledWith({ primarySlot: 'view-a', focus: 'view-a', anchor: 'view-b',
      selections: { 'view-a': 'view-b', 'view-b': null, 'view-c': null, 'view-d': null } });
  });
  it('records nothing without a primary session', async () => {
    const remember = vi.fn();
    const { result } = await renderHook(() => useStackSelection(scopeOf({ trackedViews: { remember }, visibleStackRoot: undefined }), lateScope()));
    result.current.rememberTrackedView();
    expect(remember).not.toHaveBeenCalled();
  });
});
