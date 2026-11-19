import { describe, expect, it, vi } from 'vitest';
import { buildBinding, buildView, buildWindow } from '../test/window-builders.js';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useLetterNavigation } from './useLetterNavigation.js';

const a = buildOpened('a'), b = buildOpened('b');
const letter = { messageId: 'm1', sender: 'name-a', recipient: 'name-b' };
const sent = { item: { type: 'agent_communication', ...letter }, seqStart: 1, seqEnd: 1, timestamp: 't' };
const received = { ...sent, turnId: 'turn-1' };
const stateOf = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ agent: { id: 'x', runtimeInfo: { childSessions: [] } }, timeline: { epoch: 'e1', entries, hasOlder: false, ...extra } });
const lease = (state: unknown) => ({ client: { getSessionState: () => ({ connection: 'ready' }), subscribeSessionState: () => () => {}, loadOlder: vi.fn(async () => undefined) }, replica: { getState: () => state }, release: vi.fn() });

function scopeOf(facts: Record<string, unknown> = {}) {
  const leases = new Map<string, ReturnType<typeof lease>>([[b.agentId, lease(stateOf([received]))], [a.agentId, lease(stateOf([sent]))]]);
  const states = new Map<string, unknown>([[b.agentId, stateOf([received])]]);
  const scope = {
    assertSourceCurrent: vi.fn(), baseUrl: 'https://relay', compactLayout: false, compactLayoutRef: { current: false },
    connections: { find: (identity: { nativeSessionId: string }) => ({ agentId: `agent-${identity.nativeSessionId}` }), acquire: (agentId: string) => leases.get(agentId)! },
    directory: {}, editWindow: vi.fn(), favorites: { stars: [] }, letterRequest: { current: undefined as AbortController | undefined }, navigationGeneration: { current: 1 },
    openSession: vi.fn(async () => true), openWindows: [a, b], openedSessionsRef: { current: [] }, rememberSession: vi.fn(), replicaFor: () => ({}), replicas: { get: (agentId: string) => ({ getState: () => states.get(agentId) }) },
    selectSide: vi.fn(), selectedHost: { id: 'local' }, setLetterReveals: vi.fn(), setSideAnchor: vi.fn(), setSideFocus: vi.fn(), sharedSlots: undefined, sharedViewForSlot: () => undefined,
    sharedWindow: undefined, showView: vi.fn(), stackPath: [a, b], stackRange: { start: 0, end: 1 }, stackRoot: a, state: undefined, status: 'ready', traceRequestCounter: { current: 0 },
    viewSession: (session: object) => session, windowWorkspace: { readWindow: () => undefined }, ...facts,
  };
  return { scope, leases, mock: mockScope<typeof useLetterNavigation>(scope) };
}

async function mount(facts: Record<string, unknown> = {}) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useLetterNavigation(built.mock));
  return { ...built, navigation: result.current.letterNavigation(a, stateOf([sent]) as never) };
}

describe('the direction of a letter', () => {
  it('points to the neighbour the letter goes to when both sessions are side by side', async () => {
    const { navigation } = await mount();
    expect(navigation.direction(sent as never)).toBe('right');
    const reverse = await mount({ stackPath: [b, a], stackRoot: b });
    expect(reverse.navigation.direction(sent as never)).toBe('left');
  });
  it('points nowhere on a compact layout, or when the recipient is not next to the source', async () => {
    expect((await mount({ compactLayout: true })).navigation.direction(sent as never)).toBeUndefined();
    expect((await mount({ stackRange: { start: 0, end: 0 } })).navigation.direction(sent as never)).toBeUndefined();
  });
  it('lists the visible views of a shared Window family, leaving collapsed and unbound ones out', async () => {
    const root = buildView('a', 'primary', { binding: buildBinding('a') });
    const open = { ...buildView('b', 'attached', { binding: buildBinding('b') }), attachedTo: 'a' };
    const collapsed = { ...buildView('c', 'attached', { binding: buildBinding('c') }), attachedTo: 'a', collapsed: true };
    const sharedWindow = buildWindow([root, open, collapsed]);
    const { navigation } = await mount({ sharedWindow, sharedViewForSlot: () => root, sharedSlots: new Map(), stackPath: [] });
    expect(navigation.direction(sent as never)).toBe('right');
  });
});

describe('opening a letter', () => {
  it('needs a directory and a letter', async () => {
    const none = await mount({ directory: undefined });
    await expect(none.navigation.open(sent as never)).rejects.toThrow('Session navigation is unavailable in this view.');
    const { navigation } = await mount();
    await expect(navigation.open({ item: { type: 'user_message', text: 'hi' } } as never)).rejects.toThrow('Session navigation is unavailable in this view.');
  });
  it('refuses a letter whose two sessions the history does not identify', async () => {
    const { navigation } = await mount({ openWindows: [a], replicas: { get: () => undefined } });
    await expect(navigation.open(sent as never)).rejects.toThrow('This history does not identify both sessions unambiguously.');
  });
  it('brings the recipient into focus and reveals the received letter in it, then releases its leases', async () => {
    const { navigation, scope, leases } = await mount();
    await navigation.open(sent as never);
    expect(scope.setSideFocus).toHaveBeenCalledWith('view-b');
    expect(scope.showView).toHaveBeenCalledWith('workbench');
    const update = scope.setLetterReveals.mock.calls[0]![0] as (values: object) => Record<string, { key: string; align: string; requestId: number }>;
    expect(update({})[b.agentId]).toMatchObject({ align: 'start', requestId: 1, key: expect.any(String) });
    expect(leases.get(b.agentId)!.release).toHaveBeenCalled();
    expect(scope.letterRequest.current).toBeUndefined();
  });
  it('stops an earlier letter request when a new one starts', async () => {
    const earlier = new AbortController();
    const { navigation } = await mount({ letterRequest: { current: earlier } });
    await navigation.open(sent as never);
    expect(earlier.signal.aborted).toBe(true);
  });
  it('checks that the source is current before it starts', async () => {
    const { navigation } = await mount({ assertSourceCurrent: vi.fn(() => { throw new Error('The source session changed.'); }) });
    await expect(navigation.open(sent as never)).rejects.toThrow('The source session changed.');
  });
  it('refuses when the workspace changed while the letter was loading', async () => {
    const built = scopeOf();
    built.leases.get(b.agentId)!.client.getSessionState = () => { built.scope.navigationGeneration.current = 2; return { connection: 'ready' }; };
    const { result } = await renderHook(() => useLetterNavigation(built.mock));
    await expect(result.current.letterNavigation(a, stateOf([sent]) as never).open(sent as never)).rejects.toThrow('The workspace changed. Open the letter again.');
    expect(built.leases.get(b.agentId)!.release).toHaveBeenCalled();
  });
  it('refuses when the target history does not contain the letter', async () => {
    const built = scopeOf();
    built.leases.set(b.agentId, lease(stateOf([])));
    const { result } = await renderHook(() => useLetterNavigation(built.mock));
    await expect(result.current.letterNavigation(a, stateOf([sent]) as never).open(sent as never)).rejects.toThrow();
  });
  it('opens the other endpoint on a compact layout, advancing the navigation', async () => {
    const { navigation, scope } = await mount({ compactLayoutRef: { current: true }, stackPath: [a], stackRange: { start: 0, end: 0 } });
    await navigation.open(sent as never);
    expect(scope.openSession).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'b' }), undefined, undefined, true);
    expect(scope.setLetterReveals).toHaveBeenCalled();
  });
  it('reports a compact-layout target that could not be opened', async () => {
    const { navigation } = await mount({ compactLayoutRef: { current: true }, openSession: vi.fn(async () => false) });
    await expect(navigation.open(sent as never)).rejects.toThrow('The linked session could not be opened.');
  });
});

describe('opening a letter in a shared Window', () => {
  const root = buildView('a', 'primary', { binding: buildBinding('a') });
  const sharedWindow = buildWindow([root]);
  const facts = { sharedWindow, sharedViewForSlot: () => root, sharedSlots: new Map(), windowWorkspace: { readWindow: () => sharedWindow }, stackPath: [] };
  it('adds the other endpoint as an attached view of the source and selects it', async () => {
    const { navigation, scope } = await mount(facts);
    await navigation.open(sent as never);
    const operation = scope.editWindow.mock.calls[0]![0];
    expect(operation.type).toBe('batch');
    expect(operation.operations[0]).toMatchObject({ type: 'view.create', view: { placement: 'attached', attachedTo: 'a' } });
    expect(operation.operations.at(-1).type).toBe('view.select');
  });
  it('refuses when the source view changed while the letter loaded', async () => {
    const { navigation } = await mount({ ...facts, windowWorkspace: { readWindow: () => buildWindow([buildView('a', 'primary', { binding: buildBinding('else') })]) } });
    await expect(navigation.open(sent as never)).rejects.toThrow('The source view changed. Open the letter again.');
  });
});
