import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildSessionIdentity, buildStoredRecord } from '@orchardworks/agent-client/testing';
import { deviceStore } from '@orchardworks/agent-client/device-store';
import { readImageDraft, writeImageDraft, type ImageDraft } from '@orchardworks/agent-client-web/browser';
import { clearConversationRecovery, readDrafts, saveDrafts } from './conversation-recovery.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { cacheProtectionState, clearCacheOnClose, setClearCacheOnClose } from './conversation-storage.js';

const relay = 'https://relay.example/u/a/';
const preference = 'agent-remote:clear-cache-on-close';
const imageDraft: ImageDraft = { version: 1, key: JSON.stringify(['scope', 'native-session']), scope: 'scope', parts: [{ type: 'text', text: 'caption ' }, { type: 'image', imageId: 'one', label: 'image #1' }],
  images: { one: { imageId: 'one', blob: new NativeBlob(['image bytes'], { type: 'image/png' }) as Blob, uploadId: 'upload', status: 'pending', progress: 0 } }, nextLabel: 2 };

/** What the device store and the image drafts hold in the one IndexedDB database of the device. */
async function diskCounts(): Promise<Record<string, number>> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open('agent-remote-image-drafts'); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
  try {
    const names = [...database.objectStoreNames], transaction = database.transaction(names), counts: Record<string, number> = {};
    for (const name of names) transaction.objectStore(name).count().onsuccess = event => { counts[name] = (event.target as IDBRequest<number>).result; };
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    return counts;
  } finally { database.close(); }
}
const stored = () => buildStoredRecord({ relayUrl: relay, nativeSessionId: 'one', updatedAt: 1, rows: 2 });
/** A conversation, an unsent draft with an image and a recovery record, as a page that has run for a while holds them. */
async function fillDevice() {
  deviceStore.put(stored()); await deviceStore.flush();
  await writeImageDraft(imageDraft);
  saveDrafts('relay', { agent: 'unsent text' }); flushRecoveryWrites();
  const before = await diskCounts();
  expect(before.sessions).toBe(1); expect(before.drafts).toBe(1); expect(before.images).toBe(1);
  expect(sessionStorage.getItem('agent-remote:recovery:relay:drafts')).toContain('unsent text');
}
const expectEmptyDisk = async () => {
  expect(Object.values(await diskCounts()).every(count => count === 0)).toBe(true);
  expect(sessionStorage.getItem('agent-remote:recovery:relay:drafts')).toBeNull();
};
/** The page still holds what it showed: the conversation, the image draft and the text draft. */
async function expectPageKeepsItsDrafts() {
  expect(deviceStore.read(relay, buildSessionIdentity('one'))).toBeDefined();
  expect((await readImageDraft(imageDraft.key))?.parts).toEqual(imageDraft.parts);
  expect(readDrafts('relay')).toEqual({ agent: 'unsent text' });
}

beforeEach(async () => { await deviceStore.purge(); });
afterEach(async () => { clearConversationRecovery(); await setClearCacheOnClose(false); await deviceStore.purge(); localStorage.clear(); sessionStorage.clear(); });

it('empties the device store, the text and image drafts and the recovery records when protection is confirmed, and the page keeps them in memory', async () => {
  await fillDevice();
  await setClearCacheOnClose(true);
  await expectEmptyDisk();
  await expectPageKeepsItsDrafts();
  deviceStore.put(buildStoredRecord({ relayUrl: relay, nativeSessionId: 'two', updatedAt: 2, rows: 1 })); await deviceStore.flush();
  saveDrafts('relay', { agent: 'typed under protection' }); flushRecoveryWrites();
  await expectEmptyDisk();
  expect(readDrafts('relay')).toEqual({ agent: 'typed under protection' });
});

it('empties this tab\'s copies when another tab turns protection on, which reaches it as a storage event, and keeps what the tab shows', async () => {
  await fillDevice();
  localStorage.setItem(preference, 'true');
  window.dispatchEvent(new StorageEvent('storage', { key: preference, newValue: 'true' }));
  await expect.poll(() => cacheProtectionState()).toEqual({ enabled: true, clearing: false, failed: false });
  await expectEmptyDisk();
  await expectPageKeepsItsDrafts();
  expect(clearCacheOnClose()).toBe(true);
});

it('empties this tab\'s copies when the page is shown again after another tab turned protection on while it was suspended', async () => {
  await fillDevice();
  localStorage.setItem(preference, 'true');
  window.dispatchEvent(new Event('pageshow'));
  await expect.poll(() => cacheProtectionState()).toEqual({ enabled: true, clearing: false, failed: false });
  await expectEmptyDisk();
  await expectPageKeepsItsDrafts();
});
