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
