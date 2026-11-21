import type { DeviceDatabase, StoredRecord } from '@orchardworks/agent-client';
import { withMessageKey } from '@orchardworks/agent-client/locale';
/** The one IndexedDB database of this browser origin: composer drafts and images, and the device store of conversations. */
export const BROWSER_DATABASE = 'agent-remote-image-drafts';
/** 1: drafts. 2: image bytes in their own store. 3: the device store (`sessions` and `session_index`). */
export const BROWSER_DATABASE_VERSION = 3;
export const DRAFTS_STORE = 'drafts';
export const IMAGES_STORE = 'images';
export const SESSIONS_STORE = 'sessions';
export const SESSION_INDEX_STORE = 'session_index';

/** Creates what an older database lacks and never opens what it holds, so drafts and images survive every upgrade. */
export function upgradeBrowserDatabase(database: IDBDatabase): void {
  const names = database.objectStoreNames;
  if (!names.contains(DRAFTS_STORE)) database.createObjectStore(DRAFTS_STORE, { keyPath: 'key' });
  if (!names.contains(IMAGES_STORE)) database.createObjectStore(IMAGES_STORE, { keyPath: 'key' }).createIndex('imageId', 'imageId');
  if (!names.contains(SESSIONS_STORE)) database.createObjectStore(SESSIONS_STORE, { keyPath: 'key' });
  if (!names.contains(SESSION_INDEX_STORE)) database.createObjectStore(SESSION_INDEX_STORE, { keyPath: 'key' });
}

/** An open request that upgrades the database to the current version; each caller attaches its own result handlers. */
export function requestBrowserDatabase(factory: IDBFactory = indexedDB): IDBOpenDBRequest {
  const request = factory.open(BROWSER_DATABASE, BROWSER_DATABASE_VERSION);
  request.onupgradeneeded = () => upgradeBrowserDatabase(request.result);
  return request;
}

interface IndexRow { readonly key: string; readonly relayUrl: string; readonly updatedAt: number; readonly bytes: number }

/**
 * Where a page that hides or leaves keeps the records it has not written yet, synchronously: localStorage commits at once, while WebKit
 * aborts an IndexedDB transaction that a leaving page has not committed. The next open of the database writes them to IndexedDB first.
 */
export const LEAVING_KEY = 'agent-remote:device-store:leaving';
/** The synchronous storage a leaving page writes to; the page's localStorage when it has one. */
export type LeavingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const pageLocalStorage = (): LeavingStorage | undefined => { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } };

/** The batches kept while leaving that are not on disk yet, as key and record (or null for a removal); nothing that is not one. */
function readLeaving(storage: LeavingStorage): Map<string, StoredRecord | null> {
  let value: unknown;
  try { value = JSON.parse(storage.getItem(LEAVING_KEY) ?? '[]'); } catch { return new Map(); }
  const kept = new Map<string, StoredRecord | null>();
  if (!Array.isArray(value)) return kept;
  for (const entry of value) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const [key, record] = entry as [string, unknown];
    const valid = record === null || (!!record && typeof record === 'object' && (record as StoredRecord).key === key && typeof (record as StoredRecord).relayUrl === 'string'
      && Number.isSafeInteger((record as StoredRecord).updatedAt) && Number.isSafeInteger((record as StoredRecord).bytes));
    if (valid) kept.set(key, record as StoredRecord | null);
  }
  return kept;
}

/** Writes what leaving pages kept into the database, a stored record that is newer staying, then forgets them. A failure keeps them for the next open. */
async function writeLeaving(database: IDBDatabase, storage: LeavingStorage | undefined): Promise<void> {
  const kept = storage ? readLeaving(storage) : new Map<string, StoredRecord | null>();
  if (!storage || !kept.size) { if (storage?.getItem(LEAVING_KEY) !== null) storage?.removeItem(LEAVING_KEY); return; }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
    const sessions = transaction.objectStore(SESSIONS_STORE), index = transaction.objectStore(SESSION_INDEX_STORE);
    for (const [key, record] of kept) {
      if (!record) { sessions.delete(key); index.delete(key); continue; }
      const stored = index.get(key);
      stored.onsuccess = () => {
        if (((stored.result as IndexRow | undefined)?.updatedAt ?? -1) > record.updatedAt) return;
        sessions.put(record);
        index.put({ key, relayUrl: record.relayUrl, updatedAt: record.updatedAt, bytes: record.bytes } satisfies IndexRow);
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  storage.removeItem(LEAVING_KEY);
}

const request = <T>(operation: IDBRequest<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result);
  operation.onerror = () => reject(operation.error);
});

/**
 * The device store's records in this browser's IndexedDB. The database opens when first used and again after the browser closes it; each
 * open first writes what leaving pages kept in `leaving` storage.
 */
export function createBrowserDeviceDatabase(factory: () => IDBFactory | undefined = () => typeof indexedDB === 'undefined' ? undefined : indexedDB,
  leaving: () => LeavingStorage | undefined = pageLocalStorage): DeviceDatabase {
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (opened) return opened;
    const idb = factory();
    if (!idb) return Promise.reject(withMessageKey(new Error('Browser storage is unavailable.'), 'timeline.storage.unavailable'));
    const release = () => { if (opened === ready) opened = undefined; };
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = requestBrowserDatabase(idb);
      opening.onerror = () => reject(opening.error ?? withMessageKey(new Error('Browser storage is unavailable.'), 'timeline.storage.unavailable'));
      opening.onblocked = () => reject(withMessageKey(new Error('Browser storage is blocked.'), 'timeline.storage.blocked'));
      opening.onsuccess = () => {
        const database = opening.result;
        database.onversionchange = () => { release(); database.close(); };
        database.onclose = release;
        resolve(database);
      };
    });
    // What leaving pages kept is on disk before anything is read; if that write fails it stays kept for the next open.
    const ready: Promise<IDBDatabase> = pending.then(async database => { await writeLeaving(database, leaving()).catch(() => undefined); return database; });
    opened = ready;
    ready.catch(release);
    return ready;
  };
  return {
    available: () => factory() !== undefined,
    async readIndex() {
      return request<IndexRow[]>((await open()).transaction(SESSION_INDEX_STORE, 'readonly').objectStore(SESSION_INDEX_STORE).getAll());
    },
    async read(key) {
      return request<StoredRecord | undefined>((await open()).transaction(SESSIONS_STORE, 'readonly').objectStore(SESSIONS_STORE).get(key));
    },
    async write(batch) {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
        const sessions = transaction.objectStore(SESSIONS_STORE), index = transaction.objectStore(SESSION_INDEX_STORE);
        for (const [key, record] of batch) {
          if (record) {
            sessions.put(record);
            index.put({ key, relayUrl: record.relayUrl, updatedAt: record.updatedAt, bytes: record.bytes } satisfies IndexRow);
          } else { sessions.delete(key); index.delete(key); }
        }
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? withMessageKey(new Error('Browser storage write aborted.'), 'timeline.storage.writeAborted'));
      });
    },
    keepWhileLeaving(batch) {
      const storage = leaving();
      if (!storage || !batch.size) return;
      const kept = readLeaving(storage);
      for (const [key, record] of batch) kept.set(key, record);
      // Over quota, nothing is kept: the next open reads these conversations from the Relay.
      try { storage.setItem(LEAVING_KEY, JSON.stringify([...kept])); } catch { /* Storage is full or unavailable. */ }
    },
    async clear() {
      try { leaving()?.removeItem(LEAVING_KEY); } catch { /* Storage is unavailable; nothing was kept there. */ }
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
        transaction.objectStore(SESSIONS_STORE).clear();
        transaction.objectStore(SESSION_INDEX_STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    },
  };
}
