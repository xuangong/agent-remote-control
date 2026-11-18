import { expect, it } from 'vitest';
import { SessionOutboxStore } from './session-outbox.js';

const thread = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const entry = (index: number, status: 'waiting' | 'delivering' | 'failed' | 'unknown' = 'waiting', nativeSessionId = 'thread') =>
  ({ id: uuid(index), ...thread, nativeSessionId, text: `Message ${index}`, createdAt: index, status });
const frame = (fields: object) => ({ protocolVersion: '1.8.0' as const, type: 'session_outbox' as const, entries: [], ...fields });

it("keeps each session's waiting messages in the order they were sent, from snapshots, changes and removals", () => {
  const store = new SessionOutboxStore(), seen: number[] = [];
  store.subscribe(view => seen.push(view.entries(thread).length));
  expect(store.view().loaded).toBe(false);
  store.apply(frame({ snapshot: true, entries: [entry(2), entry(1), entry(3, 'waiting', 'other')] }));
  expect(store.view().loaded).toBe(true);
  expect(store.view().entries(thread).map(item => item.text)).toEqual(['Message 1', 'Message 2']);
  expect(store.view().all()).toHaveLength(3);
  store.apply(frame({ entries: [entry(1, 'delivering')] }));
  expect(store.view().entries(thread)[0]!.status).toBe('delivering');
  store.apply(frame({ removed: [uuid(1)] }));
  expect(store.view().entries(thread).map(item => item.id)).toEqual([uuid(2)]);
  store.apply(frame({ snapshot: true }));
  expect(store.view().entries(thread)).toEqual([]);
  expect(seen).toEqual([0, 2, 2, 1, 0]);
});

it('takes what this page queued, retried or cancelled at once', () => {
  const store = new SessionOutboxStore();
  store.apply(frame({ snapshot: true }));
  store.accept(entry(1));
  expect(store.view().entries(thread).map(item => item.id)).toEqual([uuid(1)]);
  store.accept(entry(1, 'failed'));
  expect(store.view().entries(thread)[0]!.status).toBe('failed');
  store.remove(uuid(1));
  expect(store.view().entries(thread)).toEqual([]);
});
