import type { DeviceDatabase, StoredRecord } from '@orchardworks/agent-client';
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

const request = <T>(operation: IDBRequest<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result);
  operation.onerror = () => reject(operation.error);
});

/** The device store's records in this browser's IndexedDB. The database opens when first used and again after the browser closes it. */
export function createBrowserDeviceDatabase(factory: () => IDBFactory | undefined = () => typeof indexedDB === 'undefined' ? undefined : indexedDB): DeviceDatabase {
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (opened) return opened;
    const idb = factory();
    if (!idb) return Promise.reject(new Error('Browser storage is unavailable.'));
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = requestBrowserDatabase(idb);
      opening.onerror = () => reject(opening.error ?? new Error('Browser storage is unavailable.'));
      opening.onblocked = () => reject(new Error('Browser storage is blocked.'));
      opening.onsuccess = () => {
        const database = opening.result;
        const release = () => { if (opened === pending) opened = undefined; };
        database.onversionchange = () => { release(); database.close(); };
        database.onclose = release;
        resolve(database);
      };
    });
    opened = pending;
    pending.catch(() => { if (opened === pending) opened = undefined; });
    return pending;
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
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage write aborted.'));
      });
    },
    async clear() {
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
