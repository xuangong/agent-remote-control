import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteTransportListener } from '@orchardworks/agent-remote-web';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import { SessionStarsClient, type SessionStar } from './session-stars-client.js';
import { saveTrackedSessions } from './tracking-state.js';
import { replicaState } from './test/fixtures.js';
import { render } from './test/setup.js';

const baseUrl = 'http://localhost/u/alice/';
const star: SessionStar = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'tracked', title: 'Tracked research', starredAt: 1 };
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

async function fixture(target: SessionStar, activityReady = true) {
  saveTrackedSessions(baseUrl, [target]);
  // Remembered runtime IDs are not evidence of a live binding.
  localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ ...target, agentId: 'stale-agent' }]));
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockResolvedValue({revision:0,folders:[],stars:[]});
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  const attach = vi.spyOn(SessionDirectoryClient.prototype, target.parentNativeSessionId ? 'attachChild' : 'attach').mockResolvedValue({ agentId: 'live-agent' });
  let activity!: RemoteTransportListener;
  const contentConnections: string[] = [];
  const activityClosed = vi.fn();
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
      return { close: () => { if (observing) activityClosed(agentId); }, send: message => {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
          if (message.observation === 'activity') {
            observing = true; activity = listener;
            if (activityReady) listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId, status: 'idle' } });
          } else { contentConnections.push(agentId); listener.onMessage(snapshot); }
        } else if (message.type === 'timeline_subscription') {
          listener.onMessage({ protocolVersion: '1.5.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
        }
      } };
    },
  };
  const container = await render(<App baseUrl={baseUrl} userScoped transport={transport}
    directory={new SessionDirectoryClient(baseUrl)} initialState={replicaState} initialSessionStatus="ready"
    hostService={{ hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('Unexpected pairing'); } }} />);
  expect(attach).toHaveBeenCalledOnce();
  expect(fetchTimeline).not.toHaveBeenCalled();
  const open = async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-tracking-floating .lab-session-row')!.click());
  };
  return { container, attach, open, activity, contentConnections, fetchTimeline, activityClosed };
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
