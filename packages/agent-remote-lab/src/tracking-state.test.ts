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
  expect(waiting.changed).toBe(false);
  const offline = nextObservation(first, { connection: 'disconnected', activity: 'running' });
  expect(offline.activity).toBeUndefined();
  expect(nextObservation(offline, { connection: 'ready', activity: 'idle' }).changed).toBe(false);
});

it('keeps an actionable reminder until seen, superseded, or no longer current after reconnect', () => {
  const working = nextObservation(undefined, { connection: 'ready', activity: 'running' });
  const pending = nextObservation(working, { connection: 'ready', activity: 'waiting' });
  expect(pending).toMatchObject({ changed: false, attention: 'pending' });
  expect(nextObservation(pending, { connection: 'ready', activity: 'waiting' })).toMatchObject({ attention: 'pending' });
  const acknowledged = { ...pending, changed: false, attention: undefined };
  expect(nextObservation(acknowledged, { connection: 'ready', activity: 'waiting' }).attention).toBeUndefined();
  const resumed = nextObservation(pending, { connection: 'ready', activity: 'running' });
  expect(resumed.attention).toBeUndefined();
  expect(nextObservation(resumed, { connection: 'ready', activity: 'idle' })).toMatchObject({ changed: false, attention: 'idle' });
  const offline = nextObservation(pending, { connection: 'disconnected' });
  expect(nextObservation(offline, { connection: 'ready', activity: 'waiting' }).attention).toBe('pending');
  expect(nextObservation(offline, { connection: 'ready', activity: 'idle' }).attention).toBeUndefined();
});

it('marks only canonical content progress as new, including content received across a reconnect', () => {
  const cursor = { epoch: 'content', seq: 8 };
  const first = nextObservation(undefined, { connection: 'ready', activity: 'idle', cursor });
  const offline = nextObservation(first, { connection: 'disconnected' });
  const connecting = nextObservation(offline, { connection: 'connecting' });
  expect(connecting).toMatchObject({ changed: false, cursor });
  const restored = nextObservation(connecting, { connection: 'ready', activity: 'idle', cursor });
  expect(restored.changed).toBe(false);
  const working = nextObservation(restored, { connection: 'ready', activity: 'running', cursor });
  expect(working.changed).toBe(false);
  const output = nextObservation(working, { connection: 'ready', activity: 'running', cursor: { ...cursor, seq: 9 } });
  expect(output.changed).toBe(true);
  expect(nextObservation(output, { connection: 'ready', activity: 'idle', cursor: output.cursor }).changed).toBe(true);
  expect(nextObservation(connecting, { connection: 'ready', activity: 'idle', cursor: { ...cursor, seq: 9 } }).changed).toBe(true);
});

it('does not count initial history, older cursors, missing cursors or replacement epochs as new content', () => {
  const first = nextObservation(undefined, { connection: 'ready', activity: 'running', cursor: { epoch: 'one', seq: 8 } });
  expect(first.changed).toBe(false);
  const older = nextObservation(first, { connection: 'ready', activity: 'running', cursor: { epoch: 'one', seq: 7 } });
  expect(older).toMatchObject({ changed: false, cursor: first.cursor });
  expect(nextObservation(older, { connection: 'ready', activity: 'running', cursor: first.cursor }).changed).toBe(false);
  const missing = nextObservation(first, { connection: 'ready', activity: 'idle' });
  expect(missing).toMatchObject({ changed: false, cursor: first.cursor });
  const replaced = nextObservation({ ...first, changed: true }, { connection: 'ready', activity: 'idle', cursor: { epoch: 'two', seq: 80 } });
  expect(replaced.changed).toBe(false);
  expect(nextObservation(replaced, { connection: 'ready', activity: 'idle', cursor: { epoch: 'two', seq: 81 } }).changed).toBe(true);
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
