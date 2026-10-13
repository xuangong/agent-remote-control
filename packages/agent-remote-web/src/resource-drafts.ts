import type { ResourceUploadReceipt } from '@orchardworks/agent-remote-protocol';
export interface DraftResource { id: string; name: string; file: Blob; status: 'pending' | 'uploading' | 'ready' | 'failed'; progress: number; error?: string; resource?: NonNullable<ResourceUploadReceipt['resource']> }
export interface Entry { generation?: number; persisted?: boolean; dirty?: boolean; records: Record<string, DraftResource>; hydrated: boolean; storageError?: string; nextLabel: number; revision: number; saving?: Promise<void> }
export const resourceDraftMemory = new Map<string, Entry>();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('agent-remote-resource-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function readResourceDraft(key: string): Promise<Pick<Entry, 'records' | 'nextLabel'> | undefined> {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const request = db.transaction('drafts').objectStore('drafts').get(key); request.onsuccess = () => {
      const value = request.result;
      if (value !== undefined && (!value || typeof value !== 'object' || !Number.isSafeInteger(value.nextLabel) || value.nextLabel < 1 || !value.records || typeof value.records !== 'object' || Object.keys(value.records).length > 8 || !Object.values(value.records).every(record => { const item = record as DraftResource; return item && typeof item.id === 'string' && typeof item.name === 'string' && item.file instanceof Blob && item.file.size <= 50 * 1024 * 1024; }))) { reject(new Error('Saved resource draft is invalid.')); return; }
      resolve(value);
    }; request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
export async function writeResourceDraft(key: string, entry: Entry): Promise<void> {
  const scope = String(JSON.parse(key)[0]); const generation = resourceDraftGeneration(scope);
  const records = Object.fromEntries(Object.entries(entry.records).map(([id, record]) => [id, { ...record, resource: undefined }]));
  const bytes = Object.values(records).reduce((sum, record) => sum + record.file.size, 0);
  if (bytes > 100 * 1024 * 1024 || Object.keys(records).length > 8) throw new Error('Resource draft exceeds local storage limits.');
  const snapshot = { records, nextLabel: entry.nextLabel, bytes };
  const db = await database();
  try {
    if (generation !== resourceDraftGeneration(scope)) throw new Error('Resource storage owner retired.');
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite'); const store = tx.objectStore('drafts');
      const all = store.getAll(); const keys = store.getAllKeys();
      keys.onsuccess = () => {
        if (!Object.keys(records).length) { store.delete(key); return; }
        const retainedBytes = all.result.reduce((sum: number, draft: { bytes?: number }, index: number) => sum + (keys.result[index] === key ? 0 : draft.bytes ?? 0), 0);
        if (retainedBytes + bytes > 256 * 1024 * 1024 || !keys.result.includes(key) && keys.result.length >= 32) { tx.abort(); return; }
        if (Object.keys(records).length) store.put(snapshot, key); else store.delete(key);
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Resource draft storage limit reached.'));
    });
  } finally { db.close(); }
}
const generations = new Map<string, number>();
export function resourceDraftGeneration(scope: string): number { return generations.get(scope) ?? 0; }
export async function clearResourceDraftScope(scope: string): Promise<void> {
  generations.set(scope, resourceDraftGeneration(scope) + 1);
  for (const key of resourceDraftMemory.keys()) if (JSON.parse(key)[0] === scope) resourceDraftMemory.delete(key);
  if (typeof indexedDB === 'undefined') return;
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'); const cursor = tx.objectStore('drafts').openCursor();
    cursor.onsuccess = () => { const row = cursor.result; if (!row) return; try { if (typeof row.key === 'string' && JSON.parse(row.key)[0] === scope) row.delete(); } catch {} row.continue(); };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
