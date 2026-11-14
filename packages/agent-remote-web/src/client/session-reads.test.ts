import { expect, it } from 'vitest';
import { SessionReadStore } from './session-reads.js';

const thread = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
const frame = (fields: object) => ({ protocolVersion: '1.8.0' as const, type: 'session_reads' as const, ...fields });

it('knows nothing is unread until the account keeps positions, then compares replies with them', () => {
  const store = new SessionReadStore(), seen: Array<boolean> = [];
  store.subscribe(view => seen.push(view.unread(thread, 10)));
  expect(store.view().unread(thread, 10)).toBe(false);
  store.apply(frame({ snapshot: true, since: 5, reads: [] }));
  // A reply after the account started keeping positions, never read, is unread; one from before is not.
  expect(store.view().unread(thread, 10)).toBe(true);
  expect(store.view().unread(thread, 4)).toBe(false);
  store.apply(frame({ since: 5, reads: [{ ...thread, readAt: 10 }] }));
  expect(store.view().unread(thread, 10)).toBe(false);
  expect(store.view().unread(thread, 11)).toBe(true);
  expect(store.view().readAt(thread)).toBe(10);
  expect(seen).toEqual([false, true, false]);
});

it('advances a position locally, never moves it back, and starts over on a snapshot', () => {
  const store = new SessionReadStore();
  store.apply(frame({ snapshot: true, since: 1, reads: [{ ...thread, readAt: 10 }] }));
  expect(store.advance(thread, 8)).toBe(false);
  expect(store.advance(thread, 12)).toBe(true);
  expect(store.view().readAt(thread)).toBe(12);
  store.apply(frame({ reads: [{ ...thread, readAt: 11 }] }));
  expect(store.view().readAt(thread)).toBe(12);
  store.apply(frame({ snapshot: true, since: 1, reads: [] }));
  expect(store.view().readAt(thread)).toBeUndefined();
});
