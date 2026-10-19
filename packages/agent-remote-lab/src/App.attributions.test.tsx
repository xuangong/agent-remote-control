import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, createWindowView, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { RemoteTeamClient } from '@orchardworks/agent-remote-web/headless';
import { configureImageDraftPersistence } from '@orchardworks/agent-remote-web/browser';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import * as workspaceHooks from './hooks/useWindowWorkspace.js';
import { createWindowFeature } from './window-feature-views.js';
import { saveWorkspaceSnapshot } from './workspace-cache.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

const useWindowWorkspace = workspaceHooks.useWindowWorkspace;
const scope = 'http://localhost/session-attributions-app/';

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  configureImageDraftPersistence(() => true);
  localStorage.clear(); sessionStorage.clear();
});

async function settle(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 3000, interval: 10 });
}

async function fixture({ sourceOpen = true, offline = false, compact = false, hideTeam = false } = {}) {
  configureImageDraftPersistence(() => false);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: compact && media === '(max-width: 1180px)', media,
    addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Fixture route unavailable.' }, { status: 404 })));
  if (hideTeam) localStorage.setItem('agent-remote:team-view', 'false');
  const hostId = offline ? 'offline-host' : 'local';
  const session = (nativeSessionId: string, title: string) => ({ hostId, providerId: 'recorded', nativeSessionId, title });
  const team: Team = {
    id: 'release-team', operationId: 'create-team', revision: 1, title: 'Release validation', status: 'active',
    source: session('source', 'Original project'),
    members: [{ id: 'leader', hostId, providerId: 'recorded', nativeSessionId: 'leader', role: 'leader', name: 'Coordinator',
      responsibility: 'Coordinate delivery', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }],
    messages: [], createdAt: 1, updatedAt: 1,
  };
  const first: WorkspaceWindow = {
    schemaVersion: 3, id: 'relations', revision: 0, title: 'Relations', selectedPrimaryViewId: 'main', selectedViewId: 'leader-view',
    views: [createWindowView('main', session('different', 'Different project'), 'primary'),
      ...(sourceOpen ? [createWindowView('source-view', team.source)] : []),
      { ...createWindowView('leader-view', session('leader', 'Coordinator')),
        feature: createWindowFeature({ kind: 'team', id: team.id, role: 'leader', memberId: 'leader' }), bindingPolicy: 'managed' },
      createWindowView('other-view', session('other', 'Unrelated work'))],
  };
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${first.id}`, JSON.stringify(first));
  history.replaceState(null, '', `/?window=${first.id}`);
  vi.spyOn(RemoteTeamClient.prototype, 'list').mockResolvedValue([team]);
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_provider, nativeSessionId) => {
    if (offline) throw new Error('Host is offline');
    return { agentId: nativeSessionId, nativeSessionId };
  });
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  const snapshot = (agentId: string): Awaited<ReturnType<LabTransport['fetchSnapshot']>> => ({
    protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { ...replicaState.agent!, id: agentId,
      runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId, connection: { state: 'connected' } } },
  });
  if (offline) for (const view of first.views) if (view.binding) {
    saveWorkspaceSnapshot(scope, view.binding, { ...replicaState, agent: snapshot(view.binding.nativeSessionId).payload,
      timeline: { ...replicaState.timeline, hasOlder: false, nextSeq: 2, entries: [{ providerId: 'recorded',
        seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
        timestamp: '2026-10-16T00:00:00Z', item: { type: 'assistant_message', text: `Cached discussion for ${view.binding.title}.` } }] } });
  }
  const nativeConnections = vi.fn();
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
    createAgent: async () => { throw new Error('Attribution navigation must reuse native sessions.'); },
    resumeAgent: async () => { throw new Error('Attribution navigation must reuse native sessions.'); },
    fetchSnapshot: async agentId => snapshot(agentId),
    fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'timeline', agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect(agentId, listener) {
      nativeConnections(agentId);
      if (offline) return { send() {}, close() {} };
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
  let workspace!: ReturnType<typeof useWindowWorkspace>;
  vi.spyOn(workspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWindowWorkspace(...args); return workspace; });
  const container = await render(<App baseUrl={scope} transport={transport} directory={new SessionDirectoryClient(scope)}
    hostService={{ hosts: async () => ({ hosts: offline ? [{ id: hostId, name: 'Offline Mac', online: false,
      providers: [{ providerId: 'recorded', displayName: 'Recorded' }], teamManagement: true }] : [] }),
      pair: async () => { throw new Error('No pairing is needed.'); } }} />);
  if (compact) await act(async () => container.querySelector<HTMLButtonElement>('#lab-context .lab-rail-close')!.click());
  const leader = () => container.querySelector<HTMLElement>('[data-view-id="leader-view"]')!;
  await settle(() => {
    expect(workspace.window?.id).toBe(first.id);
    expect(leader()?.querySelector('[aria-label="Show session attributions"]')).not.toBeNull();
  });
  await act(async () => leader().querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!.click());
  const attribution = (label: string) => [...leader().querySelectorAll('tr')].find(row => row.querySelector('th')?.textContent === label)
    ?.querySelector<HTMLButtonElement>('td button');
  await settle(() => expect(attribution('Main')?.textContent).toContain('Original project'));
  return { container, first, team, read: () => workspace.window!, leader, attribution, attach, nativeConnections };
}

it('selects an already open attribution target without replacing the primary or unrelated views', async () => {
  const test = await fixture();
  const before = structuredClone(test.read());
  const source = test.container.querySelector('[data-view-id="source-view"] .lab-session-view');
  const leader = test.leader().querySelector('.lab-session-view');
  await act(async () => test.attribution('Main')!.click());
  await settle(() => expect(test.read().selectedViewId).toBe('source-view'));
  expect(test.read().selectedPrimaryViewId).toBe('main');
  expect(test.read().views).toEqual(before.views);
  expect(test.container.querySelector('[data-view-id="source-view"] .lab-session-view')).toBe(source);
  expect(test.leader().querySelector('.lab-session-view')).toBe(leader);
}, 10000);

it('opens an absent attribution target in a new dock while preserving the current main binding and existing docks', async () => {
  const test = await fixture({ sourceOpen: false });
  const before = structuredClone(test.read());
  await act(async () => test.attribution('Main')!.click());
  await settle(() => expect(test.read().views).toHaveLength(before.views.length + 1));
  expect(test.read().views.slice(0, before.views.length)).toEqual(before.views);
  const opened = test.read().views.at(-1)!;
  expect(opened).toMatchObject({ placement: 'dock', binding: { ...test.team.source } });
  expect(test.read().selectedViewId).toBe(opened.id);
  expect(test.read().selectedPrimaryViewId).toBe('main');
  expect(test.read().views[0]!.binding?.nativeSessionId).toBe('different');
}, 10000);

it('settles attribution navigation locally while the Window save is still pending', async () => {
  const test = await fixture({ sourceOpen: false });
  const before = structuredClone(test.read());
  let release: (() => Promise<void>) | undefined;
  let held = false;
  let saved = false;
  vi.stubGlobal('navigator', { locks: { request: (_name: string, commit: () => Promise<unknown>) => {
    if (held) return commit();
    held = true;
    return new Promise(resolve => { release = async () => { const result = await commit(); saved = true; resolve(result); }; });
  } } });
  try {
    await act(async () => test.attribution('Main')!.click());
    await settle(() => {
      expect(release).toBeTypeOf('function');
      expect(test.read().views).toHaveLength(before.views.length + 1);
    });
    const opened = test.read().views.at(-1)!;
    expect(opened.binding).toEqual(test.team.source);
    expect(test.read().selectedViewId).toBe(opened.id);
    expect(test.read().views.slice(0, before.views.length)).toEqual(before.views);
    expect(saved).toBe(false);
    await settle(() => expect(test.attribution('Main')?.disabled).toBe(false));
    expect(test.attribution('Main')?.closest('td')?.textContent).not.toContain('Opening');

    const localLayout = structuredClone(test.read());
    await act(async () => test.attribution('Main')!.click());
    await settle(() => expect(test.attribution('Main')?.disabled).toBe(false));
    expect(saved).toBe(false);
    expect(test.read().selectedViewId).toBe(opened.id);
    expect(test.read().views).toEqual(localLayout.views);
  } finally {
    if (release) await act(async () => { await release!(); });
  }
}, 10000);

it('reveals the Team management entry without changing the current Window layout or session bindings', async () => {
  const test = await fixture({ hideTeam: true });
  const before = structuredClone(test.read());
  expect(test.container.querySelector('section[aria-label="Teams"]')).toBeNull();
  await act(async () => test.attribution('Team')!.click());
  await settle(() => expect(test.container.querySelector('section[aria-label="Teams"]')).not.toBeNull());
  const row = test.container.querySelector<HTMLElement>(`[data-team-id="${test.team.id}"]`)!;
  expect(row.textContent).toContain('Release validation');
  expect(row.querySelector('.lab-session-row')).toBe(document.activeElement);
  expect(test.read()).toEqual(before);
}, 10000);

it('keeps recorded relationships navigable from an offline session and presents the cached target on a narrow screen', async () => {
  const test = await fixture({ offline: true, compact: true });
  const before = structuredClone(test.read());
  expect(test.leader().textContent).toContain('Original project');
  expect(test.attribution('Main')?.disabled).toBe(false);
  await act(async () => test.attribution('Main')!.click());
  await settle(() => {
    expect(test.read().selectedViewId).toBe('source-view');
    expect(test.container.querySelector('[data-view-id="source-view"]')?.closest('[hidden]')).toBeNull();
  });
  expect(test.read().views).toEqual(before.views);
  expect(test.read().views[0]?.binding?.nativeSessionId).toBe('different');
  expect(test.container.querySelector('[data-view-id="source-view"] .lab-session-view')?.textContent).toContain('Cached discussion for Original project.');
  expect(test.nativeConnections).not.toHaveBeenCalled();
}, 10000);
