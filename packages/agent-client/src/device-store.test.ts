import { afterEach, expect, it, vi } from 'vitest';
import { DeviceStore, type SessionIdentity, type StoredRecord } from './device-store.js';
import { buildSessionIdentity, buildStoredRecord, installPageLifecycle, memoryDeviceDatabase, stubBrowserPage, TEST_RELAY_URL as scope } from './testing/index.js';

const identity = (name: string): SessionIdentity => buildSessionIdentity(name);
const record = (who: string, name: string, at: number, rows = 3, text?: string) => buildStoredRecord({ relayUrl: who, nativeSessionId: name, updatedAt: at, rows, text });
const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });

let database = memoryDeviceDatabase();
/** A page: a store over the device's one database. A second `make` is a later page of the same device. */
const make = (options: ConstructorParameters<typeof DeviceStore>[0] = {}) => new DeviceStore({ database, ...options });
afterEach(() => { database = memoryDeviceDatabase(); vi.useRealTimers(); installPageLifecycle(); });
const immediate = globalThis.setImmediate;
/** The end of the current task: every microtask it queued has run, and no timer has. */
const endOfTask = () => new Promise<void>(resolve => immediate(resolve));

it('keeps a record in memory at once and on disk before its task ends, with no timer, and a new page preloads it', async () => {
  // No timer may run: a page that leaves or is ended right after keeping a record still has it on disk.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const store = make();
  const saved = record(scope, 'one', 100);
  store.put(saved);
  expect(store.read(scope, identity('one'))).toBe(saved);
  await endOfTask();
  expect(database.keys()).toEqual([saved.key]);
  const fresh = make();
  expect(fresh.read(scope, identity('one'))).toBeUndefined();
  await fresh.preload(scope);
  expect(fresh.read(scope, identity('one'))?.entries).toHaveLength(3);
});

it('writes the records kept in one task in one write, the last of a key winning', async () => {
  const store = make();
  store.put(record(scope, 'a', 1)); store.put(record(scope, 'b', 2)); store.put(record(scope, 'a', 3));
  await endOfTask();
  expect(database.writes).toBe(1);
  expect(database.keys()).toHaveLength(2);
  expect((await database.read(record(scope, 'a', 3).key))?.updatedAt).toBe(3);
});

it('never reads or lists a record of another Relay URL, which is where another person is', async () => {
  const bob = 'https://relay.example/u/b/';
  const first = make();
  first.put(record(scope, 'private', 1));
  await first.flush();
  const second = make();
  await second.preload(bob);
  expect(second.read(bob, identity('private'))).toBeUndefined();
  expect(await second.load(bob, identity('private'))).toBeUndefined();
  expect(second.read(scope, identity('private'))).toBeUndefined();
});

it('does not put a record back into memory when a purge ran while its read was in flight', async () => {
  const first = make();
  first.put(record(scope, 'a', 1)); first.put(record(scope, 'b', 2));
  await first.flush();
  const second = make();
  await Promise.all([second.preload(scope), second.purge(scope)]);
  expect(second.read(scope, identity('a'))).toBeUndefined();
  expect(second.read(scope, identity('b'))).toBeUndefined();
  const third = make();
  const loading = third.load(scope, identity('a'));
  await third.purge();
  expect(await loading).toBeUndefined();
  expect(third.read(scope, identity('a'))).toBeUndefined();
});

it('purges every record of a Relay, or of all Relays, from memory, the queue and the disk', async () => {
  const other = 'https://other.example/';
  const store = make();
  store.put(record(scope, 'a', 1)); store.put(record(other, 'b', 2));
  await store.flush();
  store.put(record(scope, 'queued', 3));
  await store.purge(scope);
  expect(store.read(scope, identity('a'))).toBeUndefined();
  expect(store.read(scope, identity('queued'))).toBeUndefined();
  expect(store.read(other, identity('b'))).toBeDefined();
  await endOfTask();
  expect(database.keys()).toHaveLength(1);
  await store.purge();
  expect(store.read(other, identity('b'))).toBeUndefined();
  expect(database.keys()).toEqual([]);
});

it('forgets one session', async () => {
  const store = make();
  store.put(record(scope, 'a', 1)); store.put(record(scope, 'b', 2));
  await store.flush();
  store.forget(scope, identity('a'));
  await store.flush();
  expect(database.keys()).toEqual([record(scope, 'b', 2).key]);
});

it('drops whole records oldest first over the disk cap and never a pinned one', async () => {
  const size = record(scope, 'x', 1).bytes;
  const store = make({ diskCapBytes: size * 2 + 10 });
  const unpin = store.pin(scope, identity('oldest'));
  store.put(record(scope, 'oldest', 1)); store.put(record(scope, 'middle', 2)); store.put(record(scope, 'newest', 3));
  await store.flush();
  const keys = database.keys();
  expect(keys).toHaveLength(2);
  expect(keys).toContain(record(scope, 'oldest', 1).key);
  expect(keys).toContain(record(scope, 'newest', 3).key);
  unpin();
});

it('evicts to make room on a quota error and retries once', async () => {
  const size = record(scope, 'x', 1).bytes;
  const seeding = make({ diskCapBytes: size * 10 }); seeding.put(record(scope, 'old', 1)); await seeding.flush();
  database.failWrites(quota, 1);
  const filling = make({ diskCapBytes: size + 50 });
  filling.put(record(scope, 'fresh', 2));
  await filling.flush();
  expect(filling.read(scope, identity('fresh'))).toBeDefined();
  expect(database.keys()).toEqual([record(scope, 'fresh', 2).key]);
});

it('keeps the content in memory when the write fails twice', async () => {
  const store = make();
  database.failWrites(quota, 2);
  const saved = record(scope, 'a', 1);
  store.put(saved);
  await expect(store.flush()).resolves.toBeUndefined();
  expect(store.read(scope, identity('a'))).toBe(saved);
});

it('works from memory when there is no database or it fails to open', async () => {
  const unavailable = new DeviceStore();
  const saved = record(scope, 'a', 1);
  unavailable.put(saved);
  await unavailable.flush(); await unavailable.preload(scope);
  expect(unavailable.read(scope, identity('a'))).toBe(saved);
  const broken = new DeviceStore({ database: { ...memoryDeviceDatabase(), readIndex: () => Promise.reject(new Error('blocked')), write: () => Promise.reject(new Error('blocked')) } });
  broken.put(saved);
  await expect(broken.flush()).resolves.toBeUndefined();
  await expect(broken.preload(scope)).resolves.toBeUndefined();
  expect(broken.read(scope, identity('a'))).toBe(saved);
});

it('keeps memory only while persistence is off, and clears disk copies on request', async () => {
  const store = make();
  store.put(record(scope, 'a', 1));
  await store.flush();
  store.configurePersistence(() => false);
  store.put(record(scope, 'b', 2));
  await store.flush();
  expect(database.keys()).toHaveLength(1);
  expect(store.read(scope, identity('b'))).toBeDefined();
  store.configurePersistence(() => true);
  await store.clearDisk();
  expect(database.keys()).toEqual([]);
  expect(store.read(scope, identity('a'))).toBeDefined();
});

it('trims unpinned memory copies over the preload budget when a session is released', async () => {
  const size = record(scope, 'x', 1).bytes;
  const store = make({ preloadBytes: size + 10 });
  const release = store.pin(scope, identity('a'));
  store.put(record(scope, 'a', 1)); store.put(record(scope, 'b', 2));
  await store.flush();
  release();
  expect(store.read(scope, identity('a'))).toBeUndefined();
  expect(store.read(scope, identity('b'))).toBeDefined();
});

it('loads a record from disk that the preload budget left out', async () => {
  const first = make();
  first.put(record(scope, 'big', 1, 50)); first.put(record(scope, 'small', 2, 1));
  await first.flush();
  const second = make({ preloadBytes: record(scope, 'x', 1, 1).bytes + 10 });
  await second.preload(scope);
  expect(second.read(scope, identity('small'))).toBeDefined();
  expect(second.read(scope, identity('big'))).toBeUndefined();
  expect((await second.load(scope, identity('big')))?.entries).toHaveLength(50);
});

it('keeps memory only while the database says its storage does not exist, and writes once it does', async () => {
  let exists = false;
  const store = new DeviceStore({ database: { ...database, available: () => exists } });
  store.put(record(scope, 'a', 1));
  await store.flush();
  expect(database.keys()).toEqual([]);
  expect(store.read(scope, identity('a'))).toBeDefined();
  exists = true;
  store.put(record(scope, 'b', 2));
  await store.flush();
  expect(database.keys()).toEqual([record(scope, 'b', 2).key]);
});

it('hands what is not on disk yet to the database\'s synchronous keep when the page hides or leaves, and nothing once it is written', async () => {
  const page = stubBrowserPage();
  const kept: Array<Array<[string, StoredRecord | null]>> = [];
  let finish!: () => void;
  const slow = { ...database, write: () => new Promise<void>(resolve => { finish = resolve; }), keepWhileLeaving: (batch: ReadonlyMap<string, StoredRecord | null>) => { kept.push([...batch]); } };
  const store = make({ database: slow });
  const saved = record(scope, 'a', 1);
  store.put(saved); store.forget(scope, identity('gone'));
  await endOfTask();
  // The write started and has not completed: WebKit would abort it on leaving, so the page keeps the batch at once.
  page.window.dispatchEvent(new Event('pagehide'));
  expect(kept).toEqual([[[saved.key, saved], [record(scope, 'gone', 1).key, null]]]);
  finish();
  await endOfTask();
  page.window.dispatchEvent(new Event('pageshow'));
  page.document.visibilityState = 'hidden';
  page.document.dispatchEvent(new Event('visibilitychange'));
  expect(kept).toHaveLength(1);
});

it('keeps nothing while leaving when persistence is off, or once a purge took the records', async () => {
  const page = stubBrowserPage();
  const kept: unknown[] = [];
  const stuck = { ...database, write: () => new Promise<void>(() => undefined), keepWhileLeaving: (batch: ReadonlyMap<string, StoredRecord | null>) => { kept.push([...batch]); } };
  const off = make({ database: stuck });
  off.configurePersistence(() => false);
  off.put(record(scope, 'a', 1));
  await endOfTask();
  page.window.dispatchEvent(new Event('pagehide'));
  expect(kept).toEqual([]);
  page.window.dispatchEvent(new Event('pageshow'));
  const purged = make({ database: stuck });
  purged.put(record(scope, 'b', 2));
  await endOfTask();
  void purged.purge(scope);
  page.window.dispatchEvent(new Event('pagehide'));
  expect(kept).toEqual([]);
});
