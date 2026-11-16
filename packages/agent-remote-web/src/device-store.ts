import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { requestBrowserDatabase, SESSION_INDEX_STORE, SESSIONS_STORE } from './browser-database.js';

/** Whose conversations these are: the Relay a person signed in to and who they are there. A record is never read for another scope. */
export interface DeviceScope { readonly relayUrl: string; readonly principalId: string }
/** `[hostId, providerId, nativeSessionId]`. */
export type SessionIdentity = readonly [hostId: string, providerId: string, nativeSessionId: string];

/** One public session as a device keeps it: the newest window of its timeline at a journal position, and its last display Snapshot. */
export interface StoredRecord {
  readonly key: string;
  readonly relayUrl: string;
  readonly principalId: string;
  readonly version: number;
  readonly agentId: string;
  readonly epoch: string;
  readonly nextSeq: number;
  readonly hasOlder: boolean;
  readonly entries: readonly ProjectedTimelineEntry[];
  readonly snapshot: AgentSnapshotPayload;
  readonly updatedAt: number;
  readonly bytes: number;
}
interface IndexRow { readonly key: string; readonly relayUrl: string; readonly principalId: string; readonly updatedAt: number; readonly bytes: number }

export const deviceKey = (scope: DeviceScope, identity: SessionIdentity): string => JSON.stringify([scope.relayUrl, scope.principalId, identity]);

/** The two limits of the device store. Disk: whole records, oldest update first, pinned (mounted) sessions never. Memory: what the preload loaded plus mounted sessions. */
export const DEFAULT_DISK_CAP_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PRELOAD_BYTES = 4 * 1024 * 1024;
const WRITE_BEHIND_MS = 50;

export interface DeviceStoreOptions {
  readonly factory?: () => IDBFactory | undefined;
  readonly diskCapBytes?: number;
  readonly preloadBytes?: number;
  readonly writeBehindMs?: number;
}

const isQuota = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError';

/**
 * Conversations a device has read, kept in IndexedDB so that opening one shows its rows from the first frame. It is a display
 * cache: the connection's first page confirms or replaces what it holds. A failure of the browser's storage (blocked,
 * unavailable, over quota) never reaches the caller; the records stay in memory for this page.
 */
export class DeviceStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly index = new Map<string, IndexRow>();
  private readonly pinned = new Map<string, number>();
  private readonly queue = new Map<string, StoredRecord | null>();
  private indexLoaded = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private database: Promise<IDBDatabase> | undefined;
  private persistent = () => true;

  constructor(private readonly options: DeviceStoreOptions = {}) {}

  /** The embedding application owns the device's retention preference; without persistence records live in memory only. */
  configurePersistence(persistent: () => boolean): void { this.persistent = persistent; }

  /** The record in memory (a preloaded or saved one), synchronously. */
  read(scope: DeviceScope, identity: SessionIdentity): StoredRecord | undefined {
    const record = this.records.get(deviceKey(scope, identity));
    return record && record.relayUrl === scope.relayUrl && record.principalId === scope.principalId ? record : undefined;
  }

  /** The record in memory or on disk. */
  async load(scope: DeviceScope, identity: SessionIdentity): Promise<StoredRecord | undefined> {
    const key = deviceKey(scope, identity);
    const held = this.read(scope, identity);
    if (held || !this.diskAllowed()) return held;
    const record = await this.enqueueDisk(async database => {
      const stored = await request<StoredRecord | undefined>(database.transaction(SESSIONS_STORE, 'readonly').objectStore(SESSIONS_STORE).get(key));
      return stored && stored.relayUrl === scope.relayUrl && stored.principalId === scope.principalId ? stored : undefined;
    }, undefined);
    if (record && !this.records.has(key) && !this.queue.has(key)) this.records.set(key, record);
    return this.read(scope, identity);
  }

  /**
   * Loads the scope's newest records into memory up to the preload budget. Records of another principal on the same
   * Relay are deleted: the principal changed, and they are not this person's.
   */
  async preload(scope: DeviceScope): Promise<void> {
    if (!this.diskAllowed()) return;
    await this.enqueueDisk(async database => {
      await this.loadIndex(database);
      const foreign = [...this.index.values()].filter(row => row.relayUrl === scope.relayUrl && row.principalId !== scope.principalId);
      if (foreign.length) {
        await this.remove(database, foreign.map(row => row.key));
        for (const row of foreign) this.records.delete(row.key);
      }
      let budget = this.options.preloadBytes ?? DEFAULT_PRELOAD_BYTES;
      const own = [...this.index.values()].filter(row => row.relayUrl === scope.relayUrl && row.principalId === scope.principalId).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const row of own) {
        if (row.bytes > budget) break;
        budget -= row.bytes;
        if (this.records.has(row.key)) continue;
        const record = await request<StoredRecord | undefined>(database.transaction(SESSIONS_STORE, 'readonly').objectStore(SESSIONS_STORE).get(row.key));
        if (record && !this.records.has(row.key) && !this.queue.has(row.key)) this.records.set(row.key, record);
      }
    }, undefined);
  }

  /** Keeps a record: in memory at once, on disk after a short delay, so a frame never waits for the disk. The last write wins. */
  put(record: StoredRecord): void {
    this.records.set(record.key, record);
    this.index.set(record.key, { key: record.key, relayUrl: record.relayUrl, principalId: record.principalId, updatedAt: record.updatedAt, bytes: record.bytes });
    if (!this.diskAllowed()) return;
    this.queue.set(record.key, record);
    this.timer ??= setTimeout(() => { void this.flush(); }, this.options.writeBehindMs ?? WRITE_BEHIND_MS);
  }

  /** Drops one record, for a person who lost access to the session. */
  forget(scope: DeviceScope, identity: SessionIdentity): void {
    const key = deviceKey(scope, identity);
    this.records.delete(key);
    this.index.delete(key);
    if (!this.diskAllowed()) return;
    this.queue.set(key, null);
    this.timer ??= setTimeout(() => { void this.flush(); }, this.options.writeBehindMs ?? WRITE_BEHIND_MS);
  }

  /** A mounted session's record is never evicted from disk and its memory copy stays. */
  pin(scope: DeviceScope, identity: SessionIdentity): () => void {
    const key = deviceKey(scope, identity);
    this.pinned.set(key, (this.pinned.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.pinned.get(key) ?? 1) - 1;
      if (count > 0) this.pinned.set(key, count); else this.pinned.delete(key);
      this.trimMemory();
    };
  }

  /** Writes what is queued now. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = new Map(this.queue);
    this.queue.clear();
    if (!batch.size || !this.diskAllowed()) return this.chain;
    return this.enqueueDisk(async database => {
      await this.loadIndex(database);
      try { await this.commit(database, batch); }
      catch (error) {
        if (!isQuota(error)) throw error;
        // Make room by dropping the oldest unpinned records, then try once more; a second failure keeps the content in memory.
        const needed = [...batch.values()].reduce((sum, record) => sum + (record?.bytes ?? 0), 0);
        await this.evictOldest(database, needed, new Set(batch.keys()));
        await this.commit(database, batch);
      }
      await this.evictOldest(database, 0, new Set());
    }, undefined);
  }

  /** Deletes every record of a Relay, or of all Relays: sign-out, a lost lease, a principal change. Memory and disk, and what was queued. */
  async purge(relayUrl?: string): Promise<void> {
    const matches = (row: { relayUrl: string }) => relayUrl === undefined || row.relayUrl === relayUrl;
    for (const [key, record] of [...this.records]) if (matches(record)) this.records.delete(key);
    for (const [key, row] of [...this.index]) if (matches(row)) this.index.delete(key);
    for (const [key, record] of [...this.queue]) if (record === null || matches(record)) this.queue.delete(key);
    // A purge reaches the disk even when persistence is off: records written while it was on must not outlive the person.
    await this.enqueueDisk(async database => {
      const rows = await request<IndexRow[]>(database.transaction(SESSION_INDEX_STORE, 'readonly').objectStore(SESSION_INDEX_STORE).getAll());
      await this.remove(database, rows.filter(matches).map(row => row.key));
    }, undefined);
  }

  /** Removes the disk copies and keeps the memory ones, for "Clear cache on close". */
  async clearDisk(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.clear();
    await this.enqueueDisk(async database => {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
        transaction.objectStore(SESSIONS_STORE).clear();
        transaction.objectStore(SESSION_INDEX_STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    }, undefined);
  }

  private diskAllowed(): boolean { return this.persistent() && !!(this.options.factory ?? defaultFactory)(); }

  private trimMemory(): void {
    let bytes = 0;
    for (const record of this.records.values()) bytes += record.bytes;
    const limit = this.options.preloadBytes ?? DEFAULT_PRELOAD_BYTES;
    if (bytes <= limit) return;
    const oldest = [...this.records.values()].filter(record => !this.pinned.has(record.key) && !this.queue.has(record.key)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of oldest) {
      if (bytes <= limit) break;
      this.records.delete(record.key);
      bytes -= record.bytes;
    }
  }

  /** One disk task at a time, in order. Any failure of the browser's storage is absorbed and the fallback returned. */
  private enqueueDisk<T>(task: (database: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
    const run = this.chain.then(async () => {
      try { return await task(await this.open()); }
      catch { return fallback; }
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const factory = (this.options.factory ?? defaultFactory)();
    if (!factory) return Promise.reject(new Error('Browser storage is unavailable.'));
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = requestBrowserDatabase(factory);
      opening.onerror = () => reject(opening.error ?? new Error('Browser storage is unavailable.'));
      opening.onblocked = () => reject(new Error('Browser storage is blocked.'));
      opening.onsuccess = () => {
        const database = opening.result;
        const release = () => { if (this.database === pending) this.database = undefined; };
        database.onversionchange = () => { release(); database.close(); };
        database.onclose = release;
        resolve(database);
      };
    });
    this.database = pending;
    pending.catch(() => { if (this.database === pending) this.database = undefined; });
    return pending;
  }

  private async loadIndex(database: IDBDatabase): Promise<void> {
    if (this.indexLoaded) return;
    const rows = await request<IndexRow[]>(database.transaction(SESSION_INDEX_STORE, 'readonly').objectStore(SESSION_INDEX_STORE).getAll());
    for (const row of rows) if (!this.index.has(row.key)) this.index.set(row.key, row);
    this.indexLoaded = true;
  }

  private commit(database: IDBDatabase, batch: ReadonlyMap<string, StoredRecord | null>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
      const sessions = transaction.objectStore(SESSIONS_STORE), index = transaction.objectStore(SESSION_INDEX_STORE);
      for (const [key, record] of batch) {
        if (record) {
          sessions.put(record);
          index.put({ key, relayUrl: record.relayUrl, principalId: record.principalId, updatedAt: record.updatedAt, bytes: record.bytes } satisfies IndexRow);
        } else { sessions.delete(key); index.delete(key); }
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage write aborted.'));
    });
  }

  private async remove(database: IDBDatabase, keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    await this.commit(database, new Map(keys.map(key => [key, null] as const)));
    for (const key of keys) { this.index.delete(key); }
  }

  /** Drops whole records, oldest update first, until the disk total is under the cap by `room` bytes. Pinned records stay, so mounted sessions may exceed it. */
  private async evictOldest(database: IDBDatabase, room: number, keep: ReadonlySet<string>): Promise<void> {
    const cap = this.options.diskCapBytes ?? DEFAULT_DISK_CAP_BYTES;
    let total = 0;
    for (const row of this.index.values()) total += row.bytes;
    if (total + room <= cap) return;
    const victims: string[] = [];
    for (const row of [...this.index.values()].sort((a, b) => a.updatedAt - b.updatedAt)) {
      if (total + room <= cap) break;
      if (this.pinned.has(row.key) || keep.has(row.key)) continue;
      victims.push(row.key);
      total -= row.bytes;
    }
    await this.remove(database, victims);
    for (const key of victims) this.records.delete(key);
  }
}

const defaultFactory = (): IDBFactory | undefined => typeof indexedDB === 'undefined' ? undefined : indexedDB;

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

/** The device store of this page. */
export const deviceStore = new DeviceStore();
export const configureDeviceStorePersistence = (persistent: () => boolean): void => deviceStore.configurePersistence(persistent);
