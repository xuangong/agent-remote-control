import type { ImageUploadReceipt } from '@orchardworks/agent-remote-protocol';
import type { DraftPart } from './react/composer-document.js';

export interface DraftImage {
  imageId: string;
  blob?: Blob;
  uploadId: string;
  status: 'pending' | 'uploading' | 'ready' | 'failed' | 'unavailable';
  progress: number;
  attachment?: NonNullable<ImageUploadReceipt['attachment']>;
  error?: string;
}
export interface ImageDraft {
  version: 1;
  key: string;
  scope: string;
  parts: DraftPart[];
  images: Record<string, DraftImage>;
  nextLabel: number;
}
let persistentDrafts = () => true;
let persistenceGeneration = 0;
const memoryDrafts = new Map<string, ImageDraft>();
const privateDraftKeys = new Set<string>();
/** The embedding application owns the device's retention preference. */
export function configureImageDraftPersistence(persistent: () => boolean): void { persistentDrafts = persistent; }
/** Remove disk copies without interrupting editors or their in-memory retry state. */
export async function clearPersistedImageDrafts(): Promise<void> {
  persistenceGeneration++;
  for (const key of memoryDrafts.keys()) privateDraftKeys.add(key);
  if (typeof indexedDB === 'undefined') return;
  await transaction('readwrite', (drafts, images) => {
    drafts.clear(); images.clear();
    return () => undefined;
  });
}
function rememberDraft(draft: ImageDraft): void {
  memoryDrafts.delete(draft.key);
  memoryDrafts.set(draft.key, copyDraft(draft));
  if (!persistentDrafts()) { privateDraftKeys.add(draft.key); return; }
  // Durable recovery remains in IndexedDB. Bound the extra transition cache.
  let bytes = 0;
  for (const entry of memoryDrafts.values()) for (const image of Object.values(entry.images)) bytes += image.blob?.size ?? 0;
  for (const [key, entry] of memoryDrafts) {
    if (memoryDrafts.size <= 32 && bytes <= 32 * 1024 * 1024) break;
    if (privateDraftKeys.has(key)) continue;
    memoryDrafts.delete(key);
    for (const image of Object.values(entry.images)) bytes -= image.blob?.size ?? 0;
  }
}
function copyDraft(draft: ImageDraft): ImageDraft {
  return { ...draft, parts: draft.parts.map(part => ({ ...part })), images: Object.fromEntries(Object.entries(draft.images).map(([id, image]) => [id, { ...image }])) };
}
const scopeGenerations = new Map<string, number>();
const localImages = new Map<string, { scope: string; blob: Blob }>();
const imageOwners = new Map<object, Set<string>>();
const cacheKey = (scope: string, id: string) => JSON.stringify([scope, id]);
function trimImages(): void {
  const protectedKeys = new Set([...imageOwners.values()].flatMap(keys => [...keys]));
  let bytes = 0;
  for (const [key, image] of localImages) if (!protectedKeys.has(key)) bytes += image.blob.size;
  for (const [key, image] of localImages) {
    if (bytes <= 32 * 1024 * 1024) break;
    if (!protectedKeys.has(key)) { localImages.delete(key); bytes -= image.blob.size; }
  }
}
export function retainDraftImages(owner: object, scope: string, ids: readonly string[]): void {
  if (ids.length) imageOwners.set(owner, new Set(ids.map(id => cacheKey(scope, id))));
  else imageOwners.delete(owner);
  trimImages();
}
export function imageDraftScopeGeneration(scope: string): number { return scopeGenerations.get(scope) ?? 0; }
export function cacheDraftImage(scope: string, imageId: string, blob: Blob, generation: number): void {
  if (generation !== imageDraftScopeGeneration(scope)) return;
  const key = cacheKey(scope, imageId);
  localImages.delete(key); localImages.set(key, { scope, blob });
  trimImages();
}
export function lookupDraftImage(scope: string, imageId: string): Blob | undefined {
  const key = cacheKey(scope, imageId);
  const image = localImages.get(key);
  if (image) { localImages.delete(key); localImages.set(key, image); }
  return image?.blob;
}
const DATABASE = 'agent-remote-image-drafts';
const blobBuffers = new WeakMap<Blob, Promise<ArrayBuffer>>();
type StoredDraftImage = DraftImage & { blobBytes?: ArrayBuffer; blobMediaType?: string; blobKey?: string };
async function withBinaryImages(draft: ImageDraft): Promise<ImageDraft> {
  const images = await Promise.all(Object.entries(draft.images).map(async ([id, image]) => {
    if (!image.blob) return [id, image] as const;
    let bytes = blobBuffers.get(image.blob);
    if (!bytes) { bytes = image.blob.arrayBuffer(); blobBuffers.set(image.blob, bytes); }
    const { blob, ...metadata } = image;
    const stored: StoredDraftImage = { ...metadata, blobBytes: await bytes, blobMediaType: blob.type };
    return [id, stored] as const;
  }));
  return { ...draft, images: Object.fromEntries(images) };
}
let connection: Promise<IDBDatabase> | undefined;
let openedDatabase: IDBDatabase | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable.')); return; }
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath: 'key' });
      if (!request.result.objectStoreNames.contains('images')) request.result.createObjectStore('images', { keyPath: 'key' }).createIndex('imageId', 'imageId');
    };
    request.onerror = () => reject(request.error ?? new Error('Browser storage is unavailable.'));
    request.onblocked = () => reject(new Error('Browser storage is blocked.'));
    request.onsuccess = () => {
      const database = request.result;
      if (connection !== pending) { database.close(); return; }
      openedDatabase = database;
      const release = () => { if (connection === pending) connection = undefined; if (openedDatabase === database) openedDatabase = undefined; };
      database.onversionchange = () => { release(); database.close(); };
      database.onclose = release;
      resolve(database);
    };
  });
  connection = pending;
  void pending.catch(() => { if (connection === pending) connection = undefined; });
  return pending;
}
async function transaction<T>(mode: IDBTransactionMode, action: (drafts: IDBObjectStore, images: IDBObjectStore) => () => T): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(['drafts', 'images'], mode);
    tx.oncomplete = () => resolve(result());
    let requestError: DOMException | undefined;
    tx.onerror = event => {
      requestError ??= (event.target as IDBRequest | null)?.error ?? undefined;
      try { tx.abort(); } catch { /* An abort may already be in progress. */ }
    };
    tx.onabort = () => {
      // Release failed connections and preserve the originating request error.
      if (openedDatabase === database) { openedDatabase = undefined; connection = undefined; }
      database.close();
      reject(requestError ?? tx.error ?? new Error('Draft storage was interrupted.'));
    };
    let result: () => T;
    try { result = action(tx.objectStore('drafts'), tx.objectStore('images')); }
    catch (error) { tx.abort(); reject(error); }
  });
}
interface StoredImageBytes { key: string; scope: string; imageId: string; blob?: Blob; blobBytes?: ArrayBuffer; blobMediaType?: string }
export async function restoreCachedDraftImage(scope: string, imageId: string): Promise<Blob | undefined> {
  const cached = lookupDraftImage(scope, imageId);
  if (cached) return cached;
  for (const draft of memoryDrafts.values()) {
    const blob = draft.scope === scope ? draft.images[imageId]?.blob : undefined;
    if (blob) { cacheDraftImage(scope, imageId, blob, imageDraftScopeGeneration(scope)); return blob; }
  }
  if (!persistentDrafts()) return;
  const generation = imageDraftScopeGeneration(scope);
  const records = await transaction<StoredImageBytes[]>('readonly', (_drafts, images) => {
    const request = images.index('imageId').getAll(imageId);
    return () => request.result;
  });
  if (!persistentDrafts() || generation !== imageDraftScopeGeneration(scope)) return;
  const image = records.find(record => record.scope === scope);
  const blob = image?.blob ?? (image?.blobBytes ? new Blob([image.blobBytes], { type: image.blobMediaType }) : undefined);
  if (blob) cacheDraftImage(scope, imageId, blob, generation);
  return blob;
}
export async function readImageDraft(key: string): Promise<ImageDraft | undefined> {
  if (!persistentDrafts()) { const draft = memoryDrafts.get(key); return draft ? copyDraft(draft) : undefined; }
  const retentionGeneration = persistenceGeneration;
  const generations = new Map(scopeGenerations);
  const value = await transaction<unknown>('readonly', (store, images) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const draft = request.result as ImageDraft | undefined;
      if (!draft?.images || typeof draft.images !== 'object') return;
      for (const image of Object.values(draft.images) as StoredDraftImage[]) {
        if (typeof image?.blobKey !== 'string') continue;
        const bytes = images.get(image.blobKey);
        bytes.onsuccess = () => {
          const saved = bytes.result as StoredImageBytes | undefined;
          if (saved?.scope === draft.scope) Object.assign(image, { blob: saved.blob, blobBytes: saved.blobBytes, blobMediaType: saved.blobMediaType });
        };
      }
    };
    return () => request.result;
  });
  if (!persistentDrafts() || retentionGeneration !== persistenceGeneration) {
    const draft = memoryDrafts.get(key); return draft ? copyDraft(draft) : undefined;
  }
  if (value === undefined) {
    const draft = privateDraftKeys.has(key) ? memoryDrafts.get(key) : undefined;
    return draft ? copyDraft(draft) : undefined;
  }
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('parts' in value) || !Array.isArray(value.parts)) throw new Error('Saved image draft has an unsupported format.');
  const draft = value as ImageDraft;
  if (draft.key !== key || typeof draft.scope !== 'string' || !Number.isSafeInteger(draft.nextLabel) || draft.nextLabel < 1
    || !draft.images || typeof draft.images !== 'object' || Array.isArray(draft.images)
    || !draft.parts.every(part => part && ((part.type === 'text' && typeof part.text === 'string')
      || (part.type === 'image' && typeof part.imageId === 'string' && typeof part.label === 'string')))
    || !Object.values(draft.images).every(image => image && typeof image.imageId === 'string' && typeof image.uploadId === 'string')) {
    throw new Error('Saved image draft is damaged.');
  }
  for (const image of Object.values(draft.images) as StoredDraftImage[]) {
    if (!image.blob && image.blobBytes && Object.prototype.toString.call(image.blobBytes) === '[object ArrayBuffer]') image.blob = new Blob([image.blobBytes], { type: image.blobMediaType });
    delete image.blobBytes; delete image.blobMediaType; delete image.blobKey;
  }
  if ((generations.get(draft.scope) ?? 0) !== imageDraftScopeGeneration(draft.scope)) return;
  rememberDraft(draft);
  return draft;
}
export async function writeImageDraft(draft: ImageDraft, generation = imageDraftScopeGeneration(draft.scope)): Promise<void> {
  if (generation !== imageDraftScopeGeneration(draft.scope)) return;
  const referenced = new Set(draft.parts.flatMap(part => part.type === 'image' ? [part.imageId] : []));
  draft = { ...draft, images: Object.fromEntries(Object.entries(draft.images).filter(([id]) => referenced.has(id))) };
  rememberDraft(draft);
  if (!persistentDrafts()) return;
  const retentionGeneration = persistenceGeneration;
  const save = async (record: ImageDraft) => {
    await transaction('readwrite', (store, images) => {
      if (!persistentDrafts() || retentionGeneration !== persistenceGeneration || generation !== imageDraftScopeGeneration(draft.scope)) return () => undefined;
      const metadata: ImageDraft = { ...record, images: {} };
      const retained = new Set<string>();
      for (const [id, image] of Object.entries(record.images) as [string, StoredDraftImage][]) {
        const { blob, blobBytes, blobMediaType, ...fields } = image;
        if (!blob && !blobBytes) { metadata.images[id] = fields; continue; }
        const key = JSON.stringify([draft.key, id]);
        retained.add(key);
        metadata.images[id] = { ...fields, blobKey: key } as StoredDraftImage;
        const existing = images.getKey(key);
        existing.onsuccess = () => {
          if (!existing.result) {
            try { images.put({ key, scope: draft.scope, imageId: id, ...(blob ? { blob } : { blobBytes, blobMediaType }) } satisfies StoredImageBytes); }
            catch (error) { writeError = error; store.transaction.abort(); }
          }
        };
      }
      const previous = store.get(draft.key);
      previous.onsuccess = () => {
        for (const image of Object.values((previous.result as ImageDraft | undefined)?.images ?? {}) as StoredDraftImage[]) {
          if (image.blobKey && !retained.has(image.blobKey)) images.delete(image.blobKey);
        }
      };
      store.put(metadata);
      return () => undefined;
    }).catch(error => { throw writeError ?? error; });
  };
  let writeError: unknown;
  // Persist portable binary values from the outset: some WebKit backends can
  // stall a transaction while preparing Blob records. Convert each Blob once.
  await save(await withBinaryImages(draft));
}
/** Clear only the explicitly signed-out account/relay scope. */
export async function clearImageDraftScope(scope: string): Promise<void> {
  scopeGenerations.set(scope, imageDraftScopeGeneration(scope) + 1);
  for (const [key, draft] of memoryDrafts) if (draft.scope === scope) { memoryDrafts.delete(key); privateDraftKeys.delete(key); }
  for (const [id, image] of localImages) if (image.scope === scope) localImages.delete(id);
  await transaction('readwrite', (drafts, images) => {
    for (const store of [drafts, images]) {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (row.value.scope === scope) row.delete();
        row.continue();
      };
    }
    return () => undefined;
  });
}
