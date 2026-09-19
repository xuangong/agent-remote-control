import { expect, it } from 'vitest';
import { nextObservation, readTrackedSessions, saveTrackedSessions } from './tracking-state.js';
const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'My session', starredAt: 1 };
it('keeps tracking on this client and isolates different user namespaces', () => {
  saveTrackedSessions('alice', [session]);
  expect(readTrackedSessions('alice')).toEqual([session]);
  expect(readTrackedSessions('bob')).toEqual([]);
  expect(localStorage.getItem('agent-remote-tracking:alice')).not.toContain('agentId');
});
it('reports actual live changes without treating hydration or reconnect as a runtime transition', () => {
  const first = nextObservation(undefined, { connection: 'ready', activity: 'running' });
  expect(first.changed).toBe(false);
  const waiting = nextObservation(first, { connection: 'ready', activity: 'waiting' });
  expect(waiting.changed).toBe(true);
  const offline = nextObservation(first, { connection: 'disconnected', activity: 'running' });
  expect(offline.activity).toBeUndefined();
  expect(nextObservation({ ...offline, changed: false }, { connection: 'ready', activity: 'idle' }).changed).toBe(false);
});

it('keeps an actionable reminder until seen, superseded, or no longer current after reconnect', () => {
  const working = nextObservation(undefined, { connection: 'ready', activity: 'running' });
  const pending = nextObservation(working, { connection: 'ready', activity: 'waiting' });
  expect(pending).toMatchObject({ changed: true, attention: 'pending' });
  expect(nextObservation(pending, { connection: 'ready', activity: 'waiting' })).toMatchObject({ attention: 'pending' });
  const acknowledged = { ...pending, changed: false, attention: undefined };
  expect(nextObservation(acknowledged, { connection: 'ready', activity: 'waiting' }).attention).toBeUndefined();
  const resumed = nextObservation(pending, { connection: 'ready', activity: 'running' });
  expect(resumed.attention).toBeUndefined();
  expect(nextObservation(resumed, { connection: 'ready', activity: 'idle' })).toMatchObject({ changed: true, attention: 'idle' });
  const offline = nextObservation(pending, { connection: 'disconnected' });
  expect(nextObservation(offline, { connection: 'ready', activity: 'waiting' }).attention).toBe('pending');
  expect(nextObservation(offline, { connection: 'ready', activity: 'idle' }).attention).toBeUndefined();
});

it('alerts only on new pending states or working completion, never initial state or reconnect alone', () => {
  for (const activity of ['waiting', 'idle'] as const) {
    expect(nextObservation(undefined, { connection: 'ready', activity }).attention).toBeUndefined();
    const disconnected = nextObservation({ connection: 'ready', activity: 'running' }, { connection: 'disconnected' });
    expect(nextObservation(disconnected, { connection: 'ready', activity }).attention).toBeUndefined();
  }
  expect(nextObservation({ connection: 'ready', activity: 'idle' }, { connection: 'ready', activity: 'waiting' }).attention).toBe('pending');
  expect(nextObservation({ connection: 'ready', activity: 'waiting' }, { connection: 'ready', activity: 'idle' }).attention).toBeUndefined();
  expect(nextObservation({ connection: 'ready', activity: 'idle' }, { connection: 'ready', activity: 'starting' }).attention).toBeUndefined();
});
