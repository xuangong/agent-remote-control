import { act, useMemo, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionDraftsView, SharedDraft } from '@orchardworks/agent-remote-web';
import { DraftStore } from '../draft-store.js';
import { render } from '../test/setup.js';
import { SharedDraftsContext, useSessionDrafts, useSharedDraft } from './useSharedDraft.js';

const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
beforeEach(() => { sessionStorage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

function view(drafts: Record<string, SharedDraft>, loaded = true): SessionDraftsView {
  return { loaded, draft: ref => drafts[ref.nativeSessionId] };
}
function harness(store: DraftStore, key = 'view:slot') {
  const saved: string[] = [];
  let revision = 100, setView: ((value: SessionDraftsView) => void) | undefined;
  const save = async (_session: typeof session, text: string) => { saved.push(text); return ++revision; };
  function Composer() { useSharedDraft({ store, key }, session); return null; }
  function Harness({ initial }: { initial: SessionDraftsView }) {
    const [current, set] = useState(initial);
    setView = set;
    const value = useMemo(() => ({ view: current, save }), [current]);
    return <SharedDraftsContext.Provider value={value}><Composer /></SharedDraftsContext.Provider>;
  }
  return { saved, mount: (initial: SessionDraftsView) => render(<Harness initial={initial} />), remote: (value: SessionDraftsView) => act(async () => setView!(value)) };
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

it('gives composers one save for the transport while drafts change', async () => {
  let emit!: (view: SessionDraftsView) => void;
  const transport = {
    watchSessionDrafts: (listener: (view: SessionDraftsView) => void) => { emit = listener; listener(view({})); return () => {}; },
    saveSessionDraft: async (ref: typeof session, text: string) => ({ ...ref, text, revision: 1 }),
  };
  const saves: unknown[] = [];
  function Probe() { const shared = useSessionDrafts(transport, true); if (shared) saves.push(shared.save); return null; }
  await render(<Probe />);
  await act(async () => emit(view({ thread: { text: 'Changed', revision: 2 } })));
  expect(saves.length).toBeGreaterThan(1);
  expect(new Set(saves).size).toBe(1);
});
