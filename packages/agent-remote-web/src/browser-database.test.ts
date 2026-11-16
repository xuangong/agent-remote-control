import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { BROWSER_DATABASE, BROWSER_DATABASE_VERSION, requestBrowserDatabase } from './browser-database.js';

/** An older database as a previous release left it: `build` runs inside the version change. */
function legacy(factory: IDBFactory, version: number, build: (database: IDBDatabase, transaction: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(BROWSER_DATABASE, version);
    request.onupgradeneeded = () => build(request.result, request.transaction!);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}
function upgraded(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = requestBrowserDatabase(factory);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function read<T>(database: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const request = transaction.objectStore(store).get(key);
    transaction.oncomplete = () => resolve(request.result as T | undefined);
    transaction.onabort = () => reject(transaction.error);
  });
}

it('creates every store in a fresh database', async () => {
  const database = await upgraded(new IDBFactory());
  try {
    expect(database.version).toBe(BROWSER_DATABASE_VERSION);
    expect([...database.objectStoreNames].sort()).toEqual(['drafts', 'images', 'session_index', 'sessions']);
  } finally { database.close(); }
});

it('upgrades a version-one database without touching its drafts', async () => {
  const factory = new IDBFactory();
  await legacy(factory, 1, (database, transaction) => {
    database.createObjectStore('drafts', { keyPath: 'key' });
    transaction.objectStore('drafts').put({ key: 'composer', version: 1, scope: 'account', images: { one: { blobBytes: new Uint8Array([1, 2, 3]).buffer } } });
  });
  const database = await upgraded(factory);
  try {
    expect(database.version).toBe(3);
    const draft = await read<{ images: { one: { blobBytes: ArrayBuffer } } }>(database, 'drafts', 'composer');
    expect([...new Uint8Array(draft!.images.one.blobBytes)]).toEqual([1, 2, 3]);
    expect([...database.objectStoreNames].sort()).toEqual(['drafts', 'images', 'session_index', 'sessions']);
  } finally { database.close(); }
});

it('upgrades a version-two database without touching its drafts, image bytes or image index', async () => {
  const factory = new IDBFactory();
  await legacy(factory, 2, (database, transaction) => {
    database.createObjectStore('drafts', { keyPath: 'key' });
    database.createObjectStore('images', { keyPath: 'key' }).createIndex('imageId', 'imageId');
    transaction.objectStore('drafts').put({ key: 'composer', version: 1, scope: 'account', images: { one: { blobKey: '["composer","one"]' } } });
    transaction.objectStore('images').put({ key: '["composer","one"]', scope: 'account', imageId: 'one', blobBytes: new Uint8Array([9, 8]).buffer });
  });
  const database = await upgraded(factory);
  try {
    expect(await read(database, 'drafts', 'composer')).toMatchObject({ key: 'composer', images: { one: { blobKey: '["composer","one"]' } } });
    const bytes = await read<{ blobBytes: ArrayBuffer }>(database, 'images', '["composer","one"]');
    expect([...new Uint8Array(bytes!.blobBytes)]).toEqual([9, 8]);
    const indexed = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = database.transaction('images', 'readonly');
      const request = transaction.objectStore('images').index('imageId').getAll('one');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
    expect(indexed).toHaveLength(1);
  } finally { database.close(); }
});
