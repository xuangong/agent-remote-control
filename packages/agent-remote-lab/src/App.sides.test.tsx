import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { configureImageDraftPersistence } from '@orchardworks/agent-remote-web/browser';
import { App, type LabTransport } from './App.js';
import * as workspaceHooks from './hooks/useWindowWorkspace.js';
import { SessionDirectoryClient } from './directory-client.js';
import { ForkStore, referenceForkContext } from './session-forks.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

const useWindowWorkspace = workspaceHooks.useWindowWorkspace;
const scope = 'http://localhost/window-sides/';

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  configureImageDraftPersistence(() => true);
  localStorage.clear(); sessionStorage.clear();
});

it.each([false, true])('opens another Side of the same source beside the first instead of replacing it (narrow: %s)', async narrow => {
  configureImageDraftPersistence(() => false);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  if (narrow) vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === '(max-width: 1180px)', media, addEventListener() {}, removeEventListener() {} }));
  const source = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'source', title: 'Source' };
  const saved: WorkspaceWindow = { schemaVersion: 3, id: 'sides', revision: 0, title: 'Sides', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', source, 'primary')] };
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${saved.id}`, JSON.stringify(saved));
  history.replaceState(null, '', `/?window=${saved.id}`);
  const forks = new ForkStore(scope);
  for (const [nativeSessionId, title] of [['first-side', 'First question'], ['second-side', 'Second question']] as const) {
    const record = forks.prepare(referenceForkContext({ ...source, agentId: 'source' }), { sourceNativeSessionId: 'source', conversationKind: 'side' });
    forks.bind(record.id, { ...source, nativeSessionId, agentId: nativeSessionId, title });
    forks.markConfigured(record.id); forks.finishCreation(record.id);
  }
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_providerId, nativeSessionId) => ({ agentId: nativeSessionId, nativeSessionId }));
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  let workspace!: ReturnType<typeof useWindowWorkspace>;
  vi.spyOn(workspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWindowWorkspace(...args); return workspace; });
  const snapshot = (agentId: string): Awaited<ReturnType<LabTransport['fetchSnapshot']>> => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
    ...replicaState.agent!, id: agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId, connection: { state: 'connected' as const } } } });
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
    createAgent: async () => { throw new Error('Opening a Side must reuse its existing session.'); },
    resumeAgent: async () => { throw new Error('Opening a Side must reuse its existing session.'); },
    fetchSessionSuccessions: async () => ({ version: 1, successions: [], nextCursor: null }),
    fetchSnapshot: async agentId => snapshot(agentId),
    fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'timeline', agentId, epoch: `epoch-${agentId}`, direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect(agentId, listener) {
      queueMicrotask(() => listener.onOpen());
      const control = (requestId?: string) => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
        agentId, ...(requestId ? { requestId } : {}), revision: 'control', access: 'control', available: false, token: 'fixture-token',
      } });
      return { close() {}, send(message) {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
          if (message.observation === 'activity') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId, status: 'idle' } });
          else { control(); listener.onMessage(snapshot(agentId)); }
        } else if (message.type === 'session_control_request') control(message.payload.requestId);
        else if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
      } };
    },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  };
  const container = await render(<App baseUrl={scope} transport={transport} directory={new SessionDirectoryClient(scope)} />);
  await vi.waitFor(() => expect(workspace.window?.id).toBe(saved.id));
  if (narrow) await act(async () => { (container.querySelector('#lab-context .lab-rail-close') as HTMLButtonElement | null)?.click(); });
  let sourceConversation: HTMLElement | null = null;
  const sideEntry = (label: string) => {
    sourceConversation ??= container.querySelector<HTMLElement>('[data-view-id="main"] .lab-session-conversation-host');
    return [...sourceConversation?.querySelectorAll<HTMLButtonElement>('[aria-label="Forked sessions"] button') ?? []]
      .find(button => button.title.startsWith(`${label} ·`));
  };
  const attached = () => workspace.window!.views.filter(view => view.attachedTo === 'main').map(view => view.binding?.nativeSessionId);
  await vi.waitFor(() => expect(sideEntry('Side 2')).toBeDefined());
  await act(async () => sideEntry('Side 1')!.click());
  await vi.waitFor(() => expect(attached()).toEqual(['first-side']));
  await act(async () => { await workspace.operate({ type: 'view.select', viewId: 'main' }); });
  await act(async () => sideEntry('Side 2')!.click());
  await vi.waitFor(() => expect(attached()).toEqual(['first-side', 'second-side']));
  const second = workspace.window!.views.find(view => view.binding?.nativeSessionId === 'second-side')!;
  expect(workspace.window!.selectedViewId).toBe(second.id);
  await vi.waitFor(() => expect([...container.querySelectorAll('[data-primary-group-id="main"] .lab-session-family-pane')].map(pane => pane.getAttribute('aria-label')))
    .toEqual(['Source', 'First question', 'Second question']));
  expect(container.contains(sourceConversation)).toBe(true);
  expect(['Side 1', 'Side 2'].map(label => sideEntry(label)?.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
  const first = workspace.window!.views.find(view => view.binding?.nativeSessionId === 'first-side')!;
  if (narrow) {
    const path = container.querySelector<HTMLSelectElement>('select[aria-label="Side path"]')!;
    await vi.waitFor(() => expect([...path.options].map(option => option.textContent)).toEqual(['Root · Source', 'Side 1 · First question', 'Side 2 · Second question']));
    expect(path.selectedIndex).toBe(2);
    await act(async () => { path.selectedIndex = 1; path.dispatchEvent(new Event('change', { bubbles: true })); });
  } else await act(async () => sideEntry('Side 1')!.click());
  await vi.waitFor(() => expect(workspace.window!.selectedViewId).toBe(first.id));
  expect(attached()).toEqual(['first-side', 'second-side']);
  if (narrow) expect([...container.querySelectorAll<HTMLElement>('[data-primary-group-id="main"] .lab-session-family-pane')].filter(pane => !pane.hidden)
    .map(pane => pane.getAttribute('aria-label'))).toEqual(['First question']);
}, 15000);
