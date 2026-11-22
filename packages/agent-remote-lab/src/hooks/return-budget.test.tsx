import { notifyFeedReopened } from '@orchardworks/agent-client';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { ForkStore } from '../kernel/session-forks.js';
import { SessionStarsClient } from '../features/sessions/session-stars-client.js';
import { useRemoteHosts } from '../features/computers/useRemoteHosts.js';
import { useSessionRelations } from '../features/session-links/useSessionRelations.js';
import { useSessionStars } from '../features/sessions/useSessionStars.js';
import type { HostPairingService } from '../kernel/remote-host.js';

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (value: DocumentVisibilityState) => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); visibility = 'visible'; });

/** The list loaders a conversation page mounts, with the requests each made counted by endpoint. */
async function mountLoaders() {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { requests.push(new URL(String(input), 'http://localhost').pathname); return Response.json({ relations: [] }); }));
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockImplementation(async () => { requests.push('favorites'); return { revision: 0, folders: [], stars: [] }; });
  const service = { hosts: vi.fn(async () => { requests.push('hosts'); return { hosts: [] }; }), pair: async () => { throw new Error('unused'); }, revoke: async () => {} } as unknown as HostPairingService;
  function Loaders() {
    useRemoteHosts(service, true, false);
    useSessionStars('http://localhost/u/alice/', true);
    useSessionRelations('http://localhost/u/alice/', true, new ForkStore('sides'), new ForkStore('asks', sessionStorage), 'main');
    return null;
  }
  await render(<Loaders />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const count = (name: string) => requests.filter(path => path.endsWith(name)).length;
  const now = () => ({ hosts: count('hosts'), favorites: count('favorites'), relations: count('session-relations') });
  return { requests, now };
}

it('refetches no list when the page becomes visible again while the feed stayed open', async () => {
  const { requests, now } = await mountLoaders();
  expect(now()).toMatchObject({ hosts: 1, favorites: 1 });
  setVisibility('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  const hidden = requests.length;
  window.dispatchEvent(new Event('blur'));
  setVisibility('visible');
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('pageshow'));
  window.dispatchEvent(new Event('online'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(requests).toHaveLength(hidden);
});

it('refetches every list once when the feed socket reopens, and lists still refresh on their own timers', async () => {
  const { now } = await mountLoaders();
  const mounted = now();
  await act(async () => { notifyFeedReopened(); await vi.advanceTimersByTimeAsync(0); });
  const reopened = now();
  expect(reopened).toMatchObject({ hosts: mounted.hosts + 1, favorites: mounted.favorites + 1 });
  // Applying relations lets the stores that follow them ask once more.
  expect(reopened.relations - mounted.relations).toBeGreaterThanOrEqual(1);
  expect(reopened.relations - mounted.relations).toBeLessThanOrEqual(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(now().relations).toBeGreaterThan(reopened.relations);
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(now().favorites).toBeGreaterThan(reopened.favorites);
  expect(now().hosts).toBeGreaterThan(reopened.hosts);
});

it('marks lists due when the feed reopens while the page is hidden, and refreshes each once when the page is shown', async () => {
  const { requests, now } = await mountLoaders();
  const mounted = now();
  setVisibility('hidden');
  const before = requests.length;
  await act(async () => { notifyFeedReopened(); await vi.advanceTimersByTimeAsync(0); });
  expect(requests).toHaveLength(before);
  setVisibility('visible');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const shown = now();
  expect(shown.hosts).toBe(mounted.hosts + 1);
  expect(shown.favorites).toBe(mounted.favorites + 1);
  expect(shown.relations).toBeGreaterThan(mounted.relations);
  // Hiding and showing again with the feed alive refreshes nothing more.
  const after = requests.length;
  setVisibility('hidden'); setVisibility('visible');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(requests).toHaveLength(after);
});
