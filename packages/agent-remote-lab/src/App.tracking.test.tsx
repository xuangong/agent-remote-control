import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteTransportListener } from '@orchardworks/agent-remote-web';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import { SessionStarsClient, type SessionStar } from './session-stars-client.js';
import { readTrackedSessions, saveTrackedSessions } from './tracking-state.js';
import { replicaState } from './test/fixtures.js';
import { render } from './test/setup.js';

const baseUrl = 'http://localhost/u/alice/';
const star: SessionStar = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'tracked', title: 'Tracked research', starredAt: 1 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

async function fixture(target: SessionStar, activityReady = true, other?: SessionStar, savedFavorites?: SessionStar[]) {
  saveTrackedSessions(baseUrl, [target, ...(other ? [other] : [])]);
  // Remembered runtime IDs are not evidence of a live binding.
  localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ ...target, agentId: 'stale-agent' }]));
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockResolvedValue({revision:0,folders:[],stars:(savedFavorites ?? [target, ...(other ? [other] : [])]).map((item, order) => ({ ...item, favoriteId: item.nativeSessionId, folderId: null, order, available: true, online: true }))});
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  const attach = vi.spyOn(SessionDirectoryClient.prototype, target.parentNativeSessionId ? 'attachChild' : 'attach').mockImplementation(async (_provider: string, id: string) => ({ agentId: other && id === other.nativeSessionId ? 'other-agent' : 'live-agent' }));
  let activity!: RemoteTransportListener;
  const contentConnections: string[] = [];
  const activityClosed = vi.fn();
  const contentClosed = vi.fn();
  const contentListeners = new Map<string, RemoteTransportListener>();
  const snapshot = { protocolVersion: '1.5.0' as const, type: 'agent_snapshot' as const,
    payload: { ...replicaState.agent!, id: 'live-agent', providerId: target.providerId,
      runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: target.providerId, sessionId: target.nativeSessionId } } };
  const fetchTimeline = vi.fn<LabTransport['fetchTimeline']>(async agentId => ({
    protocolVersion: '1.5.0', type: 'timeline_page', payload: {
      requestId: 'history', agentId, direction: 'tail', epoch: 'tracked-epoch', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: 'tracked-epoch', seq: 1 }, endCursor: { epoch: 'tracked-epoch', seq: 1 },
      hasOlder: false, hasNewer: false, error: null,
      entries: [{ providerId: target.providerId, seqStart: 1, seqEnd: 1, timestamp: '2026-09-20T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
        item: { type: 'assistant_message', text: 'Loaded tracked conversation.' } }],
    },
  }));
  const transport: LabTransport = {
    listProviders: async () => [], createAgent: async () => { throw new Error('Unexpected creation'); }, resumeAgent: async () => { throw new Error('Unexpected resume'); },
    fetchSnapshot: async () => snapshot, fetchTimeline,
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(agentId, listener) {
      let observing = false;
      queueMicrotask(() => listener.onOpen());
      return { close: () => { if (observing) activityClosed(agentId); else contentClosed(agentId); }, send: message => {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
          if (message.observation === 'activity') {
            observing = true; activity = listener;
            if (activityReady) listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId, status: 'idle' } });
          } else { contentConnections.push(agentId); contentListeners.set(agentId, listener); listener.onMessage({ ...snapshot, payload: { ...snapshot.payload, id: agentId, runtimeInfo: { ...snapshot.payload.runtimeInfo, sessionId: agentId === 'other-agent' ? other!.nativeSessionId : target.nativeSessionId } } }); }
        } else if (message.type === 'timeline_subscription') {
          listener.onMessage({ protocolVersion: '1.5.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
        }
      } };
    },
  };
  let hide!: () => void;
  function Harness() {
    const [visible, setVisible] = useState(true); hide = () => setVisible(false);
    return visible ? <App baseUrl={baseUrl} userScoped transport={transport}
      directory={new SessionDirectoryClient(baseUrl)} initialState={replicaState} initialSessionStatus="ready"
      hostService={{ hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('Unexpected pairing'); } }} /> : null;
  }
  const container = await render(<Harness />);
  expect(attach).toHaveBeenCalledTimes(other ? 2 : 1);
  expect(fetchTimeline).not.toHaveBeenCalled();
  const open = async (title = target.title) => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.lab-tracking-floating .lab-session-row')].find(row => row.textContent?.includes(title))!.click());
  };
  return { container, attach, open, activity, contentConnections, fetchTimeline, activityClosed, contentClosed, contentListeners, hide };
}

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
  await act(async () => f.activity.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: {
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
  await act(async () => f.activity.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: {
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
  await act(async () => f.contentListeners.get('live-agent')!.onMessage({ protocolVersion: '1.5.0', type: 'agent_update',
    payload: { ...replicaState.agent!, id: 'live-agent', status: 'running', runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: star.nativeSessionId } } }));
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
