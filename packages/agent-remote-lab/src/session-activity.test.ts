import { expect, it } from 'vitest';
import { sessionActivity } from './session-activity.js';
import { replicaState } from './test/fixtures.js';

const activeTurn = { turnId: 'turn', startedAt: '2026-09-18T00:00:00Z' };
const pendingInteractions = [{ kind: 'plan_approval' as const, requestId: 'review', plan: 'Review plan', allowedActions: ['approve' as const] }];

it('prioritizes pending input over an active turn and restores working after the response', () => {
  const running = { ...replicaState, agent: { ...replicaState.agent!, status: 'running' as const, activeTurn } };
  expect(sessionActivity({ ...running, pendingInteractions })).toBe('waiting');
  expect(sessionActivity(running)).toBe('running');
  expect(sessionActivity(replicaState)).toBe('idle');
});

it('recognizes active turns before the status update without overriding terminal states', () => {
  expect(sessionActivity({ ...replicaState, agent: { ...replicaState.agent!, activeTurn } })).toBe('running');
  for (const status of ['closed', 'failed'] as const) {
    expect(sessionActivity({ ...replicaState, pendingInteractions, agent: { ...replicaState.agent!, status, activeTurn } })).toBe(status);
  }
  expect(sessionActivity()).toBeUndefined();
});
