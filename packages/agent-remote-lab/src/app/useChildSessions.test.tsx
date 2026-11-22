import { describe, expect, it, vi } from 'vitest';
import { sessionConnectionFailure } from '../kernel/SessionConnectionNotice.js';
import { DirectoryError } from '../kernel/directory-client.js';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useChildSessions } from './useChildSessions.js';

const parent = buildOpened('parent', { providerId: 'codex' });
const child = { nativeSessionId: 'child', title: 'Child', createdAt: '2026-01-01T00:00:00.000Z' };
const parentState = { agent: { id: parent.agentId, providerId: 'codex', runtimeInfo: { sessionId: 'parent' } } };

function scopeOf(facts: Record<string, unknown> = {}) {
  const sideRequests = { current: new Map<string, number>() };
  const attachChild = vi.fn(async () => ({ agentId: 'agent-child', nativeSessionId: 'native-child' }));
  const scope = {
    activeOpened: parent, assertSourceCurrent: vi.fn(), baseUrl: 'https://relay', compactLayoutRef: { current: false }, connections: { find: vi.fn(() => undefined) }, directory: { attachChild },
    letterRequest: { current: { abort: vi.fn() } }, navigationGeneration: { current: 1 }, nextSideRequest: vi.fn(() => { sideRequests.current.set('parent', 1); return 1; }), openSession: vi.fn(async () => true),
    rememberSession: vi.fn(), selectedHost: { id: 'local' }, sessionEntries: [], setFailure: vi.fn(), setSessionNotice: vi.fn(), setTransitioning: vi.fn(), sharedWindow: undefined,
    sideRequestKey: () => 'parent', sideRequests, stackPath: [parent], state: parentState, transitionRef: { current: false }, viewSession: (session: object) => session,
    windowSession: { openAttached: vi.fn(async () => true) }, openWindows: [parent], selectSide: vi.fn(), ...facts,
  };
  return { scope, attachChild, mock: mockScope<typeof useChildSessions>(scope) };
}

async function mount(facts: Record<string, unknown> = {}) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useChildSessions(built.mock));
  return { ...built, open: (source?: unknown, state?: unknown) => result.current.openChildSession(child as never, source as never, state as never) };
}

describe('opening a child session beside its parent', () => {
  it('asks the Host for the child of the parent, remembers both and selects the child as a Side', async () => {
    const { scope, attachChild, open } = await mount();
    await open();
    expect(attachChild).toHaveBeenCalledWith('codex', 'parent', 'child');
    expect(scope.rememberSession).toHaveBeenCalledWith(parent);
    expect(scope.rememberSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-child', parentAgentId: parent.agentId, parentNativeSessionId: 'parent' }));
    expect(scope.selectSide).toHaveBeenCalledWith(parent, expect.objectContaining({ agentId: 'agent-child' }));
    expect(scope.openSession).not.toHaveBeenCalled();
  });
  it('selects an already connected child without asking the Host', async () => {
    const { scope, attachChild, open } = await mount({ connections: { find: () => ({ agentId: 'cached-child' }) } });
    await open();
    expect(attachChild).not.toHaveBeenCalled();
    expect(scope.selectSide).toHaveBeenCalledWith(parent, expect.objectContaining({ agentId: 'cached-child' }));
  });
  it('opens the parent first when it is not on screen', async () => {
    const { scope, open } = await mount({ stackPath: [] });
    await open();
    expect(scope.openSession).toHaveBeenCalledWith(parent);
    expect(scope.selectSide).toHaveBeenCalled();
  });
  it('fails when the parent cannot be opened', async () => {
    const { open } = await mount({ stackPath: [], openSession: vi.fn(async () => false) });
    await expect(open()).rejects.toThrow('The parent session could not be opened.');
  });
  it('opens a nested child from its direct parent, and refuses when that parent is not open', async () => {
    const direct = buildOpened('direct');
    const known = { nativeSessionId: 'child', providerId: 'codex', hostId: 'local', parentNativeSessionId: 'direct' };
    const nested = await mount({ sessionEntries: [known], openWindows: [parent, direct] });
    await nested.open();
    expect(nested.attachChild).toHaveBeenCalledWith('codex', 'direct', 'child');
    const closed = await mount({ sessionEntries: [known], openWindows: [parent] });
    await expect(closed.open()).rejects.toThrow('Open the direct parent session before opening this nested subagent.');
  });
  it('drops the answer when the workspace changed meanwhile, and shows nothing', async () => {
    const built = scopeOf();
    built.attachChild.mockImplementation(async () => { built.scope.navigationGeneration.current = 2; return { agentId: 'agent-child', nativeSessionId: 'x' }; });
    const { result } = await renderHook(() => useChildSessions(built.mock));
    await result.current.openChildSession(child as never);
    expect(built.scope.selectSide).not.toHaveBeenCalled();
  });
  it('drops the answer when a newer Side request of the source superseded it', async () => {
    const built = scopeOf();
    built.attachChild.mockImplementation(async () => { built.scope.sideRequests.current.set('parent', 2); return { agentId: 'agent-child', nativeSessionId: 'x' }; });
    const { result } = await renderHook(() => useChildSessions(built.mock));
    await result.current.openChildSession(child as never);
    expect(built.scope.selectSide).not.toHaveBeenCalled();
  });
  it('shows a failure as a notice and rethrows it', async () => {
    const { scope, attachChild, open } = await mount();
    attachChild.mockRejectedValue(new DirectoryError('offline', 'host_offline'));
    await expect(open()).rejects.toThrow('offline');
    expect(scope.setSessionNotice).toHaveBeenCalledWith(sessionConnectionFailure(new DirectoryError('offline', 'host_offline'), false));
  });
  it('needs the parent to have a native session id', async () => {
    await expect((await mount({ state: { agent: { ...parentState.agent, runtimeInfo: {} } } })).open()).rejects.toThrow('The parent session is unavailable.');
    await expect((await mount({ state: { agent: undefined } })).open()).rejects.toThrow('The parent session is unavailable.');
  });
  it('takes the parent from the state of the conversation when no view or active session names it', async () => {
    const { attachChild, open } = await mount({ activeOpened: undefined });
    await open();
    expect(attachChild).toHaveBeenCalledWith('codex', 'parent', 'child');
  });
  it('takes the parent from the source it is given before the active session', async () => {
    const other = buildOpened('other', { providerId: 'codex' });
    const { attachChild, open } = await mount({ stackPath: [other] });
    await open(other, { agent: { id: other.agentId, providerId: 'codex', runtimeInfo: { sessionId: 'other' } } });
    expect(attachChild).toHaveBeenCalledWith('codex', 'other', 'child');
  });
  it('asks a Host other than the selected one through its own client', async () => {
    const remote = buildOpened('parent', { hostId: 'remote' });
    const { attachChild, open } = await mount({ activeOpened: remote, selectedHost: { id: 'other-host' }, baseUrl: 'http://127.0.0.1:1' });
    await expect(open()).rejects.toThrow();
    expect(attachChild).not.toHaveBeenCalled();
  });
  it('needs the state of the parent and a directory', async () => {
    await expect((await mount({ state: undefined })).open()).rejects.toThrow('The parent session is unavailable.');
    await expect((await mount({ directory: undefined })).open()).rejects.toThrow('The parent session is unavailable.');
  });
  it('stops an open letter request before anything else', async () => {
    const { scope, open } = await mount({ state: undefined });
    await open().catch(() => undefined);
    expect(scope.letterRequest.current.abort).toHaveBeenCalled();
  });
  it('checks that the source is still current', async () => {
    const { scope, open } = await mount({ assertSourceCurrent: vi.fn(() => { throw new Error('The source session changed.'); }) });
    await expect(open()).rejects.toThrow('The source session changed.');
    expect(scope.openSession).not.toHaveBeenCalled();
  });
});

describe('opening a child session in place of the parent', () => {
  const compact = { compactLayoutRef: { current: true } };
  it('attaches the child and opens it attached, as a child of the parent', async () => {
    const { scope, attachChild, open } = await mount(compact);
    await open();
    expect(attachChild).toHaveBeenCalledWith('codex', 'parent', 'child');
    expect(scope.windowSession.openAttached).toHaveBeenCalledWith({ agentId: 'agent-child', providerId: 'codex', nativeSessionId: 'native-child', title: 'Child', createdAt: child.createdAt,
      hostId: 'local', parentAgentId: parent.agentId, parentNativeSessionId: 'parent' });
    expect(scope.setSessionNotice).toHaveBeenCalledWith({ tone: 'status', message: 'Opening the existing child session. Waiting for the Host to confirm it is ready…' });
  });
  it('holds the opening lock while it works and frees it afterwards, also after a failure', async () => {
    const ok = await mount(compact);
    const pending = ok.open();
    expect(ok.scope.transitionRef.current).toBe(true);
    await pending;
    expect(ok.scope.transitionRef.current).toBe(false);
    expect(ok.scope.setTransitioning.mock.calls.map(call => call[0])).toEqual([true, false]);
    const failing = await mount(compact);
    failing.attachChild.mockRejectedValue(new Error('boom'));
    await expect(failing.open()).rejects.toThrow('boom');
    expect(failing.scope.transitionRef.current).toBe(false);
  });
  it('does nothing while another session is opening', async () => {
    const { scope, attachChild, open } = await mount({ ...compact, transitionRef: { current: true } });
    await open();
    expect(attachChild).not.toHaveBeenCalled();
    expect(scope.windowSession.openAttached).not.toHaveBeenCalled();
  });
  it('takes the parent the directory records for the child', async () => {
    const { attachChild, scope, open } = await mount({ ...compact, sessionEntries: [{ nativeSessionId: 'child', providerId: 'codex', hostId: 'local', parentNativeSessionId: 'recorded', parentAgentId: 'agent-recorded' }] });
    await open();
    expect(attachChild).toHaveBeenCalledWith('codex', 'recorded', 'child');
    expect(scope.windowSession.openAttached).toHaveBeenCalledWith(expect.objectContaining({ parentAgentId: 'agent-recorded', parentNativeSessionId: 'recorded' }));
  });
  it('shows a failure as a notice only in the workspace it started in', async () => {
    const stale = await mount(compact);
    stale.attachChild.mockImplementation(async () => { stale.scope.navigationGeneration.current = 2; throw new Error('late'); });
    await expect(stale.open()).rejects.toThrow('late');
    expect(stale.scope.setSessionNotice).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('late') }));
  });
  it('uses the shared Window route even on a compact layout', async () => {
    const { scope, open } = await mount({ ...compact, sharedWindow: {} });
    await open();
    expect(scope.selectSide).toHaveBeenCalled();
    expect(scope.windowSession.openAttached).not.toHaveBeenCalled();
  });
});
