import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentReplica } from '@orchardworks/agent-client';
import { deviceStore } from '@orchardworks/agent-client/device-store';
import { clearConversationRecovery } from './conversation-recovery.js';
import { conversationLocalStorage } from './conversation-storage.js';
import { removeLegacyDisplayCache } from '../device-store-start.js';
import { forgetStoredSession, loadStoredDisplay, readStoredDisplay, restoreReplicaFromDevice, saveStoredDisplay } from './stored-display.js';
import { replicaState } from '../test/fixtures.js';
import { confirmWorkspaceAccess, readStoredLease, rememberWorkspaceAccess, retireWorkspace, revokeStoredRows, setWorkspaceReady, storedRowsRelay, subscribeStoredRows } from './workspace-access.js';

const hash = (letter: string) => letter.repeat(64);
const base = (letter: string) => new URL(`/u/${hash(letter)}/`, window.location.origin).href;
const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', agentId: 'agent-1' };
const sentence = (display: ReturnType<typeof readStoredDisplay>) => display?.timeline.entries.map(entry => entry.item).filter(item => item.type === 'assistant_message').map(item => item.text).join('');

beforeEach(async () => { await deviceStore.purge(); });
afterEach(async () => { vi.restoreAllMocks(); await deviceStore.purge(); localStorage.clear(); });

it('shows no stored row before a lease was granted on this device, and shows them while one is held, confirmed or not', () => {
  const scope = base('a');
  setWorkspaceReady(scope, false);
  expect(storedRowsRelay(scope)).toBeUndefined();
  setWorkspaceReady(scope, true);
  saveStoredDisplay(scope, target, replicaState);
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
  expect(readStoredDisplay(scope, target)?.timeline.restoredFromDevice).toBe(true);
  // The page is paused or the Relay cannot be reached: what the device stores still shows.
  setWorkspaceReady(scope, false);
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
  // The local copy of the lease ran out and the Relay is asked: the rows stay while it answers.
  setWorkspaceReady(scope, true);
  confirmWorkspaceAccess(scope);
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
  retireWorkspace(scope);
  expect(readStoredDisplay(scope, target)).toBeUndefined();
});

it('seeds a replica from the device on a cached lease, and not before any lease was granted', () => {
  const scope = base('b');
  setWorkspaceReady(scope, true);
  saveStoredDisplay(scope, target, replicaState);
  setWorkspaceReady(scope, true); revokeStoredRows(scope);
  const replica = new AgentReplica();
  restoreReplicaFromDevice(scope, target, replica);
  expect(replica.getState().timeline.initialized).toBe(false);
  setWorkspaceReady(scope, false, true);
  restoreReplicaFromDevice(scope, target, replica);
  expect(replica.getState().timeline).toMatchObject({ initialized: true, restoredFromDevice: true });
});



it('leaves no record and no old localStorage key after a sign-out', async () => {
  const scope = base('e');
  setWorkspaceReady(scope, true);
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
  setWorkspaceReady(scope, true);
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
  setWorkspaceReady(scope, true);
  saveStoredDisplay(scope, target, replicaState);
  expect(readStoredDisplay(scope, { ...target, providerId: 'other-provider' })).toBeUndefined();
  expect(sentence(readStoredDisplay(scope, target))).toBe(sentence(replicaState as never));
});

it('stores nothing from a replica that is still waiting for a replacement or came from the device', () => {
  const scope = base('3');
  setWorkspaceReady(scope, true);
  const waiting = { ...replicaState, timeline: { ...replicaState.timeline, pendingEpoch: 'next' } };
  saveStoredDisplay(scope, target, waiting);
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  saveStoredDisplay(scope, target, { ...replicaState, timeline: { ...replicaState.timeline, restoredFromDevice: true as const } });
  expect(readStoredDisplay(scope, target)).toBeUndefined();
});

it('keeps memory copies only while Clear cache on close is on, and removes the disk copies when it is turned on', async () => {
  const { setClearCacheOnClose } = await import('./conversation-storage.js');
  const scope = base('4');
  setWorkspaceReady(scope, true);
  saveStoredDisplay(scope, target, replicaState);
  await deviceStore.flush();
  const onDisk = async () => new Promise<number>((resolve, reject) => {
    const opening = indexedDB.open('agent-remote-image-drafts');
    opening.onsuccess = () => { const transaction = opening.result.transaction('sessions', 'readonly'); const count = transaction.objectStore('sessions').count();
      transaction.oncomplete = () => { opening.result.close(); resolve(count.result); }; };
    opening.onerror = () => reject(opening.error);
  });
  expect(await onDisk()).toBe(1);
  await setClearCacheOnClose(true);
  try {
    expect(await onDisk()).toBe(0);
    expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
    saveStoredDisplay(scope, { ...target, nativeSessionId: 'second' }, { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'second' } } });
    await deviceStore.flush();
    expect(await onDisk()).toBe(0);
  } finally { await setClearCacheOnClose(false); }
});

it('shows stored rows on a cached lease for as long as the Relay has not refused it, however long ago it ended', () => {
  const scope = base('5');
  setWorkspaceReady(scope, true);
  saveStoredDisplay(scope, target, replicaState);
  revokeStoredRows(scope);
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  // A new page load offline: the device holds the lease it cached, which may have ended.
  setWorkspaceReady(scope, false, true);
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
});

it('clears the rows shown on a cached lease at once when the Relay refuses it, and tells every reader', () => {
  const scope = base('6');
  setWorkspaceReady(scope, true);
  saveStoredDisplay(scope, target, replicaState);
  setWorkspaceReady(scope, false, true);
  const heard = vi.fn();
  const stop = subscribeStoredRows(scope, heard);
  expect(readStoredDisplay(scope, target)).toBeDefined();
  revokeStoredRows(scope);
  expect(heard).toHaveBeenCalled();
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  stop();
});


it('shows another Relay URL, which is another person, none of these rows', async () => {
  const mine = base('8'), theirs = base('9');
  setWorkspaceReady(mine, true);
  saveStoredDisplay(mine, target, replicaState);
  await deviceStore.flush();
  setWorkspaceReady(theirs, true);
  expect(readStoredDisplay(theirs, target)).toBeUndefined();
  expect(await loadStoredDisplay(theirs, target)).toBeUndefined();
  expect(readStoredDisplay(mine, target)?.agent?.id).toBe('agent-1');
});

it('reads the stored lease with the access it was granted for', () => {
  rememberWorkspaceAccess({ basePath: '/u/' + 'a'.repeat(64) + '/', user: { id: 'alice' }, expiresAt: 5_000 });
  expect(readStoredLease()).toBe(5_000);
  localStorage.removeItem('agent-remote:workspace-access');
  expect(readStoredLease()).toBeUndefined();
});
