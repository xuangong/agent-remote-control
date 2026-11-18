import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionDraftsView, SharedDraft } from '@orchardworks/agent-client';
import { DraftStore } from '../draft-store.js';
import { render } from '../test/setup.js';
import { SharedFeeds } from '../shared-feeds.js';
import { SharedDraftsContext, useSharedDrafts, useSharedDraft } from './useSharedDraft.js';

const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
beforeEach(() => { sessionStorage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

function view(drafts: Record<string, SharedDraft>, loaded = true): SessionDraftsView {
  return { loaded, draft: ref => drafts[ref.nativeSessionId] };
}
function harness(store: DraftStore, key = 'view:slot') {
  const saved: string[] = [], feeds = new SharedFeeds();
  let revision = 100;
  const shared = { current: () => feeds.get().drafts, subscribe: feeds.subscribe, save: async (_session: typeof session, text: string) => { saved.push(text); return ++revision; } };
  let renders = 0;
  function Composer() { renders++; useSharedDraft({ store, key }, session); return null; }
  return { saved, renders: () => renders,
    mount: (initial: SessionDraftsView) => { feeds.set({ drafts: initial }); return render(<SharedDraftsContext.Provider value={shared}><Composer /></SharedDraftsContext.Provider>); },
    remote: (value: SessionDraftsView) => act(async () => feeds.set({ drafts: value })) };
}

it("puts another device's draft into an empty composer and saves edits for every device", async () => {
  const store = new DraftStore('https://relay.example/');
  const h = harness(store);
  await h.mount(view({ thread: { text: 'From the phone', revision: 5 } }));
  expect(store.get('view:slot')).toBe('From the phone');
  await act(async () => { store.set('view:slot', 'From the phone, edited here'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(h.saved).toEqual(['From the phone, edited here']);
});

it('does not touch a composer being edited, and clears an idle one when the draft was sent elsewhere', async () => {
  const store = new DraftStore('https://relay.example/');
  const h = harness(store);
  await h.mount(view({ thread: { text: 'Draft', revision: 5 } }));
  await act(async () => { store.set('view:slot', 'Draft, still typing'); });
  await h.remote(view({ thread: { text: 'Other device', revision: 6 } }));
  expect(store.get('view:slot')).toBe('Draft, still typing');
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(h.saved).toEqual(['Draft, still typing']);
  await h.remote(view({ thread: { text: '', revision: 200 } }));
  expect(store.get('view:slot')).toBe('');
});

it('waits for the shared drafts to arrive before deciding, and remembers its agreement across a reload', async () => {
  const store = new DraftStore('https://relay.example/');
  const h = harness(store);
  await h.mount(view({}, false));
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(h.saved).toEqual([]);
  await h.remote(view({ thread: { text: 'Agreed', revision: 5 } }));
  expect(store.get('view:slot')).toBe('Agreed');
  // The tab reloads: its composer still holds the agreed text, and the draft was sent elsewhere meanwhile.
  store.flush();
  const reloaded = new DraftStore('https://relay.example/');
  expect(reloaded.get('view:slot')).toBe('Agreed');
  const again = harness(reloaded);
  await again.mount(view({ thread: { text: '', revision: 6 } }));
  expect(reloaded.get('view:slot')).toBe('');
});

it('keeps an edit waiting to be published while other drafts arrive', async () => {
  const store = new DraftStore('https://relay.example/');
  const h = harness(store);
  await h.mount(view({ thread: { text: 'Draft', revision: 5 } }));
  await act(async () => { store.set('view:slot', 'Draft, edited'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  await h.remote(view({ thread: { text: 'Draft', revision: 5 }, other: { text: 'Another session', revision: 9 } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(h.saved).toEqual(['Draft, edited']);
});

it('follows drafts without rendering the composer, and keeps one shared drafts object per feeds and transport', async () => {
  const store = new DraftStore('https://relay.example/');
  const h = harness(store);
  await h.mount(view({ thread: { text: 'Draft', revision: 5 } }));
  const before = h.renders();
  await h.remote(view({ thread: { text: 'From the phone', revision: 6 } }));
  expect(store.get('view:slot')).toBe('From the phone');
  expect(h.renders()).toBe(before);
  const feeds = new SharedFeeds(), transport = { saveSessionDraft: async (ref: typeof session, text: string) => ({ ...ref, text, revision: 1 }) };
  const seen: unknown[] = [];
  let rerender!: () => void;
  function Probe() { const [tick, setTick] = useState(0); rerender = () => setTick(value => value + 1); seen.push(useSharedDrafts(feeds, transport)); return <i>{tick}</i>; }
  await render(<Probe />);
  await act(async () => { feeds.set({ drafts: view({ thread: { text: 'Changed', revision: 2 } }) }); rerender(); });
  expect(seen.length).toBe(2);
  expect(new Set(seen).size).toBe(1);
});
