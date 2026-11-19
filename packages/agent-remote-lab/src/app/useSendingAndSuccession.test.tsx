import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteOperationError } from '@orchardworks/agent-client';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useSendingAndSuccession } from './useSendingAndSuccession.js';

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

const root = buildOpened('root', { hostId: 'h1' });
const client = { sendMessage: vi.fn(async () => undefined), steer: vi.fn(async () => undefined) };
const sessionState = { agent: { id: root.agentId }, timeline: { epoch: 'e1', entries: [] } };

function scopeOf(facts: Record<string, unknown> = {}) {
  const scope = {
    accessReady: true, accessReadyRef: { current: true }, actions: undefined, activeAgentId: root.agentId, activeOpened: root, activeRemoteSession: undefined, assertSourceCurrent: vi.fn(), baseUrl: 'https://relay',
    boundFork: undefined, clientRef: { current: client }, createFork: vi.fn(async () => ({ text: 'forked' })), currentGroupBinding: () => undefined, detachedSideRoot: undefined, directory: {},
    fixtureAction: undefined, forkStore: {}, hostOffline: false, nativeTakeover: undefined, navigationIntent: {}, openSession: vi.fn(), openingHandoff: undefined, primaryIsBound: true,
    remoteHosts: [{ id: 'h1', access: 'owned', online: true }], runMutation: vi.fn(async (run: () => Promise<unknown>) => run()), selectedHost: { id: 'h1' }, sessionEntries: [],
    sessionState: {}, setNativeTakeover: vi.fn(), setRefusedOffline: vi.fn(), stackRoot: root, state: sessionState, status: 'ready',
    succession: { active: false, isCurrent: () => true, document: { slots: [], roles: [], windowBindings: [] }, desired: undefined, successionContextFor: vi.fn() },
    transitionRef: { current: false }, transitioning: false, transport: {}, userScoped: true, viewNavigation: () => ({}), ...facts,
  };
  return { scope, mock: mockScope<typeof useSendingAndSuccession>(scope) };
}

async function mount(facts: Record<string, unknown> = {}) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useSendingAndSuccession(built.mock));
  return { ...built, result };
}

describe('offering a Handoff of the main conversation', () => {
  it('offers it for a ready, owned, writable main conversation on an online Host', async () => {
    expect((await mount()).result.current.canHandoffPrimary).toBe(true);
  });
  it.each([
    ['there is no directory', { directory: undefined }], ['the page has no user', { userScoped: false }], ['access is restoring', { accessReady: false }], ['the Host is offline', { hostOffline: true }],
    ['the session is not ready', { status: 'connecting' }], ['the main session is not bound', { primaryBound: false, primaryIsBound: false }], ['a session is opening', { transitioning: true }],
    ['a Side is detached', { detachedSideRoot: 'view-x' }], ['the conversation is a fork', { boundFork: {}, forkStore: new Proxy({}, { get: () => () => undefined }) }], ['the session is read-only', { sessionState: { readOnly: true } }],
    ['there is no main session', { stackRoot: undefined }], ['the main session is a subagent', { stackRoot: { ...root, parentNativeSessionId: 'parent' } }],
    ['the view is a history view', { navigationIntent: { sessionIntent: 'history' } }], ['the Host is only shared', { remoteHosts: [{ id: 'h1', access: 'shared', online: true }] }],
    ['the Host of the session is offline', { remoteHosts: [{ id: 'h1', access: 'owned', online: false }] }], ['the Host of the session is unknown', { remoteHosts: [{ id: 'other', access: 'owned', online: true }] }],
  ])('does not offer it when %s', async (_name, change) => {
    expect((await mount(change)).result.current.canHandoffPrimary).toBe(false);
  });
  it('does not offer a second Handoff while the dialog is open', async () => {
    const { result } = await mount();
    await act(async () => { await result.current.executePrimaryCommand('console:handoff', ''); });
    expect(result.current.canHandoffPrimary).toBe(false);
    expect(result.current.successionDialog).toMatchObject({ scope: 'https://relay', source: root, visible: true });
  });
});

describe('the /handoff command', () => {
  it('opens the Handoff dialog for the main conversation, naming the provider it was given', async () => {
    const { result, scope } = await mount();
    await act(async () => { await result.current.executePrimaryCommand('console:handoff', 'Claude'); });
    expect(result.current.successionDialog).toMatchObject({ initialProvider: 'claude', source: root });
    expect(scope.assertSourceCurrent).toHaveBeenCalledWith(root);
  });
  it.each(['claude extra', 'claude;codex'])('refuses the malformed provider %j before it opens anything', async args => {
    const { result } = await mount();
    await expect(result.current.executePrimaryCommand('console:handoff', args)).rejects.toThrow('Use /handoff or /handoff <provider>');
    expect(result.current.successionDialog).toBeUndefined();
  });
  it('refuses where Handoff is not offered', async () => {
    const { result } = await mount({ navigationIntent: { sessionIntent: 'history' } });
    await expect(result.current.executePrimaryCommand('console:handoff', '')).rejects.toThrow('Handoff is available on the current main conversation with authorized Host access.');
    expect(result.current.successionDialog).toBeUndefined();
  });
  it('hands every other command to the fork creation of the session', async () => {
    const { result, scope } = await mount();
    expect(await result.current.executePrimaryCommand('console:side', 'why')).toEqual({ text: 'forked' });
    expect(scope.createFork).toHaveBeenCalledWith(sessionState, root, 'console:side', 'why');
  });
  it('makes a session wait before it forks while it is not ready', async () => {
    for (const change of [{ state: undefined }, { status: 'connecting' }, { hostOffline: true }]) {
      const { result, scope } = await mount(change);
      await expect(result.current.executePrimaryCommand('console:side', '')).rejects.toThrow('Wait for this session to finish synchronizing.');
      expect(scope.createFork).not.toHaveBeenCalled();
    }
  });
});

describe('unsent messages and the Handoff dialog', () => {
  const progress = (result: { current: ReturnType<typeof useSendingAndSuccession> }) => (result.current.successionProgress as { props: { blockedReason?: string } }).props.blockedReason;
  it('block it while the main composer holds pending messages, and release it once they are sent', async () => {
    const { result } = await mount();
    await act(async () => { await result.current.executePrimaryCommand('console:handoff', ''); });
    expect(progress(result)).toBeUndefined();
    await act(async () => result.current.reportPendingPrimaryInput(2));
    expect(progress(result)).toBe('Send or remove pending messages before handing off this conversation.');
    await act(async () => result.current.reportPendingPrimaryInput(0));
    expect(progress(result)).toBeUndefined();
  });
  it('count the pending messages of a group view for a source that a group owns', async () => {
    const { result } = await mount({ succession: { active: false, isCurrent: () => true, document: { slots: [], roles: [], windowBindings: [{ slotId: root.viewId }] }, desired: undefined, successionContextFor: vi.fn() } });
    await act(async () => { await result.current.executePrimaryCommand('console:handoff', ''); });
    await act(async () => result.current.reportPendingPrimaryInput(2));
    expect(progress(result)).toBeUndefined();
    await act(async () => result.current.setPendingGroupInputs({ [root.viewId]: 1 }));
    expect(progress(result)).toBe('Send or remove pending messages before handing off this conversation.');
  });
});

describe('sending for the conversation', () => {
  it('sends through the client the action was built for', async () => {
    const { result } = await mount();
    await result.current.clientActions.sendMessage!('hello');
    expect(client.sendMessage).toHaveBeenCalledWith('hello', undefined);
  });
  it('refuses while workspace access is restoring', async () => {
    const { result } = await mount({ accessReadyRef: { current: false } });
    await expect(result.current.clientActions.sendMessage!('hello')).rejects.toThrow('Workspace access is restoring.');
  });
  it('refuses while a succession view has not confirmed its native session', async () => {
    const { result } = await mount({ succession: { active: true, isCurrent: () => false, document: { slots: [], roles: [], windowBindings: [] }, successionContextFor: vi.fn() } });
    await expect(result.current.clientActions.sendMessage!('hello')).rejects.toThrow('The current native session has not been confirmed.');
  });
  it('refuses once the conversation changed under the action, and says how to retry', async () => {
    const built = scopeOf();
    const { result } = await renderHook(() => useSendingAndSuccession(built.mock));
    built.scope.clientRef.current = { sendMessage: vi.fn(), steer: vi.fn() } as never;
    const failure = await result.current.clientActions.sendMessage!('hello').catch(error => error);
    expect(failure).toBeInstanceOf(RemoteOperationError);
    expect(failure).toMatchObject({ code: 'session_changed' });
  });
  it('remembers that the Host refused a message because it is offline', async () => {
    client.sendMessage.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'host_offline' }));
    const { result, scope } = await mount();
    await expect(result.current.clientActions.sendMessage!('hello')).rejects.toThrow('offline');
    expect(scope.setRefusedOffline).toHaveBeenCalledWith('h1');
  });
  it('offers every action while the session is ready, and only sending and deleting otherwise', async () => {
    const ready = await mount();
    expect(ready.result.current.availableConversationActions.cancel).toBeDefined();
    for (const change of [{ accessReady: false }, { hostOffline: true }, { status: 'connecting' }]) {
      const { result } = await mount(change);
      expect(Object.keys(result.current.availableConversationActions).sort()).toEqual(['deleteMessage', 'sendMessage', 'sendMessageContent']);
    }
  });
});

describe('holding the main conversation while a Handoff runs', () => {
  it('holds it for the source of the dialog once the dialog is gated by an intent', async () => {
    const { result } = await mount();
    expect(result.current.primarySuccessionGated).toBe(false);
    await act(async () => { await result.current.executePrimaryCommand('console:handoff', ''); });
    await act(async () => (result.current.successionProgress as { props: { onIntent(operation: unknown, cancelled?: boolean): void } }).props.onIntent({ operationId: 'op' }, false));
    expect(result.current.successionGated).toBe(true);
    expect(result.current.primarySuccessionGated).toBe(true);
  });
  it('lets go again when the dialog closes', async () => {
    const { result } = await mount();
    await act(async () => { await result.current.executePrimaryCommand('console:handoff', ''); });
    await act(async () => (result.current.successionProgress as { props: { onIntent(operation: unknown, cancelled?: boolean): void } }).props.onIntent({ operationId: 'op' }, false));
    await act(async () => (result.current.successionProgress as { props: { onClose(retain?: boolean): void } }).props.onClose(false));
    expect(result.current.successionDialog).toBeUndefined();
    expect(result.current.primarySuccessionGated).toBe(false);
  });
});
