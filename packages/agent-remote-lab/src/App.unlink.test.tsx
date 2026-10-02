import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentSessionSetting } from '@orchardworks/agent-provider-sdk';
import { HttpWebSocketTransport, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { App } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import { ForkStore } from './session-forks.js';
import { createProtocolValidationServer } from './server.js';
import { createRecordedLabProvider } from './server/recorded.js';
import { replicaState } from './test/fixtures.js';
import { render, unmount } from './test/setup.js';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = performance.now() + 5000;
  for (;;) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    try { assertion(); return; }
    catch (error) { if (performance.now() >= deadline) throw error; }
  }
}

it('does not reopen a side unlinked during configuration, while still delivering its requested first message', async () => {
  const { provider } = createRecordedLabProvider({ capabilities: { sessionControl: 'shared' } });
  const setting: AgentSessionSetting = { id: 'model', category: 'model', label: 'Model', value: 'recorded-model',
    options: [{ value: 'recorded-model', label: 'Recorded' }], mutable: true, scope: 'session' };
  const create = provider.createSession.bind(provider);
  provider.createSession = async config => {
    const session = await create(config);
    const runtimeInfo = session.runtimeInfo.bind(session);
    session.runtimeInfo = async () => ({ ...await runtimeInfo(), settings: [setting] });
    return session;
  };
  const relay = createProtocolValidationServer({ providers: [provider], labOrigin: window.location.origin });
  const { url } = await relay.http.listen();
  const directory = new SessionDirectoryClient(url);
  const transport = new HttpWebSocketTransport(url, {
    webSocketFactory: address => new WebSocket(address, { origin: window.location.origin }) as unknown as WebSocketLike,
  });
  let view: HTMLDivElement | undefined;
  let releaseConfiguration!: () => void;
  const configuration = new Promise<void>(resolve => { releaseConfiguration = resolve; });
  try {
    const source = await directory.attach('recorded', 'recorded-welcome');
    const snapshot = await transport.fetchSnapshot(source.agentId);
    const fetchSnapshot = transport.fetchSnapshot.bind(transport);
    let configuring = false;
    vi.spyOn(transport, 'fetchSnapshot').mockImplementation(async (agentId, options) => {
      if (agentId !== source.agentId) { configuring = true; await configuration; }
      return fetchSnapshot(agentId, options);
    });
    view = await render(<App baseUrl={url} directory={directory} transport={transport}
      initialState={{ ...replicaState, agent: snapshot.payload }} initialSessionStatus="ready"
      actions={{ sendMessage: async () => { throw new Error('The slash command must not send to its source.'); } }} />);
    const sourceInput = view.querySelector<HTMLTextAreaElement>('.lab-primary-conversation [data-testid="prompt-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(sourceInput, '/side Finish this requested task');
      sourceInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => view!.querySelector<HTMLButtonElement>('.lab-primary-conversation [data-testid="prompt-submit"]')!.click());
    await waitFor(() => expect(configuring).toBe(true));
    const store = new ForkStore(url);
    const pending = store.all()[0]!;
    expect(pending.target).toBeDefined();
    expect(pending.configured).not.toBe(true);
    await act(async () => view!.querySelector<HTMLButtonElement>('.lab-fork-menu-trigger')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"].lab-fork-unlink')!.click());
    await waitFor(() => expect(store.get(pending.id).linked).toBe(false));
    expect(view.querySelector('.lab-fork-entries')).toBeNull();
    await act(async () => releaseConfiguration());
    await waitFor(() => {
      expect(store.get(pending.id)).toMatchObject({ configured: true, delivery: 'sent' });
      expect(store.get(pending.id).creationKey).toBeUndefined();
    });
    const history = await provider.readSessionHistory!(pending.target!.nativeSessionId, { limit: 100 });
    expect(history.entries.filter(entry => entry.role === 'user_message' && entry.text.includes('Finish this requested task'))).toHaveLength(1);
    expect(store.get(pending.id).linked).toBe(false);
    expect(view.querySelectorAll('.lab-side-conversation:not([hidden])')).toHaveLength(0);
    expect(view.querySelector<HTMLElement>('.lab-primary-conversation')!.hidden).toBe(false);
    expect(view.querySelector('.lab-primary-conversation [data-testid="prompt-input"]')).toBe(sourceInput);
  } finally {
    releaseConfiguration();
    if (view) await unmount(view);
    transport.dispose();
    await relay.close();
  }
}, 10000);
