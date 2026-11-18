import { act, createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { SessionOutboxStore, SessionStateStore, type SessionStatesView } from '@orchardworks/agent-client';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { SharedFeeds, SharedFeedsContext, useSharedFeed, useSharedFeedsSource, type SharedFeedsTransport } from './shared-feeds.js';
import { render, unmount } from './test/setup.js';

it('replaces its snapshot when a part changes and tells its listeners, and not otherwise', () => {
  const feeds = new SharedFeeds(), listener = vi.fn();
  feeds.subscribe(listener);
  const states = {} as SessionStatesView;
  feeds.set({ states });
  const first = feeds.get();
  expect(first.states).toBe(states);
  feeds.set({ states });
  feeds.set({ reads: undefined });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(feeds.get()).toBe(first);
  feeds.set({ states: undefined });
  expect(feeds.get()).toEqual({});
  expect(listener).toHaveBeenCalledTimes(2);
});

it('renders a reader when what it selects changes, and not for other parts', async () => {
  const feeds = new SharedFeeds(), outbox = new SessionOutboxStore();
  const renders = vi.fn();
  function Reader() {
    const loaded = useSharedFeed(snapshot => snapshot.outbox?.loaded ?? false);
    renders(loaded);
    return createElement('span', null, String(loaded));
  }
  const container = await render(createElement(SharedFeedsContext.Provider, { value: feeds }, createElement(Reader)));
  expect(container.textContent).toBe('false');
  await act(async () => feeds.set({ states: {} as SessionStatesView }));
  expect(renders).toHaveBeenCalledTimes(1);
  await act(async () => { outbox.apply({ protocolVersion: PROTOCOL_VERSION, type: 'session_outbox', snapshot: true, entries: [] }); feeds.set({ outbox: outbox.view() }); });
  expect(container.textContent).toBe('true');
  expect(renders).toHaveBeenCalledTimes(2);
  await unmount(container);
});

it('opens the wanted feeds of a transport and closes them when no longer wanted', async () => {
  const states = new SessionStateStore(), stops = { states: vi.fn(), reads: vi.fn(), drafts: vi.fn(), outbox: vi.fn() };
  const transport: SharedFeedsTransport = {
    watchSessionStates: listener => { const stop = states.subscribe(listener); return () => { stop(); stops.states(); }; },
    watchSessionReads: () => stops.reads, watchSessionDrafts: () => stops.drafts, watchSessionOutbox: () => stops.outbox,
  };
  let feeds!: SharedFeeds;
  function Source({ wanted }: { wanted: boolean }) { feeds = useSharedFeedsSource(transport, { states: wanted, drafts: wanted, outbox: wanted }); return null; }
  const container = await render(createElement(Source, { wanted: true }));
  expect(feeds.get().states).toBeDefined();
  await act(async () => states.apply({ protocolVersion: PROTOCOL_VERSION, type: 'session_states', snapshot: true, hosts: [{ hostId: 'h', online: true }], states: [] }));
  const view = feeds.get().states;
  expect(view?.state({ hostId: 'h', providerId: 'p', nativeSessionId: 's' }).state).toBe('unknown');
  await unmount(container);
  for (const stop of Object.values(stops)) expect(stop).toHaveBeenCalledTimes(1);
});
