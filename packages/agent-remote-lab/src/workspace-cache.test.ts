import { expect, it, vi } from 'vitest';
import { readWorkspaceSnapshot, saveWorkspaceSnapshot, workspaceDisplayState } from './workspace-cache.js';
import { replicaState } from './test/fixtures.js';
import { clearConversationRecovery } from './conversation-recovery.js';
import { conversationLocalStorage } from './conversation-storage.js';
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
  saveWorkspaceSnapshot(scope, target, replicaState);
  expect(readWorkspaceSnapshot(scope, target)?.agent?.id).toBe('agent-1');
});
it('retains recent sessions independently and evicts the oldest beyond the count limit', () => {
  for (let index = 0; index < 7; index++) {
    const nativeSessionId = `session-${index}`;
    saveWorkspaceSnapshot(scope, { ...target, nativeSessionId }, { ...replicaState,
      agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: nativeSessionId } } });
  }
  expect(readWorkspaceSnapshot(scope, { ...target, nativeSessionId: 'session-0' })).toBeUndefined();
  for (let index = 1; index < 7; index++) expect(readWorkspaceSnapshot(scope, { ...target, nativeSessionId: `session-${index}` })?.agent?.runtimeInfo.sessionId).toBe(`session-${index}`);
  clearConversationRecovery(scope);
  expect(Object.keys(localStorage).filter(key => key.startsWith(`agent-remote:recovery:${scope}:workspace`))).toEqual([]);
});
it('bounds the combined display snapshots and preserves the newest content', () => {
  for (let index = 0; index < 6; index++) {
    const nativeSessionId = `session-${index}`;
    saveWorkspaceSnapshot(scope, { ...target, nativeSessionId }, { ...replicaState,
      agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: nativeSessionId } },
      timeline: { ...replicaState.timeline, entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, turnId: 'turn', timestamp: '2026-10-11T00:00:00.000Z',
        resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
        item: { type: 'assistant_message', text: 'large message '.repeat(30_000) } }] } });
  }
  const keys = Object.keys(localStorage).filter(key => key.startsWith(`agent-remote:recovery:${scope}:workspace:`));
  expect(keys.reduce((sum, key) => sum + localStorage.getItem(key)!.length, 0)).toBeLessThanOrEqual(1_500_000);
  expect(readWorkspaceSnapshot(scope, { ...target, nativeSessionId: 'session-5' })).toBeDefined();
});
it('never labels a different native session or provider snapshot as the requested display', () => {
  saveWorkspaceSnapshot(scope, target, { ...replicaState,
    agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'other' } } });
  expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
  saveWorkspaceSnapshot(scope, target, { ...replicaState,
    agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: 'codex' } } });
  expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
});
it('keeps preview content without carrying live control authority or recovery cursors', () => {
  const live = { ...replicaState, resources: { picture: { status: 'available' as const, sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: 5, contentBase64: 'aW1hZ2U=' } }, sessionControl: { access: 'control' as const, available: true },
    outgoingMessages: [{ id: 'out', agentId: 'agent-1', text: 'no replay', status: 'sending' as const, epoch: null, afterSeq: 0 }] };
  const display = workspaceDisplayState(live);
  expect(display.timeline.entries).toBe(live.timeline.entries);
  expect(display.timeline.nextSeq).toBe(0);
  expect(display.sessionControl).toBeUndefined();
  expect(display.outgoingMessages).toEqual([]);
  expect(display.pendingInteractions).toEqual([]);
  expect(display.resources).toBe(live.resources);
  expect(workspaceDisplayState(live)).toBe(display);
});
it('retains the previous single-session snapshot when another session is cached after an upgrade', () => {
  saveWorkspaceSnapshot(scope, target, replicaState);
  const index = JSON.parse(localStorage.getItem(`agent-remote:recovery:${scope}:workspace`)!);
  const dataKey = `agent-remote:recovery:${scope}:workspace:${encodeURIComponent(index.snapshots[0].identity)}`;
  const legacy = localStorage.getItem(dataKey)!;
  localStorage.removeItem(dataKey);
  localStorage.setItem(`agent-remote:recovery:${scope}:workspace`, legacy);
  const other = { ...target, nativeSessionId: 'other' };
  saveWorkspaceSnapshot(scope, other, { ...replicaState,
    agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'other' } } });
  expect(readWorkspaceSnapshot(scope, target)?.agent?.runtimeInfo.sessionId).toBe(target.nativeSessionId);
  expect(readWorkspaceSnapshot(scope, other)?.agent?.runtimeInfo.sessionId).toBe('other');
});
it('removes abandoned snapshot bodies without touching drafts or another account cache', () => {
  saveWorkspaceSnapshot(scope, target, replicaState);
  const prefix = `agent-remote:recovery:${scope}:workspace`;
  const otherKey = `agent-remote:recovery:other:workspace:retained`;
  localStorage.setItem(`${prefix}:abandoned-tab-write`, 'orphan');
  localStorage.setItem(`${prefix}:failed-index-write`, 'orphan');
  localStorage.setItem(`${prefix.replace(':workspace', ':drafts')}`, 'draft text');
  localStorage.setItem(otherKey, 'other account snapshot');
  saveWorkspaceSnapshot(scope, target, replicaState);
  expect(Object.keys(localStorage).filter(key => key.startsWith(`${prefix}:`))).toHaveLength(1);
  expect(localStorage.getItem(prefix.replace(':workspace', ':drafts'))).toBe('draft text');
  expect(localStorage.getItem(otherKey)).toBe('other account snapshot');
});
it('cleans a newly written body when its index write fails and keeps the previous snapshot', () => {
  saveWorkspaceSnapshot(scope, target, replicaState);
  const prefix = `agent-remote:recovery:${scope}:workspace`;
  const write = conversationLocalStorage.setItem.bind(conversationLocalStorage);
  const spy = vi.spyOn(conversationLocalStorage, 'setItem').mockImplementation((key, value) => {
    if (key === prefix) throw new DOMException('Full', 'QuotaExceededError');
    write(key, value);
  });
  try {
    saveWorkspaceSnapshot(scope, { ...target, nativeSessionId: 'failed' }, { ...replicaState,
      agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'failed' } } });
  } finally { spy.mockRestore(); }
  expect(Object.keys(localStorage).filter(key => key.startsWith(`${prefix}:`))).toHaveLength(1);
  expect(readWorkspaceSnapshot(scope, target)?.agent?.runtimeInfo.sessionId).toBe(target.nativeSessionId);
  expect(readWorkspaceSnapshot(scope, { ...target, nativeSessionId: 'failed' })).toBeUndefined();
});
it('bounds storage inventory scans independently of the number of saved conversation keys', () => {
  for (let index = 0; index < 200; index++) localStorage.setItem(`agent-remote:recovery:other:outbox:${index}`, 'retained');
  saveWorkspaceSnapshot(scope, target, replicaState);
  const keys = Object.keys;
  let inventories = 0;
  const spy = vi.spyOn(Object, 'keys').mockImplementation(value => {
    if (value === localStorage) inventories++;
    return keys(value);
  });
  try { saveWorkspaceSnapshot(scope, target, replicaState); }
  finally { spy.mockRestore(); }
  expect(inventories).toBeLessThanOrEqual(2);
  expect(readWorkspaceSnapshot(scope, target)?.agent?.id).toBe(replicaState.agent?.id);
  expect(localStorage.getItem('agent-remote:recovery:other:outbox:199')).toBe('retained');
});
