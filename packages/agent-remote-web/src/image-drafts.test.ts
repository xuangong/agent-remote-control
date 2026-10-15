import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { cacheDraftImage, clearImageDraftScope, imageDraftScopeGeneration, lookupDraftImage, readImageDraft, writeImageDraft, type ImageDraft } from './image-drafts.js';
import * as draftStorage from './image-drafts.js';

async function storedDraft(key: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('agent-remote-image-drafts', 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{ draft: ImageDraft | undefined; images: unknown[] }>((resolve, reject) => {
      const tx = db.transaction(['drafts', 'images'], 'readonly');
      const metadata = tx.objectStore('drafts').get(key), images = tx.objectStore('images').getAll();
      tx.oncomplete = () => resolve({ draft: metadata.result, images: images.result.filter(image => JSON.parse(image.key)[0] === key) });
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

it('releases only the exact draft and its bytes, preserving restored copies and other scopes', async () => {
  const saved = draft('exact-release'), copied = { ...saved, key: 'restored-composer' }, other = draft('release-neighbor');
  await writeImageDraft(saved); await writeImageDraft(copied); await writeImageDraft(other);
  await draftStorage.releaseImageDraft({ scope: saved.scope, key: saved.key });
  expect(await storedDraft(saved.key)).toEqual({ draft: undefined, images: [] });
  expect(await readImageDraft(saved.key)).toBeUndefined();
  expect((await storedDraft(copied.key)).images).toHaveLength(1);
  expect((await storedDraft(other.key)).images).toHaveLength(1);
  await expect(draftStorage.releaseImageDraft({ scope: 'wrong-scope', key: copied.key })).rejects.toThrow(/scope/);
  expect((await storedDraft(copied.key)).images).toHaveLength(1);
}, 5000);

it('waits for an already-started write before releasing its exact key', async () => {
  const saved = draft('release-in-flight');
  let finish!: (bytes: ArrayBuffer) => void;
  const convert = vi.spyOn(saved.images[saved.scope]!.blob!, 'arrayBuffer').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  try {
    const pending = writeImageDraft(saved);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const released = draftStorage.releaseImageDraft({ scope: saved.scope, key: saved.key });
    finish(new TextEncoder().encode('image bytes').buffer);
    await pending; await released;
    expect(await storedDraft(saved.key)).toEqual({ draft: undefined, images: [] });
  } finally { convert.mockRestore(); }
}, 5000);

it('refuses to release an editor-owned key and preserves an aborted deletion for retry', async () => {
  const saved = draft('release-retry'); await writeImageDraft(saved);
  const unregister = draftStorage.registerImageDraftWriter(saved, {
    snapshot: () => ({ status: 'ready', revision: 0, savedRevision: 0, retention: 'local', draft: saved }),
    flush: async () => ({ status: 'ready', revision: 0, savedRevision: 0, retention: 'local', draft: saved }),
  });
  await expect(draftStorage.releaseImageDraft(saved)).rejects.toThrow(/editor/);
  unregister(); await draftStorage.flushReleasedImageDraftWriters(saved);
  const remove = IDBObjectStore.prototype.delete;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === 'images') throw new Error('Delete unavailable');
    return remove.call(this, key);
  });
  try { await expect(draftStorage.releaseImageDraft(saved)).rejects.toThrow(/Delete unavailable/); }
  finally { fail.mockRestore(); }
  expect((await storedDraft(saved.key)).images).toHaveLength(1);
  expect((await readImageDraft(saved.key))?.parts).toEqual(saved.parts);
  await draftStorage.releaseImageDraft(saved);
  expect(await storedDraft(saved.key)).toEqual({ draft: undefined, images: [] });
}, 5000);

it('fences a queued release when scope cleanup retires the snapshot before a new draft is saved', async () => {
  const saved = draft('release-scope-change');
  let finish!: (bytes: ArrayBuffer) => void;
  const convert = vi.spyOn(saved.images[saved.scope]!.blob!, 'arrayBuffer').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  try {
    const pending = writeImageDraft(saved);
    const release = draftStorage.releaseImageDraft(saved);
    const rejected = expect(release).rejects.toThrow(/scope changed/);
    await clearImageDraftScope(saved.scope);
    const replacement = writeImageDraft({ ...saved, parts: [{ type: 'text', text: 'new scope draft' }], images: {} });
    finish(new ArrayBuffer(11));
    await pending; await rejected; await replacement;
    expect((await storedDraft(saved.key)).draft?.parts).toEqual([{ type: 'text', text: 'new scope draft' }]);
  } finally { convert.mockRestore(); }
}, 5000);

it('aborts snapshot release when a new editor claims its key before deletion commits', async () => {
  const saved = draft('release-new-editor'); await writeImageDraft(saved);
  let unregister: (() => void) | undefined;
  const remove = IDBObjectStore.prototype.delete;
  const claim = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    const request = remove.call(this, key);
    if (key === saved.key) unregister = draftStorage.registerImageDraftWriter(saved, {
      snapshot: () => ({ status: 'ready', revision: 0, savedRevision: 0, retention: 'local', draft: saved }),
      flush: async () => ({ status: 'ready', revision: 0, savedRevision: 0, retention: 'local', draft: saved }),
    });
    return request;
  });
  try { await expect(draftStorage.releaseImageDraft(saved)).rejects.toThrow(); }
  finally { claim.mockRestore(); unregister?.(); await draftStorage.flushReleasedImageDraftWriters(saved); }
  expect((await storedDraft(saved.key)).images).toHaveLength(1);
  expect((await storedDraft(saved.key)).draft?.parts).toEqual(saved.parts);
}, 5000);

function draft(scope: string): ImageDraft {
  return { version: 1, key: JSON.stringify([scope, 'native-session']), scope, parts: [{ type: 'text', text: 'before ' }, { type: 'image', imageId: scope, label: 'image #4' }, { type: 'text', text: ' after' }],
    images: { [scope]: { imageId: scope, blob: new NativeBlob(['image bytes'], { type: 'image/png' }) as Blob, uploadId: 'upload', status: 'pending', progress: 0 } }, nextLabel: 5 };
}
it('round-trips ordered draft metadata and blobs through IndexedDB', async () => {
  const saved = draft('roundtrip');
  await writeImageDraft(saved);
  const restored = await readImageDraft(saved.key);
  expect(restored?.parts).toEqual(saved.parts);
  expect(restored?.nextLabel).toBe(5);
  expect(restored?.images.roundtrip?.blob?.size).toBe(11);
  const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(restored!.images.roundtrip!.blob!); });
  expect(text).toBe('image bytes');
});
it('signout revokes old writes and local clipboard blobs only for the selected scope', async () => {
  const first = draft('account-one'); const second = draft('account-two');
  const generation = imageDraftScopeGeneration(first.scope);
  cacheDraftImage(first.scope, first.scope, first.images[first.scope]!.blob!, generation);
  cacheDraftImage(second.scope, second.scope, second.images[second.scope]!.blob!, imageDraftScopeGeneration(second.scope));
  await writeImageDraft(first); await writeImageDraft(second);
  const clear = clearImageDraftScope(first.scope);
  await writeImageDraft(first, generation);
  await clear;
  expect(await readImageDraft(first.key)).toBeUndefined();
  expect((await readImageDraft(second.key))?.parts).toEqual(second.parts);
  expect(lookupDraftImage(first.scope, first.scope)).toBeUndefined();
  expect(lookupDraftImage(second.scope, second.scope)).toBeDefined();
  expect(lookupDraftImage(first.scope, second.scope)).toBeUndefined();
  await writeImageDraft(first, generation);
  expect(await readImageDraft(first.key)).toBeUndefined();
});

it('stores portable image bytes once and never asks IndexedDB to prepare a Blob', async () => {
  const saved = draft('portable-binary');
  const convert = vi.spyOn(saved.images[saved.scope]!.blob!, 'arrayBuffer');
  const original = IDBObjectStore.prototype.put;
  let imageWrites = 0;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'images') {
      expect(value.blob).toBeUndefined();
      expect(value.blobBytes.byteLength).toBe(11);
      imageWrites++;
    }
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  try {
    await writeImageDraft(saved);
    saved.parts.push({ type: 'text', text: ' more' });
    await writeImageDraft(saved);
    const restored = await readImageDraft(saved.key);
    expect(restored?.parts).toEqual(saved.parts);
    expect(restored?.images[saved.scope]?.blob?.size).toBe(11);
    expect(restored?.images[saved.scope]?.blob?.type).toBe('image/png');
    expect(convert).toHaveBeenCalledTimes(1);
    expect(imageWrites).toBe(1);
  } finally { put.mockRestore(); convert.mockRestore(); }
});


it('aborts metadata with failed image bytes and permits a later retry', async () => {
  const saved = draft('atomic-write');
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'images') {
      original.call(this, { key: 'duplicate' });
      return this.add({ key: 'duplicate' });
    }
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  try {
    await expect(writeImageDraft(saved)).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readImageDraft(saved.key)).toBeUndefined();
  } finally { put.mockRestore(); }
  await writeImageDraft(saved);
  expect((await readImageDraft(saved.key))?.parts).toEqual(saved.parts);
});

it('does not persist image bytes for removed tags while retaining them for undo in memory', async () => {
  const saved = draft('removed-images');
  saved.parts = [{ type: 'text', text: 'Images already sent' }];
  await writeImageDraft(saved);
  const restored = await readImageDraft(saved.key);
  expect(restored?.images).toEqual({});
  expect(saved.images['removed-images']?.blob).toBeDefined();
});

it('updates text metadata without rewriting retained image bytes', async () => {
  const saved = draft('metadata-only');
  await writeImageDraft(saved);
  let bytes = 0;
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (value.blob || value.blobBytes || Object.values(value.images ?? {}).some((image: any) => image.blob || image.blobBytes)) bytes++;
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  try {
    saved.parts.push({ type: 'text', text: ' a later caption' });
    await writeImageDraft(saved);
    expect((await readImageDraft(saved.key))?.parts).toEqual(saved.parts);
    expect((await readImageDraft(saved.key))?.images['metadata-only']?.blob?.size).toBe(11);
    expect(bytes).toBe(0);
  } finally { put.mockRestore(); }
});

it('bounds unowned clipboard images while preserving an editor-owned image', async () => {
  const { retainDraftImages } = await import('./image-drafts.js');
  const scope = 'cache-budget';
  const owner = {};
  const blob = new NativeBlob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' }) as Blob;
  cacheDraftImage(scope, 'protected', blob, 0);
  retainDraftImages(owner, scope, ['protected']);
  for (let i = 0; i < 8; i++) cacheDraftImage(scope, `evictable-${i}`, blob, 0);
  expect(lookupDraftImage(scope, 'evictable-0')).toBeUndefined();
  expect(lookupDraftImage(scope, 'evictable-7')).toBe(blob);
  expect(lookupDraftImage(scope, 'protected')).toBe(blob);
  retainDraftImages(owner, scope, []);
  await clearImageDraftScope(scope);
});

it('rehydrates an evicted clipboard image from durable bytes only within its scope', async () => {
  const { restoreCachedDraftImage } = await import('./image-drafts.js');
  const saved = draft('durable-clipboard');
  await writeImageDraft(saved);
  expect(lookupDraftImage(saved.scope, saved.scope)).toBeUndefined();
  const restored = await restoreCachedDraftImage(saved.scope, saved.scope);
  expect(restored?.size).toBe(11);
  expect(lookupDraftImage(saved.scope, saved.scope)).toBe(restored);
  expect(await restoreCachedDraftImage('another-account', saved.scope)).toBeUndefined();
});

it('upgrades embedded version-one drafts without losing image bytes and can read both forms', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const isolated = new IDBFactory();
  const saved = draft('version-one');
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = isolated.open('agent-remote-image-drafts', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts', { keyPath: 'key' });
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put(saved);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  database.close();
  vi.stubGlobal('indexedDB', isolated);
  vi.resetModules();
  try {
    const storage = await import('./image-drafts.js');
    const embedded = await storage.readImageDraft(saved.key);
    expect(embedded?.images['version-one']?.blob?.size).toBe(11);
    await storage.writeImageDraft(embedded!);
    const separated = await storage.readImageDraft(saved.key);
    expect(separated?.parts).toEqual(saved.parts);
    expect(separated?.images['version-one']?.blob?.size).toBe(11);
    const open = isolated.open('agent-remote-image-drafts', 2);
    const upgraded = await new Promise<IDBDatabase>(resolve => { open.onsuccess = () => resolve(open.result); });
    const tx = upgraded.transaction('drafts', 'readonly');
    const request = tx.objectStore('drafts').get(saved.key);
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    expect(request.result.images['version-one'].blob).toBeUndefined();
    expect(request.result.images['version-one'].blobKey).toBeDefined();
    upgraded.close();
  } finally { vi.unstubAllGlobals(); }
});

it('uses memory for private image drafts, clears persisted bytes, and fences writes already converting blobs', async () => {
  vi.resetModules();
  const { configureImageDraftPersistence, clearPersistedImageDrafts, readImageDraft, writeImageDraft, restoreCachedDraftImage } = await import('./image-drafts.js');
  let persistent = true;
  configureImageDraftPersistence(() => persistent);
  const saved = draft('private-images');
  await writeImageDraft(saved);
  let release!: (value: ArrayBuffer) => void;
  const delayed = draft('delayed-private-images');
  vi.spyOn(delayed.images[delayed.scope]!.blob!, 'arrayBuffer').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = writeImageDraft(delayed);
  persistent = false;
  await clearPersistedImageDrafts();
  persistent = true;
  release(new ArrayBuffer(11)); await pending;
  persistent = false;
  expect((await readImageDraft(saved.key))?.parts).toEqual(saved.parts);
  expect((await readImageDraft(delayed.key))?.parts).toEqual(delayed.parts);
  expect((await restoreCachedDraftImage(saved.scope, saved.scope))?.size).toBe(11);
  await writeImageDraft({ ...saved, parts: [{ type: 'text', text: 'private edit' }] });
  expect((await readImageDraft(saved.key))?.parts).toEqual([{ type: 'text', text: 'private edit' }]);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('agent-remote-image-drafts', 2);
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  try {
    const tx = db.transaction(['drafts', 'images'], 'readonly');
    const drafts = tx.objectStore('drafts').count(); const images = tx.objectStore('images').count();
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    expect(drafts.result).toBe(0); expect(images.result).toBe(0);
  } finally { db.close(); persistent = true; configureImageDraftPersistence(() => true); }
});

it('reports actual image write retention and cancellation independently of upload readiness', async () => {
  const value = draft('checked-result');
  expect(await writeImageDraft(value)).toEqual({ status: 'saved', retention: 'local' });
  const generation = imageDraftScopeGeneration(value.scope);
  await clearImageDraftScope(value.scope);
  expect(await writeImageDraft(value, generation)).toEqual({ status: 'cancelled', retention: 'page' });
});
