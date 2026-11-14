import { describe, expect, it } from 'vitest';
import type { SessionStatesView, SharedSessionState } from '@orchardworks/agent-remote-web';
import { activityLabel, sessionActivity, windowActivity } from './session-activity-status.js';
import { sessionKey } from './session-tree.js';

const session = { hostId: 'host', providerId: 'claude', nativeSessionId: 'one' };
const shared = (state: SharedSessionState): SessionStatesView => ({ state: () => ({ state }), reply: () => undefined });

describe('sessionActivity', () => {
  it('prefers Track’s live observation to the shared state', () => {
    expect(sessionActivity(session, { [sessionKey(session)]: { connection: 'ready', activity: 'running' } }, shared('idle'))).toBe('running');
  });

  it('uses the shared state while Track has no ready observation', () => {
    expect(sessionActivity(session, { [sessionKey(session)]: { connection: 'connecting' } }, shared('waiting'))).toBe('waiting');
    expect(sessionActivity(session, {}, shared('offline'))).toBe('offline');
  });

  it('is unknown without any source', () => {
    expect(sessionActivity(session)).toBe('unknown');
  });
});

describe('windowActivity', () => {
  it.each([
    [['idle', 'running', 'waiting', 'failed'], 'waiting'],
    [['idle', 'starting'], 'waiting'],
    [['idle', 'running', 'failed'], 'failed'],
    [['idle', 'running', 'unknown'], 'running'],
    [['idle', 'unknown', 'offline'], 'idle'],
    [['unknown', 'offline', 'closed'], undefined],
    [[], undefined],
  ] as const)('ranks %j as %s', (statuses, expected) => {
    expect(windowActivity(statuses)).toBe(expected);
  });
});

it('labels statuses as Track groups them', () => {
  expect(['running', 'waiting', 'starting', 'idle', 'failed', 'offline', 'unknown'].map(status => activityLabel(status as never)))
    .toEqual(['Working', 'Pending', 'Pending', 'Idle', 'Failed', 'Host offline', 'Status unavailable']);
});
