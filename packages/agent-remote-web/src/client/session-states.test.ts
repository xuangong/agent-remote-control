import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SESSION_STATE_STALE_MS } from '@orchardworks/agent-remote-protocol';
import { SessionStateStore } from './session-states.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => vi.useRealTimers());

const thread = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
const frame = (fields: object) => ({ protocolVersion: '1.8.0' as const, type: 'session_states' as const, ...fields });

it('trusts a state while its Host keeps confirming it and reports unknown once it goes unconfirmed', () => {
  const store = new SessionStateStore(), seen: string[] = [];
  store.subscribe(view => seen.push(view.state(thread).state));
  store.apply(frame({ snapshot: true, hosts: [{ hostId: 'host', online: true, confirmedAgeMs: 1_000 }], states: [{ ...thread, state: 'running', updatedAt: 7, ageMs: 5_000 }] }));
  expect(store.view().state(thread)).toEqual({ state: 'running', updatedAt: 7 });
  // The Host confirms all its states again a minute later.
  vi.advanceTimersByTime(60_000);
  store.apply(frame({ hosts: [{ hostId: 'host', online: true, confirmedAgeMs: 0 }] }));
  vi.advanceTimersByTime(SESSION_STATE_STALE_MS - 1);
  expect(store.view().state(thread).state).toBe('running');
  // Listeners learn when it turns unknown, without another frame.
  vi.advanceTimersByTime(2);
  expect(seen.at(-1)).toBe('unknown');
  expect(store.view().state(thread)).toEqual({ state: 'unknown' });
  // A change confirms the session on its own.
  store.apply(frame({ states: [{ ...thread, state: 'idle', ageMs: 0 }] }));
  expect(store.view().state(thread).state).toBe('idle');
});

it('separates offline Hosts, unknown sessions and removed states, and replaces everything on a snapshot', () => {
  const store = new SessionStateStore();
  store.apply(frame({ snapshot: true, hosts: [{ hostId: 'host', online: true, confirmedAgeMs: 0 }, { hostId: 'away', online: false }],
    states: [{ ...thread, state: 'failed', ageMs: 0 }, { ...thread, nativeSessionId: 'other', state: 'idle', ageMs: 0 }] }));
  expect(store.view().state({ ...thread, hostId: 'away' }).state).toBe('offline');
  expect(store.view().state({ ...thread, hostId: 'unseen' }).state).toBe('unknown');
  expect(store.view().state({ ...thread, nativeSessionId: 'missing' }).state).toBe('unknown');
  store.apply(frame({ removed: [thread] }));
  expect(store.view().state(thread).state).toBe('unknown');
  store.apply(frame({ snapshot: true }));
  expect(store.view().state({ ...thread, nativeSessionId: 'other' }).state).toBe('unknown');
});
