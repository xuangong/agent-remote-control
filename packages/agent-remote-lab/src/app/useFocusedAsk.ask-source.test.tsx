import { describe, expect, it } from 'vitest';
import { mockScope, renderHook, buildOpened } from '../test/render-hook.js';
import { useFocusedAsk } from './useFocusedAsk.js';
import { viewKey } from './helpers.js';

const slot = (id: string, selected: string) => ({ id, intent: { kind: 'session', target: { hostId: 'local', native: { providerId: 'codex', nativeSessionId: selected } } }, metadata: { title: selected, agentId: `agent-${selected}` } });
const binding = (nativeSessionId: string) => ({ hostId: 'local', providerId: 'codex', nativeSessionId, title: nativeSessionId });

function scopeOf(facts: Record<string, unknown>) {
  return mockScope<typeof useFocusedAsk>({
    accessReady: false, accessReadyRef: { current: false }, ask: { entryFor: () => ({}) }, askView: {}, baseUrl: '/', connections: { find: () => undefined }, detachedSideRoot: false,
    directory: undefined, directoryView: undefined, expandedKeys: new Set(), familyPath: [], forkStore: {}, initialState: undefined, mountedTransport: { current: undefined },
    remoteHosts: [], replicas: new Map(), sessionEntries: [], setFailure: () => {}, sharedSlots: undefined, sharedWindow: undefined, sideFocus: undefined,
    stackPath: [], stackRange: { start: 0, end: 0 }, stackRoot: undefined, state: undefined, succession: { ownerFor: () => 'owner', sourceStale: () => undefined, active: true, document: { slots: [], windowBindings: [] } },
    toast: undefined, transitioning: false, transport: {}, userScoped: false, visibleStackRoot: undefined, windowWorkspace: {}, ...facts,
  });
}
const late = () => ({}) as never;

describe('the session an Ask is asked about, outside a shared Window', () => {
  const primary = buildOpened('primary'), side = buildOpened('side');
  it('is the conversation the reader focused: the Side when it holds the focus, the primary otherwise', async () => {
    const onSide = await renderHook(() => useFocusedAsk(scopeOf({ stackPath: [primary, side], stackRange: { start: 0, end: 1 }, visibleStackRoot: primary, sideFocus: viewKey(side) }), late()));
    expect(onSide.result.current.focusedAskSession?.nativeSessionId).toBe('side');
    const onPrimary = await renderHook(() => useFocusedAsk(scopeOf({ stackPath: [primary, side], stackRange: { start: 0, end: 1 }, visibleStackRoot: primary, sideFocus: viewKey(primary) }), late()));
    expect(onPrimary.result.current.focusedAskSession?.nativeSessionId).toBe('primary');
  });
});

describe('the session an Ask is asked about, in a shared Window', () => {
  const window = (selected: string) => ({
    sharedWindow: {}, directoryView: { id: 'view-1', binding: binding('bound') }, sharedSlots: new Map([['view-1', slot('slot-1', selected)]]),
  });
  it('is the focused view\'s session while its slot still selects the session the view is bound to', async () => {
    const { result } = await renderHook(() => useFocusedAsk(scopeOf(window('bound')), late()));
    expect(result.current.focusedAskSession?.nativeSessionId).toBe('bound');
  });
  it('is none once the slot selects another session than the view\'s binding names', async () => {
    const { result } = await renderHook(() => useFocusedAsk(scopeOf(window('other')), late()));
    expect(result.current.focusedAskSession).toBeUndefined();
  });
});

describe('the state an Ask reads of its source', () => {
  const view = buildOpened('docked', { agentId: 'agent-docked' });
  it('is the state of the connection the source\'s own view shows, ahead of any other replica of that agent', async () => {
    const shown = { agent: { id: 'agent-docked' }, marker: 'view connection' };
    const { result } = await renderHook(() => useFocusedAsk(scopeOf({
      connections: { find: () => ({ agentId: 'agent-docked', replica: { getState: () => shown } }) },
      replicas: new Map([['agent-docked', { getState: () => ({ marker: 'cached replica' }) }]]),
    }), late()));
    expect(result.current.sourceStateFor(view)).toBe(shown);
  });
  it('falls back to the cached replica of the agent when no view connection holds it', async () => {
    const cached = { marker: 'cached replica' };
    const { result } = await renderHook(() => useFocusedAsk(scopeOf({ replicas: new Map([['agent-docked', { getState: () => cached }]]) }), late()));
    expect(result.current.sourceStateFor(view)).toBe(cached);
  });
});
