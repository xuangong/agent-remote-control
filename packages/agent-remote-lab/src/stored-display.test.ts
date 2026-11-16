import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import { deviceStore } from '@orchardworks/agent-remote-web/device-store';
import { clearConversationRecovery } from './conversation-recovery.js';
import { conversationLocalStorage } from './conversation-storage.js';
import { removeLegacyDisplayCache, startDeviceStore } from './device-store-start.js';
import { forgetStoredSession, loadStoredDisplay, readStoredDisplay, restoreReplicaFromDevice, saveStoredDisplay } from './stored-display.js';
import { replicaState } from './test/fixtures.js';
import { confirmWorkspaceAccess, retireWorkspace, setWorkspaceReady, storedRowsScope } from './workspace-access.js';

const hash = (letter: string) => letter.repeat(64);
const base = (letter: string) => new URL(`/u/${hash(letter)}/`, window.location.origin).href;
const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', agentId: 'agent-1' };
const sentence = (display: ReturnType<typeof readStoredDisplay>) => display?.timeline.entries.map(entry => entry.item).filter(item => item.type === 'assistant_message').map(item => item.text).join('');

beforeEach(async () => { await deviceStore.purge(); });
afterEach(async () => { vi.restoreAllMocks(); await deviceStore.purge(); localStorage.clear(); });

it('shows no stored row before the Relay confirms the lease, only while it is confirmed, and none again when it must be confirmed anew', () => {
  const scope = base('a');
  setWorkspaceReady(scope, true, 'alice');
  saveStoredDisplay(scope, target, replicaState);
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
  expect(readStoredDisplay(scope, target)?.timeline.restoredFromDevice).toBe(true);
  // The page starts again: the access is cached for display, the lease is not confirmed.
  setWorkspaceReady(scope, false, 'alice');
  expect(storedRowsScope(scope)).toBeUndefined();
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  setWorkspaceReady(scope, true, 'alice');
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
  // The local copy of the lease ran out and the Relay is asked: stored rows hide until it answers.
  confirmWorkspaceAccess(scope);
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  setWorkspaceReady(scope, true, 'alice');
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
  retireWorkspace(scope);
  expect(readStoredDisplay(scope, target)).toBeUndefined();
});

it('does not seed a replica while the lease is not confirmed', () => {
  const scope = base('b');
  setWorkspaceReady(scope, true, 'alice');
  saveStoredDisplay(scope, target, replicaState);
  setWorkspaceReady(scope, false, 'alice');
  const replica = new AgentReplica();
  restoreReplicaFromDevice(scope, target, replica);
  expect(replica.getState().timeline.initialized).toBe(false);
  setWorkspaceReady(scope, true, 'alice');
  restoreReplicaFromDevice(scope, target, replica);
  expect(replica.getState().timeline).toMatchObject({ initialized: true, restoredFromDevice: true });
});

it('keeps a record of one principal from another principal on the same Relay URL', async () => {
  const scope = base('c');
  setWorkspaceReady(scope, true, 'alice');
  saveStoredDisplay(scope, target, replicaState);
  await deviceStore.flush();
  setWorkspaceReady(scope, true, 'bob');
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  expect(await loadStoredDisplay(scope, target)).toBeUndefined();
  saveStoredDisplay(scope, target, { ...replicaState, timeline: { ...replicaState.timeline, entries: [] } });
  setWorkspaceReady(scope, true, 'alice');
  expect(readStoredDisplay(scope, target)?.timeline.entries).toEqual(replicaState.timeline.entries);
});

it('removes the records of another principal when the page starts for this one', async () => {
  const scope = base('d');
  setWorkspaceReady(scope, true, 'alice');
  saveStoredDisplay(scope, target, replicaState);
  await deviceStore.flush();
  localStorage.setItem('agent-remote:workspace-access', JSON.stringify({ confirmedAt: Date.now(), access: { basePath: new URL(scope).pathname, user: { id: 'bob' }, expiresAt: 0 } }));
  await startDeviceStore(true);
  setWorkspaceReady(scope, true, 'alice');
  // The page started for bob: what alice stored on this Relay is gone from memory and disk.
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  expect(await loadStoredDisplay(scope, target)).toBeUndefined();
});

it('leaves no record and no old localStorage key after a sign-out', async () => {
  const scope = base('e');
  setWorkspaceReady(scope, true, 'alice');
  saveStoredDisplay(scope, target, replicaState);
  await deviceStore.flush();
  conversationLocalStorage.setItem(`agent-remote:recovery:${scope}:workspace`, '{"version":2}');
  conversationLocalStorage.setItem(`agent-remote:recovery:${scope}:workspace:%5B%22host%22%5D`, '{}');
  clearConversationRecovery(scope);
  await vi.waitFor(async () => { expect(await loadStoredDisplay(scope, target)).toBeUndefined(); });
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  removeLegacyDisplayCache();
  expect(Object.keys(localStorage).filter(key => key.includes(':workspace:') || key.endsWith(':workspace'))).toEqual([]);
});

it('removes the old localStorage display cache once at start and nothing else of the recovery state', () => {
  const scope = base('f');
  conversationLocalStorage.setItem(`agent-remote:recovery:${scope}:workspace`, '{}');
  conversationLocalStorage.setItem(`agent-remote:recovery:${scope}:workspace:%5B%22h%22%2C%22p%22%2C%22n%22%5D`, '{}');
  conversationLocalStorage.setItem(`agent-remote:recovery:${scope}:session`, '/?host=h');
  conversationLocalStorage.setItem(`agent-remote:recovery:${scope}:reading`, '[]');
  removeLegacyDisplayCache();
  expect(conversationLocalStorage.getItem(`agent-remote:recovery:${scope}:workspace`)).toBeNull();
  expect(conversationLocalStorage.getItem(`agent-remote:recovery:${scope}:workspace:%5B%22h%22%2C%22p%22%2C%22n%22%5D`)).toBeNull();
  expect(conversationLocalStorage.getItem(`agent-remote:recovery:${scope}:session`)).toBe('/?host=h');
  expect(conversationLocalStorage.getItem(`agent-remote:recovery:${scope}:reading`)).toBe('[]');
});

it('forgets the record of a conversation the person lost access to', async () => {
  const scope = base('1');
  setWorkspaceReady(scope, true, 'alice');
  saveStoredDisplay(scope, target, replicaState);
  saveStoredDisplay(scope, { ...target, nativeSessionId: 'other' }, { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'other' } } });
  forgetStoredSession(scope, target);
  await deviceStore.flush();
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  expect(await loadStoredDisplay(scope, target)).toBeUndefined();
  expect(readStoredDisplay(scope, { ...target, nativeSessionId: 'other' })?.agent?.runtimeInfo.sessionId).toBe('other');
});

it('never shows rows of another session from a record: the identity inside must match the target', async () => {
  const scope = base('2');
  setWorkspaceReady(scope, true, 'alice');
  saveStoredDisplay(scope, target, replicaState);
  expect(readStoredDisplay(scope, { ...target, providerId: 'other-provider' })).toBeUndefined();
  expect(sentence(readStoredDisplay(scope, target))).toBe(sentence(replicaState as never));
});

it('stores nothing from a replica that is still waiting for a replacement or came from the device', () => {
  const scope = base('3');
  setWorkspaceReady(scope, true, 'alice');
  const waiting = { ...replicaState, timeline: { ...replicaState.timeline, pendingEpoch: 'next' } };
  saveStoredDisplay(scope, target, waiting);
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  saveStoredDisplay(scope, target, { ...replicaState, timeline: { ...replicaState.timeline, restoredFromDevice: true as const } });
  expect(readStoredDisplay(scope, target)).toBeUndefined();
});
