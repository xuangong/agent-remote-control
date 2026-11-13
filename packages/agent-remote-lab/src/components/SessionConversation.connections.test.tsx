import 'fake-indexeddb/auto';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { HttpWebSocketTransport, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { DraftStore } from '../draft-store.js';
import { WorkspaceReady } from '../workspace-access.js';
import { useWindowConnections, WindowConnectionsContext } from '../hooks/useWindowConnections.js';
import { useWindowSessionRetention } from '../hooks/useWindowSessionRetention.js';
import { createRecordedValidationServer } from '../server/recorded.js';
import { render, unmount, setPromptText, promptText } from '../test/setup.js';
import { SessionConversation } from './SessionConversation.js';

it('keeps history and drafts while disconnecting each view, then reattaches on demand', async () => {
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
  function Harness() {
    const preferences = useWindowConnections(url);
    useWindowSessionRetention(connections, workspace, undefined, preferences.enabled);
    return <WorkspaceReady.Provider value={true}><ConversationConnectionScope.Provider value={connections}>
      <WindowConnectionsContext.Provider value={{ enabled: id => preferences.enabled('window', id), setEnabled: (id, value) => preferences.setEnabled('window', id, value) }}>
        {workspace.views.map(view => <section key={view.id} data-view={view.id}><SessionConversation viewId={view.id} windowViewId={view.id}
          storageScope={url} baseUrl={url} target={target} hostLabel="Test Host" directoryFor={() => directory}
          compact={false} active offline={false} transport={transport} draftStore={drafts} draftBinding={{ store: drafts, key: view.id }}
          familyRoot entries={[target]} onNavigate={async () => {}} /></section>)}
      </WindowConnectionsContext.Provider>
    </ConversationConnectionScope.Provider></WorkspaceReady.Provider>;
  }
  let container = await render(<Harness />);
  const pane = (id: string) => container.querySelector<HTMLElement>(`[data-view="${id}"]`)!;
  const click = async (id: string, label: string) => act(async () => pane(id).querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  try {
    await vi.waitFor(() => expect(connections.find(target)?.client.getSessionState().connection).toBe('ready'));
    await vi.waitFor(() => expect(pane('first').textContent).toContain('Recorded history 1'));
    expect(container.querySelectorAll('[aria-label="Disconnect session"]')).toHaveLength(2);
    await act(async () => {
      const input = pane('first').querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
      setPromptText(input, 'Keep this draft'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('first', 'Disconnect session');
    expect(connections.find(target)).toBeDefined();
    expect(pane('first').textContent).toContain('Showing saved history');
    expect(pane('first').textContent).toContain('Recorded history 1');
    expect(promptText(pane('first').querySelector<HTMLElement>('[data-testid="prompt-input"]')!)).toBe('Keep this draft');
    expect(pane('first').querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
    await click('second', 'Disconnect session');
    await vi.waitFor(() => expect(connections.find(target)).toBeUndefined());
    const count = attach.mock.calls.length;
    await unmount(container); container = await render(<Harness />);
    expect(container.querySelectorAll('[aria-label="Connect session"]')).toHaveLength(2);
    expect(attach).toHaveBeenCalledTimes(count);
    expect(connections.find(target)).toBeUndefined();
    await click('first', 'Connect session');
    await vi.waitFor(() => expect(connections.find(target)?.client.getSessionState().connection).toBe('ready'));
    expect(pane('second').querySelector('[aria-label="Connect session"]')).not.toBeNull();
    expect(attach).toHaveBeenCalledTimes(count + 1);
  } finally { await unmount(container); connections.clear(); transport.dispose(); attach.mockRestore(); await server.close(); }
}, 15000);
