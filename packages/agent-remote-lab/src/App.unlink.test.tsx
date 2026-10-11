import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentSessionSetting } from '@orchardworks/agent-provider-sdk';
import { HttpWebSocketTransport, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { sessionKey } from './session-tree.js';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient, type OpenedSession } from './directory-client.js';
import { ForkStore, referenceForkContext } from './session-forks.js';
import { createProtocolValidationServer } from './server.js';
import { createRecordedLabProvider } from './server/recorded.js';
import { replicaState } from './test/fixtures.js';
import { render, unmount, setPromptText, promptText } from './test/setup.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); });

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
      setPromptText(sourceInput, '/side Finish this requested task');
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


it.each([false, true])('opens a pending unlink under current B and Back clears B selection without navigating to fixed A (local delivery: %s)', async localDelivery => {
  const baseUrl = 'http://localhost/u/pending-side-navigation/';
  const original: OpenedSession = { hostId: 'host', providerId: 'pA', nativeSessionId: 'A', agentId: 'A-agent', title: 'Fixed A' };
  const current: OpenedSession = { ...original, providerId: 'pB', nativeSessionId: 'B', agentId: 'B-agent', title: 'Current B' };
  const side: OpenedSession = { ...original, nativeSessionId: 'S', agentId: 'S-agent', title: 'Pending Side' };
  const origin = { controllerId: 'controller', providerId: 'pA', nativeSessionId: 'A' };
  localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([current]));
  window.history.replaceState(null, '', '/?host=host&provider=pB&session=B&agent=B-agent');
  const local = new ForkStore(baseUrl);
  const localRecord = localDelivery ? local.prepare(referenceForkContext(original), { sourceNativeSessionId: 'A' }) : undefined;
  if (localRecord) { local.bind(localRecord.id, side); local.markConfigured(localRecord.id); }
  const projection = {
    id: localRecord?.id ?? 'relation', kind: 'side', createdAt: '2026-10-10T00:00:00.000Z', source: original, target: side, nativeSourceRef: origin,
    sourceBinding: { kind: 'fixed', source: origin }, navigationSource: current, hostLocator: { hostId: 'host', controllerId: 'controller' },
    linked: false, revision: 1, roleRevision: 2, operation: { operationId: 'pending-edit', phase: 'metadata_committed' },
  };
  const requests: Array<{ providerId: string; nativeSessionId: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/session-relations')) return Response.json({ relations: [projection] });
    if (path.endsWith('/attach')) {
      const value = JSON.parse(String(init?.body));
      requests.push(value);
      return Response.json({ agentId: value.nativeSessionId + '-agent', nativeSessionId: value.nativeSessionId });
    }
    if (path.endsWith('/catalog')) return Response.json({ items: [], hasMore: false, revision: '1' });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    return new Response(null, { status: 404 });
  };
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  const snapshot = (session: OpenedSession) => ({ ...replicaState.agent!, id: session.agentId, providerId: session.providerId,
    persistence: { providerId: session.providerId, sessionId: session.nativeSessionId, opaque: session.nativeSessionId },
    runtimeInfo: { providerId: session.providerId, sessionId: session.nativeSessionId, status: 'idle' as const } });
  const snapshots = { 'B-agent': snapshot(current), 'S-agent': snapshot(side), 'A-agent': snapshot(original) };
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'pA', displayName: 'A' }, { providerId: 'pB', displayName: 'B' }],
    createAgent: async () => { throw new Error('Unexpected creation'); },
    resumeAgent: async () => { throw new Error('Unexpected resume'); },
    fetchSnapshot: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshots[agentId as keyof typeof snapshots] }),
    fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'page', agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect: (agentId, listener) => {
      queueMicrotask(() => {
        listener.onOpen();
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshots[agentId as keyof typeof snapshots] });
      });
      return { close() {}, send(message) {
        if (message.type === 'session_control_request') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION,
          type: 'session_control', payload: { agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } }));
        if (message.type === 'timeline_subscription') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION,
          type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } }));
      } };
    },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  };
  const directory = new SessionDirectoryClient(baseUrl, fetcher, 'host');
  const container = await render(<App baseUrl={baseUrl} userScoped directory={directory} transport={transport}
    hostService={{ hosts: async () => ({ hosts: [{ id: 'host', name: 'Host', online: true,
      providers: [{ providerId: 'pA', displayName: 'A' }, { providerId: 'pB', displayName: 'B' }] }] }),
      pair: async () => { throw new Error('Unexpected pair'); } }}
    initialState={{ ...replicaState, agent: snapshots['B-agent'] }} initialSessionStatus="ready" actions={{ sendMessage: async () => {} }} />);
  try {
    await waitFor(() => expect(container.querySelector('.lab-fork-entries')).not.toBeNull());
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-fork-entry > button')!.click());
    await waitFor(() => expect(container.querySelectorAll('.lab-side-conversation:not([hidden])')).toHaveLength(1));
    expect(new URL(window.location.href).searchParams.get('session')).toBe('S');
    expect(container.querySelector('.lab-side-conversation .lab-fork-reference summary')?.getAttribute('title')).toBe('Context from A');
    expect(container.querySelector('.lab-side-conversation .lab-fork-reference code')?.textContent).toBe('A');
    expect(container.querySelector('.lab-primary-conversation .lab-fork-entry > button')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close side conversation, back to source"]')!.click());
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('session')).toBe('B'));
    expect(container.querySelectorAll('.lab-side-conversation:not([hidden])')).toHaveLength(0);
    expect(container.querySelector('.lab-fork-entry > button')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('.lab-primary-conversation .lab-fork-entries')).not.toBeNull();
    expect(requests).toEqual([{ providerId: 'pA', nativeSessionId: 'S' }]);
    expect(sessionKey(projection.source)).toBe(sessionKey(original));
    expect(projection.nativeSourceRef).toEqual(origin);
  } finally { await unmount(container); }
});
