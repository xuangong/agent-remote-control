import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { RemoteTeamClient } from '@orchardworks/agent-client';

vi.mock('../conversation/fork-actions.js', async importOriginal => ({ ...await importOriginal<typeof import('../conversation/fork-actions.js')>(), configureFork: vi.fn(async () => undefined), sendForkInput: vi.fn(async () => undefined) }));

const { ForkStore } = await import('../kernel/session-forks.js');
const { useForks } = await import('./useForks.js');

const source = buildOpened('source');
const agent = { id: source.agentId, providerId: 'codex', cwd: '/work', model: 'gpt', capabilities: {}, runtimeInfo: { sessionId: 'source', settings: [] } };
const sourceState = { agent } as never;
const created = { agentId: 'agent-fork', nativeSessionId: 'native-fork' };

let store: InstanceType<typeof ForkStore>;
beforeEach(() => { store = new ForkStore('forks-hook'); });
afterEach(() => { localStorage.clear(); vi.clearAllMocks(); });

function scopeOf(facts: Record<string, unknown> = {}) {
  const draft = new Map<string, string>();
  const scope = {
    ask: { open: vi.fn(async () => ({ text: 'asked' })) }, askView: { execute: vi.fn(async () => ({ text: 'executed' })), setVisible: vi.fn() }, assertSourceCurrent: vi.fn(), baseUrl: 'https://relay',
    directory: { create: vi.fn(async (_provider: string, _operation: string, _options: object) => created), attach: vi.fn(async () => ({ agentId: 'agent-attached' })) }, draftBindingFor: () => ({ store: { set: (key: string, value: string) => draft.set(key, value), get: (key: string) => draft.get(key) }, key: 'draft' }),
    forkBusy: { current: false }, forkReservation: { current: undefined as unknown }, forkStore: store, letterRequest: { current: { abort: vi.fn() } }, nextSideRequest: vi.fn(() => 1),
    refreshRelations: vi.fn(async () => undefined), rememberSession: vi.fn(), remoteHosts: [{ id: 'local' }], retryHosts: vi.fn(), selectSide: vi.fn(), selectedHost: { id: 'local' },
    setDirectoryRevision: vi.fn(), setFailure: vi.fn(), setForkInputStatus: vi.fn(), sideRequestKey: () => 'source', sideRequests: { current: new Map([['source', 1]]) },
    succession: { ownerFor: () => 'owner' }, transport: {}, viewSession: (session: object) => session, ...facts,
  };
  return { scope, draft, mock: mockScope<typeof useForks>(scope) };
}

async function mount(facts: Record<string, unknown> = {}) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useForks(built.mock));
  return { ...built, hook: result.current };
}

describe('starting a temporary bot with /side', () => {
  const team = (ready: boolean) => ({ id: 'side-task', members: [{ id: 'worker', role: 'leader', hostId: 'local', providerId: 'codex', ...(ready ? { nativeSessionId: 'worker-session' } : {}), creation: ready ? 'ready' : 'reserved' }] }) as never;
  it('asks the Relay for a temporary bot this session organizes, with the text as its mission, and opens it beside the session', async () => {
    const created = vi.spyOn(RemoteTeamClient.prototype, 'create').mockResolvedValue(team(true));
    const { scope, hook } = await mount();
    await hook.createFork(sourceState, source as never, 'console:side', ' Check the logs. ');
    expect(created).toHaveBeenCalledWith({ operationId: expect.any(String), source: { hostId: source.hostId ?? 'local', providerId: source.providerId, nativeSessionId: source.nativeSessionId, title: source.title },
      bot: { name: 'Check the logs.', mission: 'Check the logs.' } });
    expect(scope.directory.create).not.toHaveBeenCalled();
    expect(scope.directory.attach).toHaveBeenCalledWith('codex', 'worker-session');
    expect(scope.selectSide).toHaveBeenCalledWith(source, expect.objectContaining({ agentId: 'agent-attached', nativeSessionId: 'worker-session', title: 'Check the logs.' }));
    expect(scope.forkBusy.current).toBe(false);
  });
  it('names the bot after the first line of its mission, at most 60 characters', async () => {
    const created = vi.spyOn(RemoteTeamClient.prototype, 'create').mockResolvedValue(team(false));
    const { scope, hook } = await mount();
    const line = 'Read every log of the last release and list the errors that repeat';
    await hook.createFork(sourceState, source as never, 'console:side', `${line}\nThen stop.`);
    expect(created.mock.calls[0]![0].bot).toEqual({ name: `${line.slice(0, 59)}…`, mission: `${line}\nThen stop.` });
    // Its session does not exist yet: it opens from its card once it does.
    expect(scope.selectSide).not.toHaveBeenCalled();
  });
  it('asks for the text when there is none, and starts nothing', async () => {
    const created = vi.spyOn(RemoteTeamClient.prototype, 'create');
    const { hook } = await mount();
    await expect(hook.createFork(sourceState, source as never, 'console:side', '  ')).rejects.toThrow('Write what the bot should do after /side.');
    expect(created).not.toHaveBeenCalled();
  });
});

describe('a fork that is refused', () => {
  it('needs a directory and a native session', async () => {
    const noDirectory = await mount({ directory: undefined });
    await expect(noDirectory.hook.createFork(sourceState, source as never, 'console:side', '')).rejects.toThrow('This session cannot be forked.');
    const noSession = await mount();
    await expect(noSession.hook.createFork({ agent: { ...agent, runtimeInfo: { settings: [] } } } as never, source as never, 'console:side', '')).rejects.toThrow('This session cannot be forked.');
  });
  it('checks that the source is current before it does anything', async () => {
    const { scope, hook } = await mount({ assertSourceCurrent: vi.fn(() => { throw new Error('The source session changed.'); }) });
    await expect(hook.createFork(sourceState, source as never, 'console:side', '')).rejects.toThrow('The source session changed.');
    expect(scope.directory.create).not.toHaveBeenCalled();
  });
  it('allows one creation at a time', async () => {
    const { scope, hook } = await mount({ forkBusy: { current: true } });
    await expect(hook.createFork(sourceState, source as never, 'console:side', '')).rejects.toThrow('A session fork is already being created.');
    expect(scope.forkBusy.current).toBe(true);
  });
  it('does not create beyond the session quota of the Host', async () => {
    const { scope, hook } = await mount({ remoteHosts: [{ id: 'local', sessionQuota: { used: 5, limit: 5 } }] });
    await expect(hook.createFork(sourceState, source as never, 'console:fork', '')).rejects.toThrow('Session creation limit reached.');
    expect(scope.directory.create).not.toHaveBeenCalled();
    expect(scope.forkBusy.current).toBe(false);
  });
});

describe('the Ask command', () => {
  it('toggles the Ask without an argument', async () => {
    const { scope, hook } = await mount();
    expect(await hook.createFork(sourceState, source as never, 'console:ask', 'off')).toEqual({ text: 'executed' });
    expect(scope.askView.execute).toHaveBeenCalledWith('off');
    expect(scope.directory.create).not.toHaveBeenCalled();
  });
  it('opens the Ask with a question, synchronizing the relations first and keeping the source current', async () => {
    const { scope, hook } = await mount();
    await hook.createFork(sourceState, source as never, 'console:ask', 'why is it slow');
    expect(scope.askView.setVisible).toHaveBeenCalledWith(true);
    const [, , question, clean, options] = scope.ask.open.mock.calls[0] as unknown as [unknown, unknown, string, boolean, { associationOwner: string; synchronize(): Promise<void> }];
    expect(question).toBe('why is it slow');
    expect(clean).toBe(false);
    expect(options.associationOwner).toBe('owner');
    await options.synchronize();
    expect(scope.refreshRelations).toHaveBeenCalled();
    expect(scope.assertSourceCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('opening a saved Side', () => {
  const recordOf = () => {
    const prepared = store.prepare({ mode: 'reference', source: { ...source }, capturedAt: '2026-01-01T00:00:00.000Z' } as never, { sourceNativeSessionId: 'source' } as never, []);
    store.bind(prepared.id, buildOpened('side', { agentId: 'agent-side' }) as never);
    return store.get(prepared.id);
  };
  it('attaches the Side and selects it beside its source', async () => {
    const record = recordOf();
    const { scope, hook } = await mount();
    await hook.openFork(record);
    expect(scope.directory.attach).toHaveBeenCalledWith('codex', 'side');
    expect(scope.rememberSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-attached' }));
    expect(scope.selectSide).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'source' }), expect.objectContaining({ agentId: 'agent-attached' }));
  });
  it('does not select a Side whose request a newer one superseded', async () => {
    const record = recordOf();
    const { scope, hook } = await mount({ sideRequests: { current: new Map([['source', 2]]) } });
    await hook.openFork(record);
    expect(scope.selectSide).not.toHaveBeenCalled();
  });
  it('shows an attach failure unless it was superseded', async () => {
    const record = recordOf();
    const { scope, hook } = await mount();
    scope.directory.attach.mockRejectedValueOnce(new Error('offline'));
    await hook.openFork(record);
    expect(scope.setFailure).toHaveBeenCalledWith('offline');
    const superseded = await mount({ sideRequests: { current: new Map([['source', 2]]) } });
    superseded.scope.directory.attach.mockRejectedValueOnce(new Error('late'));
    await superseded.hook.openFork(record);
    expect(superseded.scope.setFailure).not.toHaveBeenCalled();
  });
  it('does nothing for a record without a target, or without a directory', async () => {
    const record = recordOf();
    const { scope, hook } = await mount({ directory: undefined });
    await hook.openFork(record);
    await hook.openFork({ ...record, target: undefined });
    expect(scope.nextSideRequest).not.toHaveBeenCalled();
    expect(scope.letterRequest.current.abort).toHaveBeenCalledTimes(2);
  });
});
