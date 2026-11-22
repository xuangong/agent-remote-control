// Unlinking a Side from its source, and removing the reference that links it: the notices that offer to link it again.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockScope, renderHook } from '../test/render-hook.js';
import { useFocusedAsk } from './useFocusedAsk.js';

const setLinked = vi.fn(async () => undefined);
beforeEach(() => setLinked.mockClear());
vi.mock('../features/session-links/useSessionRelations.js', () => ({ useSessionRelations: () => ({ setLinked, reconcile: vi.fn() }) }));

function scopeOf(facts: Record<string, unknown> = {}) {
  return mockScope<typeof useFocusedAsk>({
    accessReady: true, accessReadyRef: { current: true }, ask: { entryFor: () => undefined }, askView: undefined, baseUrl: 'http://relay', connections: { find: () => undefined },
    detachedSideRoot: undefined, directory: undefined, directoryView: undefined, expandedKeys: new Set(), familyPath: [], forkStore: { get: (id: string) => ({ id, linked: false, revision: 2 }) },
    initialState: undefined, mountedTransport: undefined, remoteHosts: [], replicas: new Map(), sessionEntries: [], setFailure: vi.fn(), sharedSlots: undefined, sharedWindow: undefined,
    sideFocus: undefined, stackPath: [], stackRange: { start: 0, end: 0 }, stackRoot: undefined, state: undefined, succession: {}, toast: { show: vi.fn() }, transitioning: false,
    transport: undefined, userScoped: false, visibleStackRoot: undefined, windowWorkspace: {}, ...facts,
  });
}

describe('unlinking a Side', () => {
  it('unlinks the record, and the notice it shows relinks the unlinked record', async () => {
    const scope = scopeOf();
    const { result } = await renderHook(() => useFocusedAsk(scope, {} as never));
    await result.current.unlinkSide({ id: 'fork-1', linked: true, revision: 1 } as never);
    expect(setLinked).toHaveBeenNthCalledWith(1, { id: 'fork-1', linked: true, revision: 1 }, false);
    const [key, , , , action] = (scope.toast!.show as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(key).toBe('unlink-side:fork-1');
    await action.onClick();
    expect(setLinked).toHaveBeenNthCalledWith(2, { id: 'fork-1', linked: false, revision: 2 }, true);
  });
});

describe('removing the reference to a source', () => {
  const linked = { id: 'fork-1', linked: true, revision: 1 };
  const ref = (origin: 'source' | 'added') => ({ providerId: 'codex', nativeSessionId: 'source', origin }) as never;
  it('unlinks the Side that came from that source, and its notice restores the reference', async () => {
    const scope = scopeOf();
    const { result } = await renderHook(() => useFocusedAsk(scope, {} as never));
    const restore = vi.fn(async () => undefined);
    await result.current.removedReference(ref('source'), restore, linked as never);
    expect(setLinked).toHaveBeenCalledExactlyOnceWith(linked, false);
    const [key, , , , action] = (scope.toast!.show as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(key).toBe('reference:codex/source');
    await action.onClick();
    expect(restore).toHaveBeenCalledOnce();
  });
  it('leaves the link of a Side alone when the reference was one the person added', async () => {
    const scope = scopeOf();
    const { result } = await renderHook(() => useFocusedAsk(scope, {} as never));
    await result.current.removedReference(ref('added'), async () => undefined, linked as never);
    expect(setLinked).not.toHaveBeenCalled();
  });
  it('links the Side again when the reference comes back, unless it is already linked', async () => {
    const scope = scopeOf();
    const { result } = await renderHook(() => useFocusedAsk(scope, {} as never));
    await result.current.restoredReference(linked as never);
    expect(setLinked).toHaveBeenCalledExactlyOnceWith({ id: 'fork-1', linked: false, revision: 2 }, true);
    setLinked.mockClear();
    const current = scopeOf({ forkStore: { get: (id: string) => ({ id, linked: true, revision: 3 }) } });
    const again = await renderHook(() => useFocusedAsk(current, {} as never));
    await again.result.current.restoredReference(linked as never);
    expect(setLinked).not.toHaveBeenCalled();
  });
});
