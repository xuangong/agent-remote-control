import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowWorkspaceClient, type RemoteTransportListener, type WindowSnapshot } from '@orchardworks/agent-remote-web';
import { App, type LabTransport } from './App.js';
import { ConversationConnections } from './conversation-connections.js';
import { SessionDirectoryClient } from './directory-client.js';
import { replicaState } from './test/fixtures.js';
import { render, unmount } from './test/setup.js';
import * as windowWorkspaceHooks from './hooks/useWindowWorkspace.js';
import * as successionHooks from './hooks/useSessionSuccession.js';

function target(id: string) { return { hostId: 'local', providerId: 'recorded', nativeSessionId: `native-${id}`, title: `Session ${id}` }; }
function windowFixture(id: string, native: string): WorkspaceWindow {
  return { schemaVersion: 2, id, revision: 0, title: id, selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', target(native), 'primary')] };
}
function transportFixture(timelineGate?: Promise<void>) {
  const channels: Array<{ agentId: string; observation?: 'session' | 'activity'; closed: number }> = [];
  const snapshot = (agentId: string) => ({ ...replicaState.agent!, id: agentId,
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId.replace('agent-', 'native-'), connection: { state: 'connected' as const } } });
  const connect = vi.fn((agentId: string, listener: RemoteTransportListener): ReturnType<LabTransport['connect']> => {
    const channel: (typeof channels)[number] = { agentId, closed: 0 }; channels.push(channel);
    const close = () => { channel.closed++; };
    queueMicrotask(() => listener.onOpen());
    return { close, send(message) {
      if (message.type === 'negotiate') {
        channel.observation = message.observation === 'activity' ? 'activity' : 'session';
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
        if (channel.observation === 'activity') {
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId, status: 'idle' } });
          return;
        }
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
          agentId, revision: 'control', access: 'control', available: false, token: 'control-token',
        } });
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot(agentId) });
      } else if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed',
        payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
      else if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
        agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'control-token',
      } });
    } };
  });
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded Provider' }],
    createAgent: async () => { throw new Error('The test opens existing sessions.'); },
    resumeAgent: async () => { throw new Error('The directory attaches existing sessions.'); },
    fetchSnapshot: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot(agentId) }),
    fetchTimeline: async agentId => { await timelineGate; return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'timeline', agentId, epoch: 'epoch-1', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } }; },
    connect, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  };
  return { transport, channels };
}
async function until(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 2000, interval: 1 });
}

it('reuses the same Session client and replica across Windows and releases a deleted Window retention', async () => {
  const scope = 'http://localhost/window-retention-app/';
  const first = windowFixture('first', 'one'), shared = windowFixture('shared', 'one'), other = windowFixture('other', 'two');
  for (const window of [first, shared, other]) localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${window.id}`, JSON.stringify(window));
  history.replaceState(null, '', `/?window=${first.id}`);
  let workspace!: ReturnType<typeof windowWorkspaceHooks.useWindowWorkspace>;
  const useWorkspace = windowWorkspaceHooks.useWindowWorkspace;
  vi.spyOn(windowWorkspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWorkspace(...args); return workspace; });
  let connections!: ConversationConnections;
  const acquire = ConversationConnections.prototype.acquire;
  vi.spyOn(ConversationConnections.prototype, 'acquire').mockImplementation(function (this: ConversationConnections, ...args) {
    connections = this; return acquire.apply(this, args);
  });
  const directory = new SessionDirectoryClient(scope);
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(directory, 'workspaces').mockResolvedValue({ workspaces: [] });
  vi.spyOn(directory, 'attach').mockImplementation(async (_provider, nativeSessionId) => ({
    agentId: nativeSessionId.replace('native-', 'agent-'), nativeSessionId,
  }));
  const fixture = transportFixture();
  let container: HTMLDivElement | undefined;
  try {
    container = await render(<App baseUrl={scope} directory={directory} transport={fixture.transport}
      hostService={{ hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('No pairing is required.'); } }} />);
    await until(() => expect(connections?.find(target('one'))).toBeDefined());
    const original = connections.find(target('one'))!;
    const originalChannel = fixture.channels.find(channel => channel.agentId === 'agent-one' && channel.observation === 'session')!;
    expect(originalChannel.closed).toBe(0);
    expect(original.replica.getState().agent?.id).toBe('agent-one');
    await act(async () => workspace.open(shared.id));
    await until(() => expect(workspace.window?.id).toBe(shared.id));
    expect(connections.find(target('one'))?.client).toBe(original.client);
    expect(connections.find(target('one'))?.replica).toBe(original.replica);
    await act(async () => workspace.open(other.id));
    await until(() => expect(connections.find(target('two'))).toBeDefined());
    expect(connections.find(target('one'))?.client).toBe(original.client);
    expect(originalChannel.closed).toBe(0);
    await act(async () => workspace.open(first.id));
    await until(() => expect(workspace.window?.id).toBe(first.id));
    expect(connections.find(target('one'))?.client).toBe(original.client);
    expect(connections.find(target('one'))?.replica).toBe(original.replica);
    expect(fixture.channels.filter(channel => channel.agentId === 'agent-one' && channel.observation === 'session')).toHaveLength(1);
    await act(async () => workspace.open(other.id));
    await until(() => expect(workspace.window?.id).toBe(other.id));
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="Windows"]')!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Delete Window: first"]')!.click());
    expect(connections.find(target('one'))?.client).toBe(original.client);
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Delete Window: shared"]')!.click());
    await until(() => expect(connections.find(target('one'))).toBeUndefined());
    expect(originalChannel.closed).toBe(1);
    expect(connections.find(target('two'))).toBeDefined();
  } finally {
    if (container) await unmount(container);
    vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
  }
}, 10000);

it('starts the cached Window native Session before Window inspection settles without treating cached state as ready', async () => {
  const scope = 'http://localhost/window-native-before-inspect/';
  const cached = windowFixture('cached', 'one');
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${cached.id}`, JSON.stringify(cached));
  history.replaceState(null, '', `/?window=${cached.id}`);
  let completeInspection!: (snapshot: WindowSnapshot) => void, completeTimeline!: () => void;
  const inspection = new Promise<WindowSnapshot>(resolve => { completeInspection = resolve; });
  const timeline = new Promise<void>(resolve => { completeTimeline = resolve; });
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([cached]);
  const inspect = vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockReturnValue(inspection);
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Fixture route unavailable.' }, { status: 404 })));
  let workspace!: ReturnType<typeof windowWorkspaceHooks.useWindowWorkspace>;
  let succession!: ReturnType<typeof successionHooks.useSessionSuccession>;
  const useWorkspace = windowWorkspaceHooks.useWindowWorkspace, useSuccession = successionHooks.useSessionSuccession;
  vi.spyOn(windowWorkspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWorkspace(...args); return workspace; });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation(options => { succession = useSuccession(options); return succession; });
  const directory = new SessionDirectoryClient(scope);
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(directory, 'workspaces').mockResolvedValue({ workspaces: [] });
  const attach = vi.spyOn(directory, 'attach').mockResolvedValue({ agentId: 'agent-one', nativeSessionId: 'native-one' });
  const fixture = transportFixture(timeline);
  let container: HTMLDivElement | undefined;
  try {
    container = await render(<App baseUrl={scope} userScoped directory={directory} transport={fixture.transport}
      hostService={{ hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('No pairing is required.'); } }} />);
    await until(() => expect(inspect).toHaveBeenCalledWith(cached.id));
    expect(workspace.window?.id).toBe(cached.id);
    expect(workspace.hasActiveWindow).toBe(false);
    await until(() => expect(attach).toHaveBeenCalled());
    await until(() => expect(fixture.channels.filter(channel => channel.observation === 'session')).toHaveLength(1));
    expect(succession.binding).toBeUndefined();
    expect(succession.sessionState.synchronized).toBe(false);
    expect(succession.sessionState.operations.send_message.allowed).toBe(false);
    await act(async () => completeTimeline());
    await until(() => expect(succession.binding?.session.nativeSessionId).toBe('native-one'));
    expect(succession.sessionState.synchronized).toBe(true);
    expect(workspace.hasActiveWindow).toBe(false);
    await act(async () => completeInspection({ window: cached }));
    await until(() => expect(workspace.hasActiveWindow).toBe(true));
    expect(fixture.channels.filter(channel => channel.observation === 'session')).toHaveLength(1);
  } finally {
    completeTimeline(); completeInspection({ window: cached });
    if (container) await unmount(container);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
  }
}, 10000);
