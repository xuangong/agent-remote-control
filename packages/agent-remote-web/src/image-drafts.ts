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
const scopeGenerations = new Map<string, number>();
const localImages = new Map<string, { scope: string; blob: Blob }>();
export function imageDraftScopeGeneration(scope: string): number { return scopeGenerations.get(scope) ?? 0; }
export function cacheDraftImage(scope: string, imageId: string, blob: Blob, generation: number): void {
  if (generation === imageDraftScopeGeneration(scope)) localImages.set(imageId, { scope, blob });
}
export function lookupDraftImage(scope: string, imageId: string): Blob | undefined { const image = localImages.get(imageId); return image?.scope === scope ? image.blob : undefined; }
const DATABASE = 'agent-remote-image-drafts';
let binaryBlobStorage = false;
const blobBuffers = new WeakMap<Blob, Promise<ArrayBuffer>>();
type StoredDraftImage = DraftImage & { blobBytes?: ArrayBuffer; blobMediaType?: string };
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
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable.')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('drafts', { keyPath: 'key' }); };
    request.onerror = () => reject(request.error ?? new Error('Browser storage is unavailable.'));
    request.onblocked = () => reject(new Error('Browser storage is blocked.'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction('drafts', mode);
      const request = action(tx.objectStore('drafts'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Draft storage failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Draft storage was interrupted.'));
    });
  } finally { database.close(); }
}
export async function readImageDraft(key: string): Promise<ImageDraft | undefined> {
  const value = await transaction<unknown>('readonly', store => store.get(key));
  if (value === undefined) return undefined;
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
    delete image.blobBytes; delete image.blobMediaType;
  }
  return draft;
}
export async function writeImageDraft(draft: ImageDraft, generation = imageDraftScopeGeneration(draft.scope)): Promise<void> {
  if (generation !== imageDraftScopeGeneration(draft.scope)) return;
  const referenced = new Set(draft.parts.flatMap(part => part.type === 'image' ? [part.imageId] : []));
  draft = { ...draft, images: Object.fromEntries(Object.entries(draft.images).filter(([id]) => referenced.has(id))) };
  const save = async (record: ImageDraft) => {
    await transaction('readwrite', store => generation === imageDraftScopeGeneration(draft.scope) ? store.put(record) : store.get(draft.key));
  };
  if (binaryBlobStorage) { await save(await withBinaryImages(draft)); return; }
  try { await save(draft); } catch (error) {
    if (!(error instanceof DOMException) || !['UnknownError', 'DataCloneError'].includes(error.name) || !Object.values(draft.images).some(image => image.blob)) throw error;
    // Some WebKit storage backends cannot prepare Blob/File records. Binary IDB
    // values retain the bytes without relying on browser file handles.
    await save(await withBinaryImages(draft));
    binaryBlobStorage = true;
  }
}
/** Clear only the explicitly signed-out account/relay scope. */
export async function clearImageDraftScope(scope: string): Promise<void> {
  scopeGenerations.set(scope, imageDraftScopeGeneration(scope) + 1);
  for (const [id, image] of localImages) if (image.scope === scope) localImages.delete(id);
  const drafts = await transaction<ImageDraft[]>('readonly', store => store.getAll());
  for (const draft of drafts) if (draft.scope === scope) await transaction('readwrite', store => store.delete(draft.key));
}
