import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { SESSION_STATE_LIMIT } from './session-states.js';

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

it('lets the Relay acknowledge session states when it registers a Host', () => {
  const registered = { uplinkVersion: 2, type: 'registered', sessionStates: 1, hostId: 'host', heartbeat: { intervalMs: 20_000, timeoutMs: 10_000 } };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(registered)).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, sessionStates: 2 })).status).toBe('rejected');
});
