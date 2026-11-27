import 'fake-indexeddb/auto';
import { act } from 'react';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { configureImageDraftPersistence } from '@orchardworks/agent-client-web/browser';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient } from './kernel/directory-client.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';
import { loadScreens } from './app/lazy-screens.js';

// Settings, the Trace and the Inspector are chunks the page warms when idle; a test opens them as a settled page would.
beforeAll(() => loadScreens());

const scope = 'http://localhost/trace-reveal/';

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  configureImageDraftPersistence(() => true);
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
});

// Both panes of the group hold an entry with the same key, as a Side does with the history it was forked from.
it('shows the entry opened from Trace in the one pane that shows the traced session, not in the Side beside it', async () => {
  configureImageDraftPersistence(() => false);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const source = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'source', title: 'Source' };
  const side = { ...source, nativeSessionId: 'side', title: 'Side' };
  const saved: WorkspaceWindow = { schemaVersion: 3, id: 'trace', revision: 0, title: 'Trace', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', source, 'primary'), { ...createWindowView('side-view', side, 'attached'), attachedTo: 'main' }] };
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${saved.id}`, JSON.stringify(saved));
  history.replaceState(null, '', `/?window=${saved.id}`);
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_providerId, nativeSessionId) => ({ agentId: nativeSessionId, nativeSessionId }));
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  const snapshot = (agentId: string): Awaited<ReturnType<LabTransport['fetchSnapshot']>> => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
    ...replicaState.agent!, id: agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId, connection: { state: 'connected' as const } } } });
  const entries = [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-18T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
    item: { type: 'assistant_message' as const, text: 'The cobalt orchard answer.' } }];
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
    createAgent: async () => { throw new Error('Opening a pane must reuse its existing session.'); },
    resumeAgent: async () => { throw new Error('Opening a pane must reuse its existing session.'); },
    fetchSessionSuccessions: async () => ({ version: 1, successions: [], nextCursor: null }),
    fetchSnapshot: async agentId => snapshot(agentId),
    fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'timeline', agentId, epoch: 'epoch-1', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null, entries, hasOlder: false, hasNewer: false, error: null,
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
  const traceTab = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'Trace')!;
  await vi.waitFor(() => expect(container.querySelectorAll('.agent-timeline-entry')).toHaveLength(2));
  await act(async () => traceTab().click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-trace-entry-key]')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Show in Conversation')!.click());
  const inspected = [...container.querySelectorAll<HTMLElement>('[data-inspected="true"]')];
  expect(inspected.map(entry => entry.closest('[data-view-id]')?.getAttribute('data-view-id'))).toEqual(['main']);
});
