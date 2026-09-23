import { expect, it } from 'vitest';
import { readWorkspaceSnapshot, saveWorkspaceSnapshot } from './workspace-cache.js';
import { replicaState } from './test/fixtures.js';
import { clearConversationRecovery } from './conversation-recovery.js';
const scope = 'https://agents.example/u/alice/';
const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', agentId: 'agent-1' };
it('restores only display data for the exact account and native session', () => {
  saveWorkspaceSnapshot(scope, target, replicaState);
  expect(readWorkspaceSnapshot(scope, target)?.agent?.id).toBe('agent-1');
  expect(readWorkspaceSnapshot(scope, { ...target, hostId: 'other' })).toBeUndefined();
  expect(readWorkspaceSnapshot(scope + 'other', target)).toBeUndefined();
  clearConversationRecovery(scope);
  expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
});
it('does not restore pending actions, resources or delivery state from display storage', () => {
  saveWorkspaceSnapshot(scope, target, { ...replicaState, outgoingMessages: [{ id: 'out', agentId: 'agent-1', text: 'no replay', status: 'sending', epoch: null, afterSeq: 0 }], resources: { secret: {} as never } });
  const restored = readWorkspaceSnapshot(scope, target)!;
  expect(restored.outgoingMessages).toEqual([]);
  expect(restored.pendingInteractions).toEqual([]);
  expect(restored.resources).toEqual({});
  expect(restored.timeline.entries).toEqual(replicaState.timeline.entries);
});
it('ignores malformed or excessively large cached data', () => {
  saveWorkspaceSnapshot(scope, target, replicaState);
  const key = Object.keys(localStorage).find(key => key.endsWith(':workspace'))!;
  localStorage.setItem(key, '{broken');
  expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
});
