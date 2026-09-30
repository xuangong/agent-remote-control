import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteTransportListener } from '@orchardworks/agent-remote-web';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import { SessionStarsClient, type SessionStar } from './session-stars-client.js';
import { readTrackedSessions, saveTrackedSessions } from './tracking-state.js';
import { ForkStore, referenceForkContext } from './session-forks.js';
import { replicaState } from './test/fixtures.js';
import { render } from './test/setup.js';
import { WorkspaceReady } from './workspace-access.js';

const baseUrl = 'http://localhost/u/alice/';
const star: SessionStar = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'tracked', title: 'Tracked research', starredAt: 1 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, '', '/'); });

async function fixture(target: SessionStar, activityReady = true, other?: SessionStar, savedFavorites?: SessionStar[], navigation?: { compact: boolean }, initiallyAuthorized = true) {
  if (navigation) vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: navigation.compact && query.includes('max-width: 1180px'), media: query, addEventListener() {}, removeEventListener() {} })));
  if (navigation) vi.spyOn(SessionDirectoryClient.prototype, 'attachChild').mockImplementation(async (_provider, _parent, id) => ({ agentId: id + '-agent', nativeSessionId: id }));
  saveTrackedSessions(baseUrl, [target, ...(other ? [other] : [])]);
  // Remembered runtime IDs are not evidence of a live binding.
  localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ ...target, agentId: 'stale-agent' }]));
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockResolvedValue({revision:0,folders:[],stars:(savedFavorites ?? [target, ...(other ? [other] : [])]).map((item, order) => ({ ...item, favoriteId: item.nativeSessionId, folderId: null, order, available: true, online: true }))});
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  const attach = vi.spyOn(SessionDirectoryClient.prototype, target.parentNativeSessionId ? 'attachChild' : 'attach').mockImplementation(async (_provider: string, id: string) => ({ agentId: other && id === other.nativeSessionId ? 'other-agent' : id === 'side' ? 'side-agent' : 'live-agent' }));
  let activity!: RemoteTransportListener;
  const contentConnections: string[] = [];
  const activityClosed = vi.fn();
  const contentClosed = vi.fn();
  const contentListeners = new Map<string, RemoteTransportListener>();
  const activityListeners = new Map<string, RemoteTransportListener>();
  const snapshot = { protocolVersion: '1.6.0' as const, type: 'agent_snapshot' as const,
    payload: { ...replicaState.agent!, id: 'live-agent', providerId: target.providerId,
      runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: target.providerId, sessionId: target.nativeSessionId, ...(navigation ? { childSessions: [{ nativeSessionId: 'child', title: 'Tracked child', status: 'idle' as const, observation: 'live' as const, createdAt: '2026-09-20T00:00:00Z' }] } : {}) } } };
  const snapshotFor = (agentId: string) => {
    const sessionId = agentId === 'other-agent' ? other!.nativeSessionId : agentId === 'child-agent' ? 'child' : agentId === 'grandchild-agent' ? 'grandchild' : agentId === 'side-agent' ? 'side' : target.nativeSessionId;
    const childSessions = agentId === 'live-agent' ? snapshot.payload.runtimeInfo.childSessions : agentId === 'child-agent' ? [{ nativeSessionId: 'grandchild', title: 'Nested child', status: 'idle' as const, observation: 'live' as const, createdAt: '2026-09-20T00:00:00Z' }] : [];
    return { ...snapshot, payload: { ...snapshot.payload, id: agentId, runtimeInfo: { ...snapshot.payload.runtimeInfo, sessionId, childSessions } } };
  };
  const fetchTimeline = vi.fn<LabTransport['fetchTimeline']>(async agentId => ({
    protocolVersion: '1.6.0', type: 'timeline_page', payload: {
      requestId: 'history', agentId, direction: 'tail', epoch: 'tracked-epoch', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: 'tracked-epoch', seq: 1 }, endCursor: { epoch: 'tracked-epoch', seq: 1 },
      hasOlder: false, hasNewer: false, error: null,
      entries: [{ providerId: target.providerId, seqStart: 1, seqEnd: 1, timestamp: '2026-09-20T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
        item: { type: 'assistant_message', text: 'Loaded tracked conversation.' } }],
    },
  }));
  const transport: LabTransport = {
    listProviders: async () => [], createAgent: async () => { throw new Error('Unexpected creation'); }, resumeAgent: async () => { throw new Error('Unexpected resume'); },
    fetchSnapshot: async agentId => snapshotFor(agentId), fetchTimeline,
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(agentId, listener) {
      let observing = false;
      queueMicrotask(() => listener.onOpen());
      return { close: () => { if (observing) activityClosed(agentId); else contentClosed(agentId); }, send: message => {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: '1.6.0', type: 'negotiated', sessionControl: true });
          if (message.observation !== 'activity') listener.onMessage({ protocolVersion: '1.6.0', type: 'session_control', payload: { agentId, revision: 'control', access: 'control', available: false, token: 'control-token' } });
          if (message.observation === 'activity') {
            observing = true; activity = listener; activityListeners.set(agentId, listener);
            if (activityReady) listener.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId, status: 'idle', cursor: { epoch: 'tracked-epoch', seq: 1 } } });
          } else { contentConnections.push(agentId); contentListeners.set(agentId, listener); listener.onMessage(snapshotFor(agentId)); }
        } else if (message.type === 'session_control_request') {
          listener.onMessage({ protocolVersion: '1.6.0', type: 'session_control', payload: { agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'control-token' } });
        } else if (message.type === 'timeline_subscription') {
          listener.onMessage({ protocolVersion: '1.6.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
        }
      } };
    },
  };
  let hide!: () => void;
  let setAccessReady!: (ready: boolean) => void;
  function Harness() {
    const [visible, setVisible] = useState(true); hide = () => setVisible(false);
    const [accessReady, setAccess] = useState(initiallyAuthorized); setAccessReady = setAccess;
    return visible ? <WorkspaceReady.Provider value={accessReady}><App baseUrl={baseUrl} userScoped transport={transport}
      directory={new SessionDirectoryClient(baseUrl)} initialState={replicaState} initialSessionStatus="ready"
      hostService={{ hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('Unexpected pairing'); } }} /></WorkspaceReady.Provider> : null;
  }
  const container = await render(<Harness />);
  expect(attach).toHaveBeenCalledTimes(initiallyAuthorized ? other ? 2 : 1 : 0);
  expect(fetchTimeline).not.toHaveBeenCalled();
  const open = async (title = target.title) => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.lab-tracking-floating .lab-session-row')].find(row => row.textContent?.includes(title))!.click());
  };
  const emitActivity = (agentId: string, seq: number) => act(async () => {
    activityListeners.get(agentId)!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
      agentId, status: 'idle', cursor: { epoch: 'tracked-epoch', seq },
    } });
  });
  return { container, attach, open, activity, emitActivity, contentConnections, fetchTimeline, activityClosed, contentClosed, contentListeners, hide, setAccessReady };
}

it('retains tracked bindings and opened conversation clients while workspace authorization renews', async () => {
  const other = { ...star, nativeSessionId: 'other', title: 'Other conversation' };
  const f = await fixture(star, true, other);
  await f.open();
  await f.open(other.title);
  expect(f.contentConnections).toEqual(['live-agent', 'other-agent']);
  f.activityClosed.mockClear(); f.contentClosed.mockClear();
  await act(async () => f.setAccessReady(false));
  expect(f.activityClosed).not.toHaveBeenCalled();
  expect(f.contentClosed).not.toHaveBeenCalled();
  await act(async () => f.setAccessReady(true));
  expect(f.attach).toHaveBeenCalledTimes(2);
  await f.open();
  expect(f.contentConnections).toEqual(['live-agent', 'other-agent']);
  expect(f.fetchTimeline).toHaveBeenCalledTimes(2);
  await act(async () => f.hide());
  expect(f.activityClosed).toHaveBeenCalledTimes(2);
  expect(f.contentClosed).toHaveBeenCalledTimes(2);
});

it('waits for initial authorization before opening saved tracking observers', async () => {
  const f = await fixture(star, true, undefined, undefined, undefined, false);
  expect(f.attach).not.toHaveBeenCalled();
  expect(f.contentConnections).toEqual([]);
  await act(async () => f.setAccessReady(true));
  expect(f.attach).toHaveBeenCalledOnce();
  expect(f.contentConnections).toEqual([]);
});

it.each([
  star,
  { ...star, hostId: 'other-host', providerId: 'codex' },
  { ...star, parentNativeSessionId: 'native-parent' },
])('opens a live tracked session without waiting for directory attachment ($hostId / $providerId / $parentNativeSessionId)', async target => {
  const f = await fixture(target);
  // Any redundant attachment stays pending: content must still become visible.
  f.attach.mockImplementation(() => new Promise<{ agentId: string }>(() => {}));
  await f.open();
  expect(f.container.textContent).toContain('Loaded tracked conversation.');
  expect(f.attach).toHaveBeenCalledOnce();
  expect(f.contentConnections).toEqual(['live-agent']);
  expect(f.fetchTimeline).toHaveBeenCalledOnce();
  expect(f.activityClosed).not.toHaveBeenCalledWith('live-agent');
  expect(new URLSearchParams(location.search).get('session')).toBe(target.nativeSessionId);
});

it.each(['connecting', 'disconnected'] as const)('revalidates a %s tracked session instead of using a remembered binding', async connection => {
  const f = await fixture(star, connection !== 'connecting');
  if (connection === 'disconnected') await act(async () => f.activity.onDisconnect());
  let resolve!: (value: { agentId: string }) => void;
  f.attach.mockImplementation(() => new Promise<{ agentId: string }>(done => { resolve = done; }));
  await f.open();
  expect(f.attach).toHaveBeenCalledTimes(2);
  expect(f.contentConnections).toEqual([]);
  await act(async () => resolve({ agentId: 'live-agent' }));
  expect(f.contentConnections).toEqual(['live-agent']);
  expect(f.container.textContent).toContain('Loaded tracked conversation.');
});


it('closes the tracking edge only when content reaches the fixed activity cursor', async () => {
  const f = await fixture(star);
  await act(async () => f.activity.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
    agentId: 'live-agent', status: 'waiting', cursor: { epoch: 'tracked-epoch', seq: 1 },
  } } as Parameters<RemoteTransportListener['onMessage']>[0]));
  const page = await f.fetchTimeline('live-agent', 'tail', undefined, 100);
  f.fetchTimeline.mockClear();
  let release!: (value: typeof page) => void;
  f.fetchTimeline.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await f.open();
  const ring = () => f.container.querySelector('.lab-tracking-catch-up');
  expect(ring()?.getAttribute('data-state')).toBe('catching_up');
  expect(ring()?.getAttribute('aria-valuenow')).not.toBe('100');
  // A newer activity report must not move the target selected on entry.
  await act(async () => f.activity.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
    agentId: 'live-agent', status: 'running', cursor: { epoch: 'tracked-epoch', seq: 50 },
  } } as Parameters<RemoteTransportListener['onMessage']>[0]));
  await act(async () => release(page));
  expect(ring()?.getAttribute('data-state')).toBe('complete');
  expect(ring()?.getAttribute('aria-valuenow')).toBe('100');
  expect(f.container.textContent).toContain('Loaded tracked conversation.');
});


it('retains opened tracked content across switches without preconnecting unopened sessions', async () => {
  const other = { ...star, nativeSessionId: 'other', title: 'Other tracked conversation' };
  const f = await fixture(star, true, other);
  expect(f.contentConnections).toEqual([]);
  await f.open();
  expect(f.contentConnections).toEqual(['live-agent']);
  await f.open(other.title);
  expect(f.contentClosed).not.toHaveBeenCalledWith('live-agent');
  await act(async () => f.contentListeners.get('live-agent')!.onMessage({ protocolVersion: '1.6.0', type: 'agent_update',
    payload: { ...replicaState.agent!, id: 'live-agent', status: 'running', runtimeInfo: { ...replicaState.agent!.runtimeInfo, status: 'running', sessionId: star.nativeSessionId } } }));
  await f.open();
  expect(f.contentConnections).toEqual(['live-agent', 'other-agent']);
  expect(f.fetchTimeline).toHaveBeenCalledTimes(2);
  expect(f.container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Working');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
  expect(f.container.querySelector('[aria-label^="Untrack "]')).toBeNull();
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Close Tracked sessions"]')!.click());
  await act(async () => [...f.container.querySelectorAll<HTMLButtonElement>('.lab-sidebar-tabs button, .lab-session-panel-actions button')].find(button => button.textContent === 'Favorites')!.click());
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Filter tracked favorites"]')!.click());
  await act(async () => f.container.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${other.title}"]`)!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.lab-favorite-menu button')].find(button => button.textContent === 'Untrack')!.click());
  expect(f.contentClosed).toHaveBeenCalledWith('other-agent');
  expect(f.contentClosed).not.toHaveBeenCalledWith('live-agent');
  await act(async () => f.hide());
  expect(f.contentClosed).toHaveBeenCalledWith('live-agent');
});

it('recovers a delayed fork migration before removing a tracking identity missing from favorites', async () => {
  const fork = { ...star, nativeSessionId: 'fork' };
  let release!: (value: Response) => void;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
    if (!String(url).includes('v1/session-migrations')) return Response.json({});
    reads++;
    if (reads === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ migrations: [{ id: 'fork-edit', createdAt: 1,
      from: { hostId: star.hostId, providerId: star.providerId, nativeSessionId: star.nativeSessionId, agentId: 'live-agent' }, to: { hostId: fork.hostId, providerId: fork.providerId, nativeSessionId: fork.nativeSessionId, agentId: 'fork-agent' } }] });
  }));
  await fixture(star, true, undefined, [fork]);
  expect(readTrackedSessions(baseUrl).map(s => s.nativeSessionId)).toEqual(['tracked']);
  // The initial request predates the favorite replacement and cannot authorize cleanup.
  await act(async () => release(Response.json({ migrations: [] })));
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(readTrackedSessions(baseUrl).map(s => s.nativeSessionId)).toEqual(['fork']);
});


async function openChild(container: HTMLElement, id: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-child-session-id="${id}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

it('restores the tracked desktop pair and its focused pane instead of expanding the last child', async () => {
  const other = { ...star, nativeSessionId: 'other', title: 'Other tracked conversation' };
  const f = await fixture(star, true, other, undefined, { compact: false });
  await f.open();
  await openChild(f.container, 'child');
  await openChild(f.container, 'grandchild');
  // Show the first pair again while retaining a collapsed descendant.
  await act(async () => f.container.querySelector<HTMLButtonElement>('.lab-collapsed-window')!.click());
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Expand window 2: Tracked child"]')!.click());
  const firstSide = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
  await act(async () => firstSide.click());
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  expect(primary.hidden).toBe(false);
  expect(new URLSearchParams(location.search).get('session')).toBe('child');
  const visibleBefore = [...f.container.querySelectorAll<HTMLElement>('.lab-side-conversation')].map(pane => !pane.hidden);
  expect(visibleBefore).toEqual([true, false]);
  await f.open(other.title);
  await f.open();
  expect(primary.hidden).toBe(false);
  expect([...f.container.querySelectorAll<HTMLElement>('.lab-side-conversation')].map(pane => !pane.hidden)).toEqual([true, false]);
  expect(new URLSearchParams(location.search).get('session')).toBe('child');
  expect(f.contentConnections).toEqual(['live-agent', 'child-agent', 'grandchild-agent', 'other-agent']);
});

it('restores the child being read on mobile when returning to its tracked parent', async () => {
  const other = { ...star, nativeSessionId: 'other', title: 'Other tracked conversation' };
  const f = await fixture(star, true, other, undefined, { compact: true });
  await f.open();
  await openChild(f.container, 'child');
  expect(new URLSearchParams(location.search).get('session')).toBe('child');
  const input = f.container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Unsent child draft');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await f.open(other.title);
  await f.open();
  expect(new URLSearchParams(location.search).get('session')).toBe('child');
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Unsent child draft');
});

it('opens the tracked mobile parent when it has new content instead of restoring its child', async () => {
  const other = { ...star, nativeSessionId: 'other', title: 'Other tracked conversation' };
  const f = await fixture(star, true, other, undefined, { compact: true });
  await f.open();
  await openChild(f.container, 'child');
  await f.open(other.title);
  await f.emitActivity('live-agent', 2);
  await f.open();
  expect(new URLSearchParams(location.search).get('session')).toBe(star.nativeSessionId);
  expect(f.container.querySelector<HTMLElement>('.lab-primary-conversation')?.hidden).toBe(false);
  await f.open(other.title);
  await f.open();
  expect(new URLSearchParams(location.search).get('session')).toBe(star.nativeSessionId);
});

it('keeps a closed side conversation in tracking and preserves its unseen content', async () => {
  const child = { ...star, nativeSessionId: 'child', title: 'Tracked child' };
  const f = await fixture(star, true, child, undefined, { compact: false });
  await f.open();
  await openChild(f.container, 'child');
  const side = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
  await act(async () => side.querySelector<HTMLButtonElement>('.lab-side-close')!.click());
  expect(side.hidden).toBe(true);
  await f.emitActivity('child-agent', 2);
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
  const row = [...f.container.querySelectorAll<HTMLButtonElement>('.lab-tracking-floating .lab-session-row')].find(button => button.textContent?.includes(child.title));
  expect(row).toBeDefined();
  expect(row!.querySelector('.lab-tracked-change')).not.toBeNull();
  await act(async () => row!.click());
  expect(new URLSearchParams(location.search).get('session')).toBe(child.nativeSessionId);
});


it.each([false, true])('restores a side view and remembers when it was explicitly closed (compact: %s)', async compact => {
  const store = new ForkStore(baseUrl);
  const source = { ...star, agentId: 'live-agent' };
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  store.bind(record.id, { ...source, nativeSessionId: 'side', agentId: 'side-agent', title: 'Side discussion' });
  store.markConfigured(record.id);
  const other = { ...star, nativeSessionId: 'other', title: 'Other tracked conversation' };
  const f = await fixture(star, true, other, undefined, { compact });
  await f.open();
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Forked sessions"] button')!.click());
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  const side = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
  if (!compact) await act(async () => primary.click());
  expect(side.hidden).toBe(false);
  expect(primary.hidden).toBe(compact);
  expect(new URLSearchParams(location.search).get('session')).toBe(compact ? 'side' : 'tracked');
  await f.open(other.title);
  await f.open();
  expect(side.hidden).toBe(false);
  expect(primary.hidden).toBe(compact);
  expect(new URLSearchParams(location.search).get('session')).toBe(compact ? 'side' : 'tracked');
  await act(async () => side.querySelector<HTMLButtonElement>('.lab-side-close')!.click());
  await f.open(other.title);
  await f.open();
  expect(side.hidden).toBe(true);
  expect(primary.hidden).toBe(false);
  expect(new URLSearchParams(location.search).get('session')).toBe('tracked');
});

it('remembers an explicit return to the mobile parent instead of reviving the previous child', async () => {
  const other = { ...star, nativeSessionId: 'other', title: 'Other tracked conversation' };
  const f = await fixture(star, true, other, undefined, { compact: true });
  await f.open();
  await openChild(f.container, 'child');
  await f.open(other.title);
  await f.open();
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
  expect(new URLSearchParams(location.search).get('session')).toBe('tracked');
  await f.open(other.title);
  await f.open();
  expect(new URLSearchParams(location.search).get('session')).toBe('tracked');
});
