import 'fake-indexeddb/auto';
import { act, type ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, applyWindowOperation, createWindowView, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { configureImageDraftPersistence } from '@orchardworks/agent-remote-web/browser';
import { App, type LabTransport } from './App.js';
import * as teamMenu from './components/TeamMenu.js';
import * as workspaceHooks from './hooks/useWindowWorkspace.js';
import * as successionHooks from './hooks/useSessionSuccession.js';
import * as trackingMenu from './components/SessionTrackingMenu.js';
import { SessionDirectoryClient } from './directory-client.js';
import { SessionStarsClient } from './session-stars-client.js';
import { compositionMetadataKey, createAskOwner, createCompositionDocument, createCompositionSlot } from './session-composition.js';
import { saveTrackedSessions } from './tracking-state.js';
import { sessionKey } from './session-tree.js';
import { createWindowFeature, parseWindowFeature } from './window-feature-views.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

const useWindowWorkspace = workspaceHooks.useWindowWorkspace;
const useSessionSuccession = successionHooks.useSessionSuccession;
const scope = 'http://localhost/window-actions/';
const team: Team = {
  id: 'team', operationId: 'create-team', revision: 1, title: 'Review', status: 'active',
  source: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'source', title: 'Source' },
  members: [
    { id: 'leader', hostId: 'local', providerId: 'recorded', nativeSessionId: 'leader-session', role: 'leader', name: 'Leader', responsibility: 'Coordinate', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 },
    { id: 'worker', hostId: 'local', providerId: 'recorded', nativeSessionId: 'worker-session', role: 'member', name: 'Worker', responsibility: 'Review', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 },
  ],
  messages: [], createdAt: 1, updatedAt: 1,
};

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  configureImageDraftPersistence(() => true);
  localStorage.clear(); sessionStorage.clear();
});

async function fixture(historyPlacement?: 'dock' | 'float', hiddenAskSource?: 'main' | 'ordinary-view' | 'side-view', askVisible = false) {
  configureImageDraftPersistence(() => false);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const first: WorkspaceWindow = {
    schemaVersion: 2, id: 'first', revision: 0, title: 'First', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', undefined, 'primary'), {
      ...createWindowView('leader-view', { hostId: 'local', providerId: 'recorded', nativeSessionId: 'leader-session', title: 'Leader' }),
      feature: createWindowFeature({ kind: 'team', id: team.id, role: 'leader', memberId: 'leader' }), bindingPolicy: 'managed',
    }],
  };
  if (historyPlacement) {
    first.views[0]!.binding = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'primary-session', title: 'Primary' };
    first.views[1] = createWindowView('ordinary-view', { hostId: 'local', providerId: 'recorded', nativeSessionId: 'current-session', title: 'Current' }, historyPlacement);
    first.selectedViewId = 'ordinary-view';
    vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation(options => {
      const succession = useSessionSuccession(options);
      return { ...succession, historyNavigationFor: source => {
        if (!['current-session', 'past-session'].includes(source.nativeSessionId)) return;
        const current = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'current-session', title: 'Current' };
        const predecessor = { ...current, nativeSessionId: 'past-session', title: 'Past' };
        const history = source.nativeSessionId === predecessor.nativeSessionId;
        return { roleKey: 'verified-role', history, session: history ? predecessor : current, current,
          ...(history ? {} : { predecessor }), ancestors: [] };
      } };
    });
  }
  if (hiddenAskSource) {
    vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === '(max-width: 1180px)', media, addEventListener() {}, removeEventListener() {} }));
    if (hiddenAskSource === 'side-view') first.views.splice(1, 0, { ...createWindowView('side-view', {
      hostId: 'local', providerId: 'recorded', nativeSessionId: 'side-session', title: 'Side',
    }, 'attached'), attachedTo: 'main' });
    const source = first.views.find(view => view.id === hiddenAskSource)!;
    first.views.push({ ...createWindowView('selected-ask', undefined, 'float'), closeWith: source.id,
      bindingPolicy: 'managed', feature: createWindowFeature({ kind: 'ask', id: 'saved-ask', source: source.binding! }) });
    first.selectedViewId = 'selected-ask';
    localStorage.setItem('agent-remote:ask-view', String(askVisible));
  }
  const second: WorkspaceWindow = { schemaVersion: 2, id: 'second', revision: 0, title: 'Second', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] };
  for (const window of [first, second]) localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${window.id}`, JSON.stringify(window));
  history.replaceState(null, '', '/?window=first');
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_providerId, nativeSessionId) => ({ agentId: nativeSessionId, nativeSessionId }));
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  let workspace!: ReturnType<typeof useWindowWorkspace>;
  let menu!: ComponentProps<typeof teamMenu.TeamMenu>;
  vi.spyOn(workspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWindowWorkspace(...args); return workspace; });
  vi.spyOn(teamMenu, 'TeamMenu').mockImplementation(props => { menu = props; return null; });
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
    createAgent: async () => { throw new Error('Team gathering must reuse its existing sessions.'); },
    resumeAgent: async () => { throw new Error('Team gathering must reuse its existing sessions.'); },
    fetchSnapshot: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { ...replicaState.agent!, id: agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId } } }),
    fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'timeline', agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect: () => ({ send() {}, close() {} }),
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  };
  const container = await render(<App baseUrl={scope} transport={transport} directory={historyPlacement ? new SessionDirectoryClient(scope) : undefined} />);
  await vi.waitFor(() => expect(workspace.window?.id).toBe(first.id));
  return { read: () => workspace, menu: () => menu, first, second, container };
}

it('gathers Team members locally before saving and keeps them out of a subsequently selected Window', async () => {
  const test = await fixture();
  let release!: () => Promise<void>;
  let held = false;
  vi.stubGlobal('navigator', { locks: { request: (_name: string, commit: () => Promise<unknown>) => {
    if (held) return commit();
    held = true;
    return new Promise(resolve => { release = async () => { resolve(await commit()); }; });
  } } });
  let pending!: Promise<boolean>;
  await act(async () => { pending = test.menu().onOpen(team, 'first/main'); void pending.catch(() => {}); });
  expect(test.read().window!.views.filter(view => parseWindowFeature(view.feature)?.kind === 'team')).toHaveLength(2);
  expect(await pending).toBe(true);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await act(async () => { await test.read().open('second'); });
  expect(test.read().window?.id).toBe('second');
  await act(async () => { await release(); await pending; });
  expect(test.read().window!.views.filter(view => parseWindowFeature(view.feature)?.kind === 'team')).toHaveLength(0);
  expect(test.read().window).toEqual(test.second);
  const storedFirst = JSON.parse(localStorage.getItem(`agent-remote:recovery:${scope}:shared-window:first`)!);
  expect(storedFirst.selectedViewId).toBe('leader-view');
  expect(storedFirst.views).toHaveLength(3);
}, 10000);

it('restores source families behind the visible selected Ask', async () => {
  const test = await fixture('dock', 'side-view', true);
  await act(async () => { (test.container.querySelector('#lab-context .lab-rail-close') as HTMLButtonElement | null)?.click(); });
  await vi.waitFor(() => {
    expect(test.container.querySelector('.lab-primary-conversation .lab-session-view')).not.toBeNull();
    expect(test.container.querySelector('.lab-side-conversation .lab-session-view')).not.toBeNull();
  });
  expect(test.read().window?.selectedViewId).toBe('selected-ask');
}, 10000);

it.each(['main', 'ordinary-view', 'side-view'] as const)('shows the hidden Ask source %s in compact layout without changing shared selection', async sourceViewId => {
  const test = await fixture('dock', sourceViewId);
  await act(async () => { (test.container.querySelector('#lab-context .lab-rail-close') as HTMLButtonElement | null)?.click(); });
  await vi.waitFor(() => {
    const source = test.container.querySelector(sourceViewId === 'main' ? '[data-primary-group-id="main"]'
      : sourceViewId === 'side-view' ? '.lab-side-conversation' : '[data-view-id="ordinary-view"]');
    expect(source).not.toBeNull();
    expect(source?.closest('[hidden]')).toBeNull();
    expect(source?.querySelector('.lab-session-view')).not.toBeNull();
  });
  expect(test.container.querySelector('[role="dialog"][aria-label="Ask"]')).toBeNull();
  expect(test.menu().sourceViewId).toBe(`first/${sourceViewId}`);
  expect(test.menu().source?.nativeSessionId).toBe(test.first.views.find(view => view.id === sourceViewId)?.binding?.nativeSessionId);
  expect(test.menu().currentSession?.nativeSessionId).toBe(test.menu().source?.nativeSessionId);
  expect(test.read().window?.selectedViewId).toBe('selected-ask');
  expect(test.read().window?.views.find(view => view.id === 'selected-ask')?.collapsed).toBe(false);
}, 10000);

it.each(['dock', 'float'] as const)('opens handoff history and returns to current in the same ordinary %s', async placement => {
  const test = await fixture(placement);
  const primary = structuredClone(test.read().window!.views[0]!);
  const target = () => test.read().window!.views.find(view => view.id === 'ordinary-view')!;
  const link = (label: string) => [...test.container.querySelectorAll<HTMLAnchorElement>('[data-view-id="ordinary-view"] .lab-succession-history a')]
    .find(item => item.textContent === label);
  await vi.waitFor(() => expect(link('Past')).toBeDefined());
  await act(async () => { link('Past')!.click(); });
  await vi.waitFor(() => expect(target().binding).toMatchObject({ nativeSessionId: 'past-session', sessionIntent: 'history' }));
  expect(target().placement).toBe(placement);
  expect(test.read().window?.views[0]).toEqual(primary);
  expect(test.read().window?.selectedPrimaryViewId).toBe('main');
  expect(test.read().window?.selectedViewId).toBe('ordinary-view');
  await vi.waitFor(() => expect(link('Return to current')).toBeDefined());
  await act(async () => { link('Return to current')!.click(); });
  await vi.waitFor(() => expect(target().binding?.nativeSessionId).toBe('current-session'));
  expect(target().binding?.sessionIntent).toBeUndefined();
  expect(test.read().window?.views[0]).toEqual(primary);
  expect(test.read().window?.views).toHaveLength(2);
  expect(test.container.querySelector('.lab-succession-history-error')).toBeNull();
}, 10000);

it('gathers missing Team members after same-Window leader selection clones its feature', async () => {
  const test = await fixture();
  const before = test.read().window!.views.find(view => view.id === 'leader-view')!.feature;
  await act(async () => { expect(await test.menu().onOpen(team, 'first/main')).toBe(true); });
  await vi.waitFor(() => expect(test.read().window?.views).toHaveLength(3));
  const current = test.read().window!;
  expect(current.id).toBe('first');
  expect(current.selectedViewId).toBe('leader-view');
  const leader = current.views.find(view => view.id === 'leader-view')!;
  expect(leader.feature).not.toBe(before);
  expect(leader.feature).toEqual(before);
  const members = current.views.filter(view => parseWindowFeature(view.feature)?.kind === 'team');
  expect(members).toHaveLength(2);
  expect(members.find(view => parseWindowFeature(view.feature)?.kind === 'team' && view.id !== leader.id))
    .toMatchObject({ binding: { nativeSessionId: 'worker-session' }, bindingPolicy: 'managed', closeWith: leader.id,
      feature: createWindowFeature({ kind: 'team', id: team.id, role: 'member', memberId: 'worker' }) });
}, 10000);

async function settleTrackedPrimary(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {});
    check();
  }, { timeout: 3000, interval: 20 });
}

async function trackedPrimaryFixture(staleAgent = false) {
  configureImageDraftPersistence(() => false);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.setItem('agent-remote:track-view', 'true');
  const session = (id: string) => ({ hostId: 'local', providerId: 'recorded', nativeSessionId: id, title: `Session ${id}` });
  const target = { ...session('D'), starredAt: 1 };
  const slots = [createCompositionSlot('original-slot', session('A'), scope),
    createCompositionSlot('tracked-slot', { ...target, ...(staleAgent ? { agentId: 'stale-D' } : {}) }, scope),
    createCompositionSlot('tracked-side-slot', session('S'), scope)];
  const composition = createCompositionDocument(scope, slots);
  composition.asks = slots.map(slot => createAskOwner(slot, scope));
  composition.tracks = [{ entryId: sessionKey(target), slotId: 'tracked-slot', view: {
    primarySlot: 'tracked-slot', selections: { 'tracked-slot': 'tracked-side-slot' }, focus: 'tracked-side-slot', anchor: 'tracked-slot',
  } }];
  sessionStorage.setItem(compositionMetadataKey(scope), JSON.stringify(composition));
  saveTrackedSessions(scope, [target]);
  let document: WorkspaceWindow = { schemaVersion: 2, id: 'tracked-primary', title: 'Tracked primary', revision: 0,
    selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', session('A'), 'primary')] };
  history.replaceState(null, '', '/?window=tracked-primary');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/changes')) return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(init?.signal?.reason);
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    });
    if (url.pathname.endsWith('/operations') && init?.method === 'POST') {
      const mutation = JSON.parse(String(init.body));
      document = applyWindowOperation(document, mutation.operation);
      return Response.json({ window: document, result: { operationId: mutation.operationId, status: 'committed', revision: document.revision,
        committedAt: Date.now(), expiresAt: Date.now() + 86400000 } });
    }
    if (url.pathname.endsWith('/windows')) return Response.json({ windows: [document] });
    if (url.pathname.endsWith('/windows/tracked-primary')) return Response.json({ window: document });
    return Response.json({ error: 'Fixture route unavailable.' }, { status: 404 });
  }));
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockResolvedValue({ revision: 0, folders: [], stars: [
    { ...target, favoriteId: 'favorite-D', folderId: null, order: 0, available: true, online: true },
  ] });
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_provider, id) => ({ agentId: `agent-${id}`, nativeSessionId: id }));
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  let workspace!: ReturnType<typeof useWindowWorkspace>, succession!: ReturnType<typeof useSessionSuccession>;
  let menu!: ComponentProps<typeof trackingMenu.SessionTrackingMenu>;
  const confirmed: string[] = [], contentConnections: string[] = [];
  vi.spyOn(workspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWindowWorkspace(...args); return workspace; });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation(options => {
    succession = useSessionSuccession({ ...options, confirmed: session => { confirmed.push(session.nativeSessionId); options.confirmed(session); } });
    return succession;
  });
  const renderTrackingMenu = trackingMenu.SessionTrackingMenu;
  vi.spyOn(trackingMenu, 'SessionTrackingMenu').mockImplementation(props => { menu = props; return renderTrackingMenu(props); });
  let releaseTimeline!: () => void, timelineRequested = false;
  const timelineGate = new Promise<void>(resolve => { releaseTimeline = resolve; });
  const snapshot = (agentId: string): Awaited<ReturnType<LabTransport['fetchSnapshot']>> => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
    ...replicaState.agent!, id: agentId, providerId: 'recorded', runtimeInfo: { ...replicaState.agent!.runtimeInfo,
      providerId: 'recorded', sessionId: agentId.replace(/^(agent|stale)-/, ''), connection: { state: 'connected' as const } },
  } });
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
    createAgent: async () => { throw new Error('Track must reuse an existing session.'); },
    resumeAgent: async () => { throw new Error('Track must reuse an existing session.'); },
    fetchSessionSuccessions: async () => ({ version: 1, successions: [], nextCursor: null }),
    fetchSnapshot: async agentId => snapshot(agentId),
    fetchTimeline: async agentId => {
      if (agentId === 'agent-D' && !staleAgent) { timelineRequested = true; await timelineGate; }
      return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
        requestId: 'timeline', agentId, epoch: `epoch-${agentId}`, direction: 'tail', reset: false, staleCursor: false, gap: false,
        window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
      } };
    },
    connect(agentId, listener) {
      queueMicrotask(() => listener.onOpen());
      const control = (requestId?: string) => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
        agentId, ...(requestId ? { requestId } : {}), revision: 'control', access: 'control', available: false, token: 'fixture-token',
      } });
      return { close() {}, send(message) {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
          if (message.observation === 'activity') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId, status: 'idle' } });
          else { contentConnections.push(agentId); control(); listener.onMessage(snapshot(agentId)); }
        } else if (message.type === 'session_control_request') control(message.payload.requestId);
        else if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
      } };
    },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  };
  await render(<App baseUrl={scope} userScoped transport={transport} directory={new SessionDirectoryClient(scope)} />);
  await settleTrackedPrimary(() => { expect(workspace.window?.id).toBe('tracked-primary'); expect(confirmed).toContain('A'); expect(menu).toBeDefined(); });
  return { target, workspace: () => workspace, succession: () => succession, confirmed, contentConnections,
    timelineRequested: () => timelineRequested, releaseTimeline, open: () => menu.onOpen(target) };
}

it('restores a saved primary Track side after native confirmation finishes later than the Window binding', async () => {
  const test = await trackedPrimaryFixture();
  try {
    await act(async () => test.open());
    await settleTrackedPrimary(() => { expect(test.timelineRequested()).toBe(true); expect(test.workspace().window?.views[0]?.binding?.nativeSessionId).toBe('D'); });
    expect(test.confirmed).not.toContain('D');
    expect(test.workspace().window?.views).toHaveLength(1);
    await act(async () => test.releaseTimeline());
    await settleTrackedPrimary(() => expect(test.confirmed).toContain('D'));
    await settleTrackedPrimary(() => expect(test.workspace().window?.views.find(view => view.attachedTo === 'main')?.binding?.nativeSessionId).toBe('S'));
    const side = test.workspace().window!.views.find(view => view.attachedTo === 'main')!;
    expect(test.workspace().window?.selectedViewId).toBe(side.id);
    expect(test.succession().document.windowBindings?.find(binding => binding.viewId === 'main' && binding.slotId === 'tracked-slot')).toBeDefined();
  } finally { test.releaseTimeline(); }
}, 10000);

it('resolves a shared primary Track from its live identity instead of a saved runtime agentId', async () => {
  const test = await trackedPrimaryFixture(true);
  expect(test.succession().document.slots.find(slot => slot.id === 'tracked-slot')?.metadata?.agentId).toBe('stale-D');
  await act(async () => test.open());
  await settleTrackedPrimary(() => expect(test.confirmed).toContain('D'));
  expect(test.contentConnections).not.toContain('stale-D');
  expect(test.succession().binding?.session.agentId).toBe('agent-D');
  expect(test.workspace().window?.views[0]?.binding?.nativeSessionId).toBe('D');
}, 10000);
