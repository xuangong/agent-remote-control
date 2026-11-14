import { expect, it } from 'vitest';
import { SessionDraftStore } from './session-drafts.js';

const thread = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
const other = { ...thread, nativeSessionId: 'other' };
const frame = (fields: object) => ({ protocolVersion: '1.8.0' as const, type: 'session_drafts' as const, drafts: [], ...fields });

it('replaces its drafts on a snapshot and changes them on later frames', () => {
  const store = new SessionDraftStore(), seen: Array<string | undefined> = [];
  store.subscribe(view => seen.push(view.draft(thread)?.text));
  expect(store.view().loaded).toBe(false);
  store.apply(frame({ snapshot: true, drafts: [{ ...thread, text: 'Ship it', revision: 3 }, { ...other, text: '', revision: 2 }] }));
  expect(store.view().loaded).toBe(true);
  expect(store.view().draft(thread)).toEqual({ text: 'Ship it', revision: 3 });
  // A cleared draft is known as cleared.
  expect(store.view().draft(other)).toEqual({ text: '', revision: 2 });
  store.apply(frame({ drafts: [{ ...thread, text: 'Ship it today', revision: 5 }] }));
  expect(store.view().draft(thread)).toEqual({ text: 'Ship it today', revision: 5 });
  // An older revision never replaces a newer one.
  store.apply(frame({ drafts: [{ ...thread, text: 'Old', revision: 4 }] }));
  expect(store.view().draft(thread)?.text).toBe('Ship it today');
  store.apply(frame({ snapshot: true, drafts: [] }));
  expect(store.view().draft(thread)).toBeUndefined();
  expect(seen).toEqual([undefined, 'Ship it', 'Ship it today', 'Ship it today', undefined]);
});

it('takes a draft this page saved at once', () => {
  const store = new SessionDraftStore();
  store.apply(frame({ snapshot: true }));
  store.accept({ ...thread, text: 'Saved here', revision: 7 });
  expect(store.view().draft(thread)).toEqual({ text: 'Saved here', revision: 7 });
  store.accept({ ...thread, text: 'Stale', revision: 6 });
  expect(store.view().draft(thread)?.text).toBe('Saved here');
});
