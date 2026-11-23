import { describe, expect, it, vi } from 'vitest';
import { sessionConnectionFailure } from '../kernel/SessionConnectionNotice.js';
import { DirectoryError } from '../kernel/directory-client.js';
import { mockScope, renderHook } from '../test/render-hook.js';
import { useAgentCreation } from './useAgentCreation.js';

const created = { agentId: 'agent-new', nativeSessionId: 'native-new' };

function scopeOf(facts: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const scope = {
    attach: vi.fn(), closeContext: vi.fn(), createPlanning: false, creationReservation: { current: undefined as unknown }, creationUnavailableReason: undefined,
    directory: { create: vi.fn(async (_provider: string, _operation: string, _options: object) => created) }, directoryDestination: () => ({ windowId: 'W', viewId: 'v', binding: 'null' }), dispatchPanels: vi.fn(),
    navigation: { select: vi.fn() }, providerConnectionName: (host: string, provider: string) => `${provider}@${host}`, providerId: 'codex', rememberSession: vi.fn(),
    retryHosts: vi.fn(), selectedHost: { id: 'local' }, sessionOptions: { cwd: '/work' }, setCreationLocked: vi.fn(), setDirectoryRevision: vi.fn(), setFailure: vi.fn(),
    setNewBot: vi.fn(), setProviderName: vi.fn(), setSessionNotice: vi.fn(), setTransitioning: vi.fn((_value: boolean) => { calls.push('transitioning'); }), showView: vi.fn(),
    trackedViews: { select: vi.fn() }, transitionRef: { current: false }, transport: { createAgent: vi.fn(async () => ({ payload: { agentId: 'transport-agent' } })) },
    windowWorkspace: { createBotGroup: vi.fn(async () => ({ groupId: 'G', viewId: 'V' })) }, rememberTrackedView: vi.fn(), bindDirectorySession: vi.fn(async () => true), ...facts,
  };
  return { scope, mock: mockScope<typeof useAgentCreation>(scope), calls };
}

async function create(facts: Record<string, unknown> = {}, bot = false) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useAgentCreation(built.mock));
  await result.current.createAgent(bot);
  return built.scope;
}

describe('creating a session from the New session form', () => {
  it('reserves the creation, asks the Host once and binds the new session to the chosen view', async () => {
    const scope = await create();
    expect(scope.directory.create).toHaveBeenCalledTimes(1);
    expect(scope.directory.create).toHaveBeenCalledWith('codex', expect.any(String), { cwd: '/work' });
    expect(scope.setCreationLocked).toHaveBeenCalledWith(true);
    expect(scope.rememberSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-new', nativeSessionId: 'native-new', title: 'New session', hostId: 'local' }));
    expect(scope.bindDirectorySession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-new' }), { windowId: 'W', viewId: 'v', binding: 'null' });
    expect(scope.trackedViews.select).toHaveBeenCalledWith();
    expect(scope.showView).toHaveBeenCalledWith('workbench');
  });
  it('releases the reservation and the lock once the session is bound, and shows the session list', async () => {
    const scope = await create();
    expect(scope.creationReservation.current).toBeUndefined();
    expect(scope.setCreationLocked).toHaveBeenLastCalledWith(false);
    expect(scope.dispatchPanels).toHaveBeenCalledWith({ type: 'sessionPanel.set', panel: 'list' });
    expect(scope.setProviderName).toHaveBeenCalledWith('codex@local');
    expect(scope.setDirectoryRevision).toHaveBeenCalled();
  });
  it('asks for planning only when the form wants it and the provider takes it', async () => {
    const planned = await create({ createPlanning: true });
    expect(planned.directory.create).toHaveBeenCalledWith('codex', expect.any(String), { cwd: '/work', planning: true });
    const dsh = await create({ createPlanning: true, providerId: 'dsh' });
    expect(dsh.directory.create).toHaveBeenCalledWith('dsh', expect.any(String), { cwd: '/work' });
  });
  it('holds the opening lock while it works and frees it afterwards', async () => {
    const built = scopeOf();
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    const pending = result.current.createAgent();
    expect(built.scope.transitionRef.current).toBe(true);
    await pending;
    expect(built.scope.transitionRef.current).toBe(false);
    expect(built.scope.setTransitioning.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('checks the Hosts again after creating on a remote Host', async () => {
    expect((await create({ selectedHost: { id: 'remote' } })).retryHosts).toHaveBeenCalled();
    expect((await create()).retryHosts).not.toHaveBeenCalled();
  });
  it.each([['no provider', { providerId: undefined }], ['an unavailable catalog', { creationUnavailableReason: 'offline' }], ['another opening in flight', { transitionRef: { current: true } }]])('does nothing with %s', async (_name, change) => {
    const scope = await create(change);
    expect(scope.directory.create).not.toHaveBeenCalled();
    expect(scope.setFailure).not.toHaveBeenCalled();
  });
});

describe('creating without a directory', () => {
  it('asks the transport for an agent and attaches to it', async () => {
    const scope = await create({ directory: undefined });
    expect(scope.transport.createAgent).toHaveBeenCalledWith(expect.stringMatching(/^lab-/), 'codex', expect.objectContaining({ sessionId: expect.any(String) }));
    expect(scope.attach).toHaveBeenCalledWith('transport-agent');
    expect(scope.trackedViews.select).toHaveBeenCalled();
  });
});

describe('creating a bot', () => {

  it('creates the session, then a group named after it, and selects its view', async () => {
    const scope = await create({}, true);
    expect(scope.directory.create).toHaveBeenCalledWith('codex', expect.any(String), { cwd: '/work' });
    expect(scope.windowWorkspace.createBotGroup).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'native-new' }));
    expect(scope.navigation.select).toHaveBeenCalledWith({ kind: 'bot', groupId: 'G', viewId: 'V' });
    expect(scope.setNewBot).toHaveBeenCalledWith({ open: false });
    expect(scope.bindDirectorySession).not.toHaveBeenCalled();
  });
  it('does nothing without a directory', async () => {
    const scope = await create({ directory: undefined }, true);
    expect(scope.windowWorkspace.createBotGroup).not.toHaveBeenCalled();
  });
  it('shows a failure of the Host in the New bot sheet, keeping the reservation for Retry', async () => {
    const scope = await create({ directory: { create: vi.fn(async () => { throw new DirectoryError('Host unavailable', 'host_offline'); }) } }, true);
    const update = scope.setNewBot.mock.calls.at(-1)![0] as (value: object) => { failure?: string };
    expect(update({}).failure).toBe('Host unavailable Retry keeps the same session reservation and settings.');
    expect(scope.creationReservation.current).toMatchObject({ bot: true });
    expect(scope.setFailure).not.toHaveBeenCalledWith(expect.stringContaining('Host'));
  });
  it('leaves the sheet alone once the session exists and only the group failed', async () => {
    const scope = await create({ windowWorkspace: { createBotGroup: vi.fn(async () => { throw new Error('group failed'); }) } }, true);
    const sheet = scope.setNewBot.mock.calls.map(call => call[0]).filter(value => typeof value === 'function');
    for (const update of sheet) expect((update as (value: object) => { failure?: string })({}).failure).toBeUndefined();
  });
});

describe('a creation the Host refuses', () => {
  const failing = (error: Error) => ({ directory: { create: vi.fn(async () => { throw error; }) } });
  it('names the failure and promises that Retry keeps the reservation', async () => {
    const scope = await create(failing(new DirectoryError('Host busy', 'host_busy')));
    expect(scope.setFailure).toHaveBeenCalledWith('Host busy Retry keeps the same session reservation and settings.');
    expect(scope.creationReservation.current).toBeDefined();
    expect(scope.transitionRef.current).toBe(false);
  });
  it('drops the reservation and unlocks the form when the Host refused the request itself', async () => {
    const scope = await create(failing(new DirectoryError('Quota used up', 'session_quota_exceeded')));
    expect(scope.setFailure).toHaveBeenCalledWith('Quota used up');
    expect(scope.creationReservation.current).toBeUndefined();
    expect(scope.setCreationLocked).toHaveBeenLastCalledWith(false);
  });
  it('reports the native file limit as a notice that creation may have partly happened, not as a failure', async () => {
    const scope = await create(failing(new DirectoryError('limit', 'native_file_limit')));
    expect(scope.setFailure).not.toHaveBeenCalledWith(expect.stringContaining('limit'));
    const notice = scope.setSessionNotice.mock.calls.map(call => call[0]).find(value => value && typeof value === 'object') as { message: string; operation: string };
    expect(notice.operation).toBe('Create session');
    expect(notice.message).toContain('Creation may have partially completed.');
  });
  it('reports a plain error without a retry promise when there is no directory', async () => {
    const scope = await create({ directory: undefined, transport: { createAgent: vi.fn(async () => { throw new Error('transport down'); }) } });
    expect(scope.setFailure).toHaveBeenCalledWith('transport down');
  });
});

describe('creating twice', () => {
  it('starts one creation when the control is activated twice before the page renders again', async () => {
    const built = scopeOf();
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    await Promise.all([result.current.createAgent(), result.current.createAgent()]);
    expect(built.scope.directory.create).toHaveBeenCalledTimes(1);
  });
  it('creates an ordinary session when no argument says bot', async () => {
    const built = scopeOf();
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    await result.current.createAgent();
    expect(built.scope.bindDirectorySession).toHaveBeenCalled();
    expect(built.scope.windowWorkspace.createBotGroup).not.toHaveBeenCalled();
  });
  it('retries with the reservation of the attempt that failed, so the Host creates the session once', async () => {
    const built = scopeOf();
    built.scope.directory.create.mockRejectedValueOnce(new DirectoryError('Host busy', 'host_busy'));
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    await result.current.createAgent();
    await result.current.createAgent();
    const [first, second] = built.scope.directory.create.mock.calls.map(call => call[1]);
    expect(second).toBe(first);
  });
  it('locks the form while the Host creates, and brackets the transition for the page', async () => {
    const built = scopeOf();
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    await result.current.createAgent();
    expect(built.scope.setCreationLocked.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(built.scope.setTransitioning.mock.calls.map(call => call[0])).toEqual([true, false]);
    const bot = scopeOf();
    const hooked = await renderHook(() => useAgentCreation(bot.mock));
    await hooked.result.current.createAgent(true);
    expect(bot.scope.setCreationLocked.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(bot.scope.setTransitioning.mock.calls.map(call => call[0])).toEqual([true, false]);
  });
  it('names the session after the Host answer, falling back to the agent id for its native id', async () => {
    const built = scopeOf({ directory: { create: vi.fn(async () => ({ agentId: 'agent-only' })) } });
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    await result.current.createAgent();
    expect(built.scope.rememberSession).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'agent-only', title: 'New session' }));
    const bot = scopeOf({ directory: { create: vi.fn(async () => ({ agentId: 'agent-only' })) } });
    const hooked = await renderHook(() => useAgentCreation(bot.mock));
    await hooked.result.current.createAgent(true);
    expect(bot.scope.rememberSession).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'agent-only' }));
  });
  it('asks the transport for planning when the form wants it', async () => {
    const built = scopeOf({ directory: undefined, createPlanning: true });
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    await result.current.createAgent();
    expect(built.scope.transport.createAgent).toHaveBeenCalledWith(expect.any(String), 'codex', { sessionId: expect.any(String), planning: true });
    const plain = scopeOf({ directory: undefined });
    const hooked = await renderHook(() => useAgentCreation(plain.mock));
    await hooked.result.current.createAgent();
    expect(plain.scope.transport.createAgent).toHaveBeenCalledWith(expect.any(String), 'codex', { sessionId: expect.any(String) });
  });
  it('words the native file limit notice as a connection failure that is not retrying', async () => {
    const error = new DirectoryError('limit', 'native_file_limit');
    const built = scopeOf({ directory: { create: vi.fn(async () => { throw error; }) } });
    const { result } = await renderHook(() => useAgentCreation(built.mock));
    await result.current.createAgent();
    const base = sessionConnectionFailure(error, false);
    expect(built.scope.setSessionNotice).toHaveBeenCalledWith({ ...base, operation: 'Create session', message: expect.stringContaining(base.message) });
  });
});
