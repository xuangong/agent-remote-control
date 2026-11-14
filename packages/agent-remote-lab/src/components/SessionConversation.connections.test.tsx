import 'fake-indexeddb/auto';
import { act, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { HttpWebSocketTransport, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { DraftStore } from '../draft-store.js';
import { WorkspaceReady } from '../workspace-access.js';
import { LiveConnectionsContext, liveConnections } from '../hooks/useLiveBudget.js';
import { LiveBudget } from '../live-budget.js';
import { useWindowSessionRetention } from '../hooks/useWindowSessionRetention.js';
import { createRecordedValidationServer } from '../server/recorded.js';
import { render, unmount, setPromptText, promptText } from '../test/setup.js';
import { SessionConversation } from './SessionConversation.js';

it('releases conversations the live budget no longer keeps, keeping history and drafts, and attaches again when shown', async () => {
  const server = createRecordedValidationServer();
  const { url } = await server.http.listen();
  const sockets: WebSocket[] = [];
  const transport = new HttpWebSocketTransport(url, { sessionChannels: true, webSocketFactory: address => {
    const socket = new WebSocket(address, { origin: process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175' });
    sockets.push(socket); return socket as unknown as WebSocketLike;
  } });
  const created = await transport.createAgent('agent-shared', 'recorded', { sessionId: 'native-shared' });
  const target = { hostId: 'local', providerId: 'recorded', nativeSessionId: created.payload.sessionId, title: 'Shared conversation' };
  const connections = new ConversationConnections(transport, url), drafts = new DraftStore(url);
  const directory = new SessionDirectoryClient(url);
  const attach = vi.spyOn(directory, 'attach').mockResolvedValue({ agentId: 'agent-shared', nativeSessionId: target.nativeSessionId });
  const workspace = { schemaVersion: 3 as const, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: 'first', selectedViewId: 'first',
    views: ['first', 'second'].map(id => createWindowView(id, target, 'primary')) };
  // Nothing beyond the screen stays live: a pane that leaves it is released at once.
  const budget = new LiveBudget({ recent: 0, graceMs: 0 });
  let show!: (views: ReadonlySet<string>) => void;
  function Harness() {
    const [shown, setShown] = useState<ReadonlySet<string>>(new Set(['first', 'second'])); show = setShown;
    const version = useSyncExternalStore(listener => budget.subscribe(listener), () => budget.version);
    const live = useMemo(() => liveConnections(budget), [version]);
    const retained = useCallback((_windowId: string, viewId: string) => budget.live(viewId), [version]);
    useWindowSessionRetention(connections, workspace, undefined, retained);
    return <WorkspaceReady.Provider value={true}><ConversationConnectionScope.Provider value={connections}>
      <LiveConnectionsContext.Provider value={live}>
        {workspace.views.map(view => <section key={view.id} data-view={view.id}><SessionConversation viewId={view.id} windowViewId={view.id}
          storageScope={url} baseUrl={url} target={target} hostLabel="Test Host" directoryFor={() => directory}
          compact={false} active={shown.has(view.id)} offline={false} transport={transport} draftStore={drafts} draftBinding={{ store: drafts, key: view.id }}
          familyRoot entries={[target]} onNavigate={async () => {}} /></section>)}
      </LiveConnectionsContext.Provider>
    </ConversationConnectionScope.Provider></WorkspaceReady.Provider>;
  }
  const container = await render(<Harness />);
  const pane = (id: string) => container.querySelector<HTMLElement>(`[data-view="${id}"]`)!;
  try {
    await vi.waitFor(() => expect(connections.find(target)?.client.getSessionState().connection).toBe('ready'));
    await vi.waitFor(() => expect(pane('first').textContent).toContain('Recorded history 1'));
    expect(container.querySelector('[aria-label="Disconnect session"], [aria-label="Connect session"]')).toBeNull();
    await act(async () => {
      const input = pane('first').querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
      setPromptText(input, 'Keep this draft'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => show(new Set(['second'])));
    // The other pane still shows the conversation, so it stays connected; the released pane keeps its history and draft.
    expect(connections.find(target)).toBeDefined();
    expect(budget.live('first')).toBe(false);
    expect(pane('first').textContent).toContain('Recorded history 1');
    expect(pane('first').textContent).not.toContain('Disconnected');
    expect(promptText(pane('first').querySelector<HTMLElement>('[data-testid="prompt-input"]')!)).toBe('Keep this draft');
    await act(async () => show(new Set()));
    await vi.waitFor(() => expect(connections.find(target)).toBeUndefined());
    const count = attach.mock.calls.length;
    await act(async () => show(new Set(['first'])));
    await vi.waitFor(() => expect(connections.find(target)?.client.getSessionState().connection).toBe('ready'));
    expect(attach).toHaveBeenCalledTimes(count + 1);
    expect(promptText(pane('first').querySelector<HTMLElement>('[data-testid="prompt-input"]')!)).toBe('Keep this draft');
  } finally { await unmount(container); connections.clear(); transport.dispose(); attach.mockRestore(); await server.close(); }
}, 15000);

it('releases a folded pane at once, without waiting for the grace period, and keeps the other pane live', async () => {
  const server = createRecordedValidationServer();
  const { url } = await server.http.listen();
  const transport = new HttpWebSocketTransport(url, { sessionChannels: true, webSocketFactory: address =>
    new WebSocket(address, { origin: process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175' }) as unknown as WebSocketLike });
  const first = await transport.createAgent('agent-first', 'recorded', { sessionId: 'native-first' });
  const second = await transport.createAgent('agent-second', 'recorded', { sessionId: 'native-second' });
  const targets = { first: { hostId: 'local', providerId: 'recorded', nativeSessionId: first.payload.sessionId, title: 'First' },
    second: { hostId: 'local', providerId: 'recorded', nativeSessionId: second.payload.sessionId, title: 'Second' } };
  const connections = new ConversationConnections(transport, url), drafts = new DraftStore(url);
  const directory = new SessionDirectoryClient(url);
  const attach = vi.spyOn(directory, 'attach').mockImplementation(async (_provider, nativeSessionId) =>
    ({ agentId: nativeSessionId === targets.first.nativeSessionId ? 'agent-first' : 'agent-second', nativeSessionId }));
  const budget = new LiveBudget({ recent: 4, graceMs: 60_000 });
  let fold!: (value: boolean) => void;
  function Harness() {
    const [folded, setFolded] = useState(false); fold = setFolded;
    const version = useSyncExternalStore(listener => budget.subscribe(listener), () => budget.version);
    const live = useMemo(() => liveConnections(budget), [version]);
    return <WorkspaceReady.Provider value={true}><ConversationConnectionScope.Provider value={connections}><LiveConnectionsContext.Provider value={live}>
      {(['first', 'second'] as const).map(id => <section key={id} data-view={id}><SessionConversation viewId={id} windowViewId={id} folded={id === 'first' && folded}
        storageScope={url} baseUrl={url} target={targets[id]} hostLabel="Test Host" directoryFor={() => directory}
        compact={false} active offline={false} transport={transport} draftStore={drafts} familyRoot entries={[targets[id]]} onNavigate={async () => {}} /></section>)}
    </LiveConnectionsContext.Provider></ConversationConnectionScope.Provider></WorkspaceReady.Provider>;
  }
  const container = await render(<Harness />);
  try {
    await vi.waitFor(() => expect(connections.find(targets.first)?.client.getSessionState().connection).toBe('ready'));
    await vi.waitFor(() => expect(connections.find(targets.second)?.client.getSessionState().connection).toBe('ready'));
    await act(async () => fold(true));
    expect(budget.live('first')).toBe(false);
    await vi.waitFor(() => expect(connections.find(targets.first)).toBeUndefined());
    expect(connections.find(targets.second)?.client.getSessionState().connection).toBe('ready');
    await act(async () => fold(false));
    await vi.waitFor(() => expect(connections.find(targets.first)?.client.getSessionState().connection).toBe('ready'));
  } finally { await unmount(container); connections.clear(); transport.dispose(); attach.mockRestore(); await server.close(); }
}, 15000);
