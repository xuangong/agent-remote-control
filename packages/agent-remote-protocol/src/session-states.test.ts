import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { SESSION_PREVIEW_LENGTH, SESSION_PREVIEW_MAX_LENGTH, SESSION_STATE_LIMIT } from './session-states.js';

const report = (fields: Record<string, unknown>) => JSON.stringify({ uplinkVersion: 2, type: 'session_states', full: false, states: [], ...fields });

it('accepts bounded Host session state reports carrying only identities, states and update times', () => {
  const state = { providerId: 'codex', nativeSessionId: 'thread', state: 'running', updatedAt: 1 };
  expect(decodeRemoteHostUplinkMessage(report({ full: true, states: [state] })).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(report({ removed: [{ providerId: 'claude', nativeSessionId: 'gone' }] })).status).toBe('ok');
  for (const invalid of [{ states: [{ ...state, state: 'unknown' }] }, { states: [{ ...state, title: 'Secret plan' }] },
    { states: Array.from({ length: SESSION_STATE_LIMIT + 1 }, (_, index) => ({ ...state, nativeSessionId: `thread-${index}` })) }]) {
    expect(decodeRemoteHostUplinkMessage(report(invalid)).status).toBe('rejected');
  }
});

it('lets the Relay acknowledge session states, and reply facts with them, when it registers a Host', () => {
  const registered = { uplinkVersion: 2, type: 'registered', sessionStates: 1, hostId: 'host', heartbeat: { intervalMs: 20_000, timeoutMs: 10_000 } };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(registered)).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, sessionStates: 2 })).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, sessionStates: 3 })).status).toBe('rejected');
});

it("carries a session's latest reply time and a bounded plain preview of it", () => {
  const state = { providerId: 'codex', nativeSessionId: 'thread', state: 'idle', updatedAt: 1, replyAt: 2, preview: 'Done: the release notes are ready.' };
  expect(decodeRemoteHostUplinkMessage(report({ states: [state] })).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(report({ states: [{ ...state, preview: 'x'.repeat(SESSION_PREVIEW_MAX_LENGTH) }] })).status).toBe('ok');
  expect(SESSION_PREVIEW_LENGTH).toBeLessThan(SESSION_PREVIEW_MAX_LENGTH);
  for (const invalid of [{ ...state, preview: '' }, { ...state, preview: 'x'.repeat(SESSION_PREVIEW_MAX_LENGTH + 1) }, { ...state, replyAt: -1 }, { ...state, replyAt: 1.5 }]) {
    expect(decodeRemoteHostUplinkMessage(report({ states: [invalid] })).status).toBe('rejected');
  }
});
