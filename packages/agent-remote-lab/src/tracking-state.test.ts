import { expect, it } from 'vitest';
import { nextObservation, observationLabel, readTrackedSessions, saveTrackedSessions, readTrackedSessionsChecked, patchTrackedSessions, trackingEditRevision } from './tracking-state.js';
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

it('does not repeat an already read update after reconnect, but reports later unseen content', () => {
  const cursor = { epoch: 'content', seq: 8 };
  const readCursor = { ...cursor, seq: 10 };
  const first = nextObservation(undefined, { connection: 'ready', activity: 'idle', cursor });
  const offline = nextObservation(first, { connection: 'disconnected' }, readCursor);
  const connecting = nextObservation(offline, { connection: 'connecting' }, readCursor);
  const restored = nextObservation(connecting, { connection: 'ready', activity: 'idle', cursor: { ...cursor, seq: 9 } }, readCursor);
  expect(restored.changed).toBe(false);
  const caughtUp = nextObservation(restored, { connection: 'ready', activity: 'idle', cursor: readCursor }, readCursor);
  expect(caughtUp.changed).toBe(false);
  const unseen = nextObservation(caughtUp, { connection: 'ready', activity: 'idle', cursor: { ...cursor, seq: 11 } }, readCursor);
  expect(unseen.changed).toBe(true);
});

it('does not let a high read cursor from an old epoch hide progress in the replacement epoch', () => {
  const readCursor = { epoch: 'old', seq: 100 };
  const first = nextObservation(undefined, { connection: 'ready', activity: 'idle', cursor: { epoch: 'old', seq: 8 } });
  const replacement = nextObservation(first, { connection: 'ready', activity: 'idle', cursor: { epoch: 'new', seq: 1 } }, readCursor);
  expect(replacement.changed).toBe(false);
  const unseen = nextObservation(replacement, { connection: 'ready', activity: 'idle', cursor: { epoch: 'new', seq: 2 } }, readCursor);
  expect(unseen.changed).toBe(true);
});

it('honors content already read in a replacement epoch even when activity catches up after reconnect', () => {
  const readCursor = { epoch: 'new', seq: 3 };
  const first = nextObservation(undefined, { connection: 'ready', activity: 'idle', cursor: { epoch: 'old', seq: 8 } });
  const lateOldActivity = nextObservation(first, { connection: 'ready', activity: 'idle', cursor: { epoch: 'old', seq: 8 } }, readCursor);
  const offline = nextObservation(lateOldActivity, { connection: 'disconnected' }, readCursor);
  const replacement = nextObservation(offline, { connection: 'ready', activity: 'idle', cursor: { epoch: 'new', seq: 1 } }, readCursor);
  expect(replacement.changed).toBe(false);
  const caughtUp = nextObservation(replacement, { connection: 'ready', activity: 'idle', cursor: readCursor }, readCursor);
  expect(caughtUp.changed).toBe(false);
  const unseen = nextObservation(caughtUp, { connection: 'ready', activity: 'idle', cursor: { epoch: 'new', seq: 4 } }, readCursor);
  expect(unseen.changed).toBe(true);
});

it('retains local stable metadata through legacy save and patches only the affected entry', () => {
  const scope = 'stable-tracks';
  const a = { ...session, entryId: 'slot-a', successionRole: { controllerId: 'controller', roleId: 'successionRole', revision: 1 } };
  saveTrackedSessions(scope, [a, { ...session, nativeSessionId: 'X', title: 'Independent', entryId: 'slot-x' }]);
  saveTrackedSessions(scope, [{ ...session, title: 'Renamed' }, { ...session, nativeSessionId: 'X', title: 'Externally renamed', entryId: 'slot-x' }]);
  const before = readTrackedSessionsChecked(scope);
  expect(before.status).toBe('ready');
  expect(readTrackedSessions(scope)[0]).toMatchObject({ entryId: 'slot-a', successionRole: a.successionRole });
  const result = patchTrackedSessions(scope, [{ entryId: 'slot-a', from: session, to: { ...session, nativeSessionId: 'B' } }], trackingEditRevision(scope), () => true);
  expect(result.status).toBe('saved');
  expect(readTrackedSessions(scope)).toMatchObject([{ entryId: 'slot-a', nativeSessionId: 'B', title: 'Renamed' }, { entryId: 'slot-x', title: 'Externally renamed' }]);
});
it('rejects stale same-tab Track work and refuses to overwrite damaged Track data', () => {
  const scope = 'guarded-tracks'; saveTrackedSessions(scope, [{ ...session, entryId: 'a' }]);
  const revision = trackingEditRevision(scope); saveTrackedSessions(scope, [{ ...session, title: 'New edit', entryId: 'a' }]);
  expect(patchTrackedSessions(scope, [], revision, () => true).status).toBe('cancelled');
  localStorage.setItem(`agent-remote-tracking:${scope}`, '{damaged');
  expect(readTrackedSessionsChecked(scope).status).toBe('failed');
  expect(patchTrackedSessions(scope, [], trackingEditRevision(scope), () => true).status).toBe('failed');
  expect(localStorage.getItem(`agent-remote-tracking:${scope}`)).toBe('{damaged');
});

it('suppresses quiet review completion while preserving input requests and visible findings', () => {
  const cursor = { epoch: 'one', seq: 1 };
  const background = { id: 'review', kind: 'review' as const, status: 'silent' as const };
  const running = nextObservation(undefined, { connection: 'ready', activity: 'running', cursor, background });
  const quiet = nextObservation(running, { connection: 'ready', activity: 'idle', cursor, background });
  expect(quiet).toMatchObject({ changed: false }); expect(quiet.attention).toBeUndefined();
  expect(nextObservation(running, { connection: 'ready', activity: 'waiting', cursor, background }).attention).toBe('pending');
  const visible = nextObservation(quiet, { connection: 'ready', activity: 'idle', cursor: { ...cursor, seq: 3 }, background: { ...background, status: 'visible' } });
  expect(visible).toMatchObject({ changed: true, attention: 'idle' });
});

it('labels a refused tracking subscription as unavailable rather than a connection failure', () => {
  expect(observationLabel({ connection: 'unavailable', error: 'A native CLI owns this session.' })).toBe('Unavailable');
  expect(observationLabel({ connection: 'disconnected', error: 'Tracking could not connect.' })).toBe('Connection failed');
});
