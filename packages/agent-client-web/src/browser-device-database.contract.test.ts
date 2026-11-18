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
