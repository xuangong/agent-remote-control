import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { BROWSER_DATABASE, requestBrowserDatabase } from './browser-database.js';
import { DeviceStore, type DeviceScope, type SessionIdentity } from './device-store.js';
import { createStoredRecord, DEFAULT_WINDOW_LIMITS, type SessionToStore } from './session-record.js';

const scope: DeviceScope = { relayUrl: 'https://relay.example/u/a/', principalId: 'alice' };
const identity = (name: string): SessionIdentity => ['local', 'codex', name];
const snapshot = (): AgentSnapshotPayload => ({
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'idle' },
});
const entry = (seq: number, text = `row ${seq}`): ProjectedTimelineEntry => ({
  providerId: 'codex', item: { type: 'assistant_message', text, messageId: `m${seq}` }, timestamp: '2026-11-15T00:00:00.000Z',
  seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
});
const session = (rows = 3, text?: string): SessionToStore => ({ agentId: 'agent-1', epoch: 'e1', nextSeq: rows + 1, hasOlder: false,
  entries: Array.from({ length: rows }, (_, index) => entry(index + 1, text)), snapshot: snapshot() });
const record = (who: DeviceScope, name: string, at: number, rows = 3, text?: string) => createStoredRecord(who, identity(name), session(rows, text), DEFAULT_WINDOW_LIMITS, at)!;

let factory = new IDBFactory();
const make = (options: ConstructorParameters<typeof DeviceStore>[0] = {}) => new DeviceStore({ factory: () => factory, writeBehindMs: 5, ...options });
afterEach(() => { factory = new IDBFactory(); vi.restoreAllMocks(); });

async function diskKeys(): Promise<string[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => { const opening = requestBrowserDatabase(factory); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const transaction = database.transaction('sessions', 'readonly');
      const keys = transaction.objectStore('sessions').getAllKeys();
      transaction.oncomplete = () => resolve(keys.result as string[]);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

it('keeps a record in memory at once and writes it behind, and a new page preloads it', async () => {
  const store = make();
  const saved = record(scope, 'one', 100);
  store.put(saved);
  expect(store.read(scope, identity('one'))).toBe(saved);
  expect(await diskKeys()).toEqual([]);
  await store.flush();
  expect(await diskKeys()).toEqual([saved.key]);
  const fresh = make();
  expect(fresh.read(scope, identity('one'))).toBeUndefined();
  await fresh.preload(scope);
  expect(fresh.read(scope, identity('one'))?.entries).toHaveLength(3);
});

it('batches writes that arrive within the delay into one transaction', async () => {
  const store = make({ writeBehindMs: 20 });
  const transact = vi.spyOn(IDBDatabase.prototype, 'transaction');
  store.put(record(scope, 'a', 1)); store.put(record(scope, 'b', 2)); store.put(record(scope, 'a', 3));
  await new Promise(resolve => setTimeout(resolve, 80));
  await store.flush();
  expect(transact.mock.calls.filter(call => Array.isArray(call[0]) && call[1] === 'readwrite')).toHaveLength(1);
  expect(await diskKeys()).toHaveLength(2);
});

it('never reads, lists or keeps a record of another principal on the same Relay', async () => {
  const bob: DeviceScope = { ...scope, principalId: 'bob' };
  const first = make();
  first.put(record(scope, 'private', 1));
  await first.flush();
  const second = make();
  await second.preload(bob);
  expect(second.read(bob, identity('private'))).toBeUndefined();
  expect(await second.load(bob, identity('private'))).toBeUndefined();
  expect(await diskKeys()).toEqual([]);
  expect(second.read(scope, identity('private'))).toBeUndefined();
});

it('purges every record of a Relay, or of all Relays, from memory, the queue and the disk', async () => {
  const other: DeviceScope = { relayUrl: 'https://other.example/', principalId: 'alice' };
  const store = make();
  store.put(record(scope, 'a', 1)); store.put(record(other, 'b', 2));
  await store.flush();
  store.put(record(scope, 'queued', 3));
  await store.purge(scope.relayUrl);
  expect(store.read(scope, identity('a'))).toBeUndefined();
  expect(store.read(scope, identity('queued'))).toBeUndefined();
  expect(store.read(other, identity('b'))).toBeDefined();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(await diskKeys()).toHaveLength(1);
  await store.purge();
  expect(store.read(other, identity('b'))).toBeUndefined();
  expect(await diskKeys()).toEqual([]);
});

it('forgets one session', async () => {
  const store = make();
  store.put(record(scope, 'a', 1)); store.put(record(scope, 'b', 2));
  await store.flush();
  store.forget(scope, identity('a'));
  await store.flush();
  expect(await diskKeys()).toEqual([record(scope, 'b', 2).key]);
});

it('drops whole records oldest first over the disk cap and never a pinned one', async () => {
  const size = record(scope, 'x', 1).bytes;
  const store = make({ diskCapBytes: size * 2 + 10 });
  const unpin = store.pin(scope, identity('oldest'));
  store.put(record(scope, 'oldest', 1)); store.put(record(scope, 'middle', 2)); store.put(record(scope, 'newest', 3));
  await store.flush();
  const keys = await diskKeys();
  expect(keys).toHaveLength(2);
  expect(keys).toContain(record(scope, 'oldest', 1).key);
  expect(keys).toContain(record(scope, 'newest', 3).key);
  unpin();
});

it('evicts to make room on a quota error and retries once', async () => {
  const size = record(scope, 'x', 1).bytes;
  const store = make({ diskCapBytes: size * 10 });
  store.put(record(scope, 'old', 1));
  await store.flush();
  const put = IDBObjectStore.prototype.put;
  let failures = 1;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'sessions' && failures > 0 && (args[0] as { key: string }).key.includes('"fresh"')) { failures--; throw new DOMException('full', 'QuotaExceededError'); }
    return put.apply(this, args);
  });
  const filling = make({ diskCapBytes: size + 50 });
  filling.put(record(scope, 'fresh', 2));
  await filling.flush();
  expect(filling.read(scope, identity('fresh'))).toBeDefined();
  expect(failures).toBe(0);
  expect(await diskKeys()).toEqual([record(scope, 'fresh', 2).key]);
});

it('keeps the content in memory when the write fails twice', async () => {
  const store = make();
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  const saved = record(scope, 'a', 1);
  store.put(saved);
  await expect(store.flush()).resolves.toBeUndefined();
  expect(store.read(scope, identity('a'))).toBe(saved);
});

it('works from memory when browser storage is unavailable or blocked', async () => {
  const unavailable = new DeviceStore({ factory: () => undefined, writeBehindMs: 1 });
  const saved = record(scope, 'a', 1);
  unavailable.put(saved);
  await unavailable.flush(); await unavailable.preload(scope);
  expect(unavailable.read(scope, identity('a'))).toBe(saved);
  const blocking = { open: () => { const request = {} as IDBOpenDBRequest; queueMicrotask(() => (request as { onblocked?: () => void }).onblocked?.()); return request; } } as unknown as IDBFactory;
  const blocked = new DeviceStore({ factory: () => blocking, writeBehindMs: 1 });
  blocked.put(saved);
  await expect(blocked.flush()).resolves.toBeUndefined();
  expect(blocked.read(scope, identity('a'))).toBe(saved);
});

it('keeps memory only while persistence is off, and clears disk copies on request', async () => {
  const store = make();
  store.put(record(scope, 'a', 1));
  await store.flush();
  store.configurePersistence(() => false);
  store.put(record(scope, 'b', 2));
  await store.flush();
  expect(await diskKeys()).toHaveLength(1);
  expect(store.read(scope, identity('b'))).toBeDefined();
  await store.clearDisk();
  expect(await diskKeys()).toEqual([]);
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

it('is unaffected by the drafts store of the same database', async () => {
  const store = make();
  store.put(record(scope, 'a', 1));
  await store.flush();
  const database = await new Promise<IDBDatabase>((resolve, reject) => { const opening = factory.open(BROWSER_DATABASE); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
  expect([...database.objectStoreNames].sort()).toEqual(['drafts', 'images', 'session_index', 'sessions']);
  database.close();
});
