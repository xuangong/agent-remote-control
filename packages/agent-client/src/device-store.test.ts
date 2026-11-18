import { afterEach, expect, it } from 'vitest';
import { DeviceStore, type SessionIdentity } from './device-store.js';
import { buildSessionIdentity, buildStoredRecord, memoryDeviceDatabase, TEST_RELAY_URL as scope } from './testing/index.js';

const identity = (name: string): SessionIdentity => buildSessionIdentity(name);
const record = (who: string, name: string, at: number, rows = 3, text?: string) => buildStoredRecord({ relayUrl: who, nativeSessionId: name, updatedAt: at, rows, text });
const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });

let database = memoryDeviceDatabase();
/** A page: a store over the device's one database. A second `make` is a later page of the same device. */
const make = (options: ConstructorParameters<typeof DeviceStore>[0] = {}) => new DeviceStore({ database, writeBehindMs: 5, ...options });
afterEach(() => { database = memoryDeviceDatabase(); });

it('keeps a record in memory at once and writes it behind, and a new page preloads it', async () => {
  const store = make();
  const saved = record(scope, 'one', 100);
  store.put(saved);
  expect(store.read(scope, identity('one'))).toBe(saved);
  expect(database.keys()).toEqual([]);
  await store.flush();
  expect(database.keys()).toEqual([saved.key]);
  const fresh = make();
  expect(fresh.read(scope, identity('one'))).toBeUndefined();
  await fresh.preload(scope);
  expect(fresh.read(scope, identity('one'))?.entries).toHaveLength(3);
});

it('batches the writes that arrive within the delay into one write', async () => {
  const store = make({ writeBehindMs: 20 });
  store.put(record(scope, 'a', 1)); store.put(record(scope, 'b', 2)); store.put(record(scope, 'a', 3));
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(database.writes).toBe(1);
  expect(database.keys()).toHaveLength(2);
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
  await new Promise(resolve => setTimeout(resolve, 15));
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
  const unavailable = new DeviceStore({ writeBehindMs: 1 });
  const saved = record(scope, 'a', 1);
  unavailable.put(saved);
  await unavailable.flush(); await unavailable.preload(scope);
  expect(unavailable.read(scope, identity('a'))).toBe(saved);
  const broken = new DeviceStore({ writeBehindMs: 1, database: { ...memoryDeviceDatabase(), readIndex: () => Promise.reject(new Error('blocked')), write: () => Promise.reject(new Error('blocked')) } });
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
