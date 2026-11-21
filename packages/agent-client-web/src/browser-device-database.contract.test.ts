import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { buildStoredRecord, deviceDatabaseCases } from '@orchardworks/agent-client/testing';
import { BROWSER_DATABASE, createBrowserDeviceDatabase, requestBrowserDatabase } from './browser-database.js';

const record = (who: string, updatedAt?: number) => buildStoredRecord({ nativeSessionId: who, updatedAt });
for (const { name, run } of deviceDatabaseCases) it(`IndexedDB device database: ${name}`, () => { const factory = new IDBFactory(); return run(() => createBrowserDeviceDatabase(() => factory), record); });

it('keeps the drafts and images stores of the same browser database untouched', async () => {
  const factory = new IDBFactory();
  const database = createBrowserDeviceDatabase(() => factory);
  const saved = record('a');
  await database.write(new Map([[saved.key, saved]]));
  const opened = await new Promise<IDBDatabase>((resolve, reject) => { const opening = requestBrowserDatabase(factory); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
  expect([...opened.objectStoreNames].sort()).toEqual(['drafts', 'images', 'session_index', 'sessions']);
  opened.close();
  expect(BROWSER_DATABASE).toBe('agent-remote-image-drafts');
});

it('rejects when browser storage is unavailable, for the device store to absorb', async () => {
  await expect(createBrowserDeviceDatabase(() => undefined).readIndex()).rejects.toThrow('unavailable');
});

/** A page's localStorage, as a map. */
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
}

it('puts on disk, at the next open, what a leaving page kept synchronously, a newer stored record staying, and then forgets it', async () => {
  const factory = new IDBFactory(), storage = memoryStorage();
  const before = createBrowserDeviceDatabase(() => factory, () => storage);
  const newer = record('newer', 9), removed = record('removed', 1);
  await before.write(new Map([[newer.key, newer], [removed.key, removed]]));
  // The leaving page had not written these: a new record, an older copy of a record on disk, and the removal of one.
  const left = record('left', 5);
  before.keepWhileLeaving!(new Map<string, ReturnType<typeof record> | null>([[left.key, left], [newer.key, record('newer', 3)], [removed.key, null]]));
  expect(storage.values.has('agent-remote:device-store:leaving')).toBe(true);
  const next = createBrowserDeviceDatabase(() => factory, () => storage);
  expect((await next.readIndex()).map(row => [row.key, row.updatedAt]).sort()).toEqual([[left.key, 5], [newer.key, 9]].sort());
  expect((await next.read(left.key))?.entries).toEqual(left.entries);
  expect(storage.values.has('agent-remote:device-store:leaving')).toBe(false);
});

it('adds to what an earlier leaving page kept, keeps nothing when storage is full, and forgets what it kept on clear', async () => {
  const factory = new IDBFactory(), storage = memoryStorage();
  const database = createBrowserDeviceDatabase(() => factory, () => storage);
  const first = record('first', 1), second = record('second', 2);
  database.keepWhileLeaving!(new Map([[first.key, first]]));
  database.keepWhileLeaving!(new Map([[second.key, second]]));
  expect((await createBrowserDeviceDatabase(() => factory, () => storage).readIndex()).map(row => row.key).sort()).toEqual([first.key, second.key].sort());
  const full = { ...memoryStorage(), setItem: () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); } };
  expect(() => createBrowserDeviceDatabase(() => factory, () => full).keepWhileLeaving!(new Map([[first.key, first]]))).not.toThrow();
  database.keepWhileLeaving!(new Map([[second.key, second]]));
  await database.clear();
  expect(storage.values.has('agent-remote:device-store:leaving')).toBe(false);
  expect(await createBrowserDeviceDatabase(() => factory, () => storage).readIndex()).toEqual([]);
});
