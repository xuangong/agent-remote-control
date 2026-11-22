import { expect, it } from 'vitest';
import { ReplicaCache } from './replica-cache.js';

it('bounds fifty visited sessions while retaining the most recently used history', () => {
  const cache = new ReplicaCache();
  for (let i = 0; i < 50; i++) { cache.obtain(String(i)); cache.retain([String(i)]); }
  expect(cache.size).toBe(7);
  expect(cache.get('0')).toBeUndefined();
  expect(cache.get('49')).toBeDefined();
  const recent = cache.obtain('44');
  cache.obtain('50'); cache.retain(['50']);
  expect(cache.get('44')).toBe(recent);
  expect(cache.get('43')).toBeUndefined();
});

it('protects mounted panes and unsettled outgoing messages beyond the soft budget', () => {
  const cache = new ReplicaCache(1);
  const pending = cache.obtain('pending');
  const id = pending.beginMessage('pending', 'Do not lose this message');
  cache.obtain('main'); cache.obtain('side'); cache.obtain('ask');
  cache.retain(['main', 'side', 'ask']);
  cache.obtain('older'); cache.obtain('newer');
  cache.retain(['main', 'side', 'ask']);
  expect(cache.get('pending')).toBe(pending);
  expect(cache.get('main')).toBeDefined();
  expect(cache.get('side')).toBeDefined();
  expect(cache.get('ask')).toBeDefined();
  pending.deleteMessage(id);
  cache.retain(['main', 'side', 'ask']);
  expect(cache.get('pending')).toBeUndefined();
  expect(cache.get('newer')).toBeDefined();
});

it('reopens an evicted replica with fresh synchronization state', () => {
  const cache = new ReplicaCache(0);
  const first = cache.obtain('one');
  cache.retain([]);
  const reopened = cache.obtain('one');
  expect(reopened).not.toBe(first);
  expect(reopened.getState().timeline.initialized).toBe(false);
  expect(reopened.getState().timeline.epoch).toBeNull();
});

it('applies the estimated byte budget independently of the session count', () => {
  const cache = new ReplicaCache(6, 1);
  const active = cache.obtain('active');
  cache.obtain('inactive');
  cache.retain(['active']);
  expect(cache.get('active')).toBe(active);
  expect(cache.get('inactive')).toBeUndefined();
});
