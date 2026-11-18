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
