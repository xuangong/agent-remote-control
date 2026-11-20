import { describe, expect, it } from 'vitest';
import type { SessionStatesView, SharedSessionState } from '@orchardworks/agent-client';
import { activityGroups, sessionActivity, windowActivity } from './session-activity-status.js';
import { sessionKey } from './session-tree.js';

const session = { hostId: 'host', providerId: 'claude', nativeSessionId: 'one' };
const shared = (state: SharedSessionState): SessionStatesView => ({ state: () => ({ state }), reply: () => undefined, host: () => undefined });

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
    [['idle', 'starting'], 'running'],
    [['idle', 'running', 'failed'], 'failed'],
    [['idle', 'running', 'unknown'], 'running'],
    [['idle', 'unknown', 'offline'], 'idle'],
    [['unknown', 'offline', 'closed'], undefined],
    [[], undefined],
  ] as const)('ranks %j as %s', (statuses, expected) => {
    expect(windowActivity(statuses)).toBe(expected);
  });
});

it('groups statuses as Track filters them', () => {
  const group = (status: string) => activityGroups.find(item => item.activities.includes(status as never))?.label;
  expect(['running', 'waiting', 'starting', 'idle', 'failed', 'offline', 'unknown'].map(group))
    .toEqual(['Working', 'Pending', 'Pending', 'Idle', 'Failed', 'Host offline', 'Status unavailable']);
});
