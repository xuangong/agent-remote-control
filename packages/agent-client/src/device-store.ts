import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { watchPageResume } from './page-lifecycle.js';

/**
 * Whose conversations these are is the Relay URL: a Relay with accounts puts the person in it (`/u/<hash of issuer and subject>/`), and one without accounts
 * has one person. A record is never read for another Relay URL.
 */
/** `[hostId, providerId, nativeSessionId]`. */
export type SessionIdentity = readonly [hostId: string, providerId: string, nativeSessionId: string];

/** One public session as a device keeps it: the newest window of its timeline at a journal position, and its last display Snapshot. */
export interface StoredRecord {
  readonly key: string;
  readonly relayUrl: string;
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
export interface IndexRow { readonly key: string; readonly relayUrl: string; readonly updatedAt: number; readonly bytes: number }

/**
 * Where the device store keeps records between pages. The store owns every rule (what is kept, for whom, how much); a database only persists
 * and reads back. Its failures are the store's to absorb: any rejection means the records stay in memory for this page.
 */
export interface DeviceDatabase {
  /** Whether the storage exists right now; a database without this method is always available. A browser without IndexedDB is not, and the store then keeps memory only. */
  available?(): boolean;
  /** The index row of every record on disk. */
  readIndex(): Promise<IndexRow[]>;
  read(key: string): Promise<StoredRecord | undefined>;
  /** Applies one batch atomically: a record is written with its index row, `null` removes both. A full disk rejects with an error named `QuotaExceededError`. */
  write(batch: ReadonlyMap<string, StoredRecord | null>): Promise<void>;
  /** Removes every record and index row. */
  clear(): Promise<void>;
  /**
   * Keeps a batch at once, synchronously, for a page that hides or leaves: a write the page has started may never complete then (WebKit
   * aborts an IndexedDB transaction that a leaving page has not committed, and the operating system ends a page in the background without
   * an event). The database puts the batch on disk before its next read, in this page or the next, the newer record of a key winning. A
   * database without it loses what a leaving page had not written, and the next open reads that from the Relay.
   */
  keepWhileLeaving?(batch: ReadonlyMap<string, StoredRecord | null>): void;
}

export const deviceKey = (relayUrl: string, identity: SessionIdentity): string => JSON.stringify([relayUrl, identity]);

/** The two limits of the device store. Disk: whole records, oldest update first, pinned (mounted) sessions never. Memory: what the preload loaded plus mounted sessions. */
export const DEFAULT_DISK_CAP_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PRELOAD_BYTES = 4 * 1024 * 1024;

export interface DeviceStoreOptions {
  readonly database?: DeviceDatabase;
  readonly diskCapBytes?: number;
  readonly preloadBytes?: number;
}

const isQuota = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError';

/**
 * Conversations a device has read, kept in IndexedDB so that opening one shows its rows from the first frame. It is a display
 * cache: the connection's first page confirms or replaces what it holds. A failure of the browser's storage (blocked,
 * unavailable, over quota) never reaches the caller; the records stay in memory for this page.
 *
 * A record's write starts in the task that keeps it, never on a timer and never when the page leaves: WebKit aborts an IndexedDB write that
 * a page starts while it leaves (`pagehide`, `visibilitychange`, `beforeunload`), Chromium one started at `pagehide` of a closing tab, and the
 * operating system ends a page in the background without an event. What has not reached the disk when the page hides or leaves (a write
 * queued behind a read, or not committed yet, which WebKit aborts on leaving) goes to the database's synchronous `keepWhileLeaving`.
 */
export class DeviceStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly index = new Map<string, IndexRow>();
  private readonly pinned = new Map<string, number>();
  private readonly queue = new Map<string, StoredRecord | null>();
  private indexLoaded = false;
  /** Counts purges: a disk read that began before one must not put its record back. */
  private purges = 0;
  /** A write of what this task queued is due at the end of the task. */
  private writeDue = false;
  /** What was kept or forgotten and is not on disk yet: queued, or in a write that has not completed. */
  private readonly unwritten = new Map<string, StoredRecord | null>();
  private chain: Promise<void> = Promise.resolve();
  private database: DeviceDatabase | undefined;
  private persistent = () => true;
  private stopWatchingPage: (() => void) | undefined;

  constructor(private readonly options: DeviceStoreOptions = {}) {
    if (options.database) this.useDatabase(options.database);
  }

  /** Keeps records in `database` from now on; when the page hides or leaves, what is not on disk yet goes to its `keepWhileLeaving`. */
  useDatabase(database: DeviceDatabase): void {
    this.database = database;
    this.stopWatchingPage?.();
    this.stopWatchingPage = watchPageResume(() => undefined, () => this.keepUnwritten());
  }

  /** The embedding application owns the device's retention preference; without persistence records live in memory only. */
  configurePersistence(persistent: () => boolean): void { this.persistent = persistent; }

  /** The record in memory (a preloaded or saved one), synchronously. */
  read(relayUrl: string, identity: SessionIdentity): StoredRecord | undefined {
    const record = this.records.get(deviceKey(relayUrl, identity));
    return record && record.relayUrl === relayUrl ? record : undefined;
  }

  /** The record in memory or on disk. */
  async load(relayUrl: string, identity: SessionIdentity): Promise<StoredRecord | undefined> {
    const key = deviceKey(relayUrl, identity);
    const held = this.read(relayUrl, identity);
    if (held || !this.diskAllowed()) return held;
    const generation = this.purges;
    const record = await this.enqueueDisk(async database => {
      const stored = await database.read(key);
      return stored && stored.relayUrl === relayUrl ? stored : undefined;
    }, undefined);
    if (record && generation === this.purges && !this.records.has(key) && !this.queue.has(key)) this.records.set(key, record);
    return this.read(relayUrl, identity);
  }

  /** Loads the Relay's newest records into memory up to the preload budget. */
  async preload(relayUrl: string): Promise<void> {
    if (!this.diskAllowed()) return;
    const generation = this.purges;
    await this.enqueueDisk(async database => {
      await this.loadIndex(database);
      let budget = this.options.preloadBytes ?? DEFAULT_PRELOAD_BYTES;
      const own = [...this.index.values()].filter(row => row.relayUrl === relayUrl).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const row of own) {
        if (row.bytes > budget) break;
        budget -= row.bytes;
        if (this.records.has(row.key)) continue;
        const record = await database.read(row.key);
        // A purge while this read was in flight wins: what it removed is not put back into memory.
        if (record && generation === this.purges && !this.records.has(row.key) && !this.queue.has(row.key)) this.records.set(row.key, record);
      }
    }, undefined);
  }

  /**
   * Keeps a record: in memory at once, and on disk by a write that starts before this task ends, so a page that leaves or is ended right
   * after still keeps it. The records kept in one task go in one write; nothing waits for it. The last write wins.
   */
  put(record: StoredRecord): void {
    this.records.set(record.key, record);
    this.index.set(record.key, { key: record.key, relayUrl: record.relayUrl, updatedAt: record.updatedAt, bytes: record.bytes });
    if (!this.diskAllowed()) return;
    this.queue.set(record.key, record);
    this.unwritten.set(record.key, record);
    this.writeAtEndOfTask();
  }

  /** Drops one record, for a person who lost access to the session. */
  forget(relayUrl: string, identity: SessionIdentity): void {
    const key = deviceKey(relayUrl, identity);
    this.records.delete(key);
    this.index.delete(key);
    if (!this.diskAllowed()) return;
    this.queue.set(key, null);
    this.unwritten.set(key, null);
    this.writeAtEndOfTask();
  }

  /** A mounted session's record is never evicted from disk and its memory copy stays. */
  pin(relayUrl: string, identity: SessionIdentity): () => void {
    const key = deviceKey(relayUrl, identity);
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

  /**
   * Writes what is queued now. The write is the disk task's first step: with the database open and no earlier disk task running, it starts
   * in this task. The index of what is on disk is read after it, for eviction only.
   */
  flush(): Promise<void> {
    const batch = new Map(this.queue);
    this.queue.clear();
    if (!batch.size || !this.diskAllowed()) return this.chain;
    return this.enqueueDisk(async database => {
      try { await database.write(batch); }
      catch (error) {
        if (!isQuota(error)) throw error;
        // Make room by dropping the oldest unpinned records, then try once more; a second failure keeps the content in memory.
        await this.loadIndex(database);
        const needed = [...batch.values()].reduce((sum, record) => sum + (record?.bytes ?? 0), 0);
        await this.evictOldest(database, needed, new Set(batch.keys()));
        await database.write(batch);
      }
      for (const [key, value] of batch) if (this.unwritten.get(key) === value) this.unwritten.delete(key);
      await this.loadIndex(database);
      await this.evictOldest(database, 0, new Set());
    }, undefined);
  }

  /** Deletes every record of a Relay, or of all Relays: sign-out, a lost lease, a change of Relay URL (another person). Memory and disk, and what was queued. */
  async purge(relayUrl?: string): Promise<void> {
    this.purges++;
    const matches = (row: { relayUrl: string }) => relayUrl === undefined || row.relayUrl === relayUrl;
    for (const [key, record] of [...this.records]) if (matches(record)) this.records.delete(key);
    for (const [key, row] of [...this.index]) if (matches(row)) this.index.delete(key);
    for (const [key, record] of [...this.queue]) if (record === null || matches(record)) this.queue.delete(key);
    for (const [key, record] of [...this.unwritten]) if (record === null || matches(record)) this.unwritten.delete(key);
    // A purge reaches the disk even when persistence is off: records written while it was on must not outlive the person.
    await this.enqueueDisk(async database => {
      const rows = await database.readIndex();
      await this.remove(database, rows.filter(matches).map(row => row.key));
    }, undefined);
  }

  /** Removes the disk copies and keeps the memory ones, for "Clear cache on close". */
  async clearDisk(): Promise<void> {
    this.queue.clear();
    this.unwritten.clear();
    await this.enqueueDisk(database => database.clear(), undefined);
  }

  private diskAllowed(): boolean { return this.persistent() && !!this.database && this.database.available?.() !== false; }

  /** The page hides or leaves: what is not on disk yet is kept by the database at once, for the next read to put on disk. */
  private keepUnwritten(): void {
    if (!this.unwritten.size || !this.diskAllowed()) return;
    try { this.database?.keepWhileLeaving?.(new Map(this.unwritten)); } catch { /* A failure of the browser's storage never reaches the page. */ }
  }

  /** Writes what this task queued once the task's own work is done, still inside the task: a microtask, never a timer. */
  private writeAtEndOfTask(): void {
    if (this.writeDue) return;
    this.writeDue = true;
    queueMicrotask(() => { this.writeDue = false; void this.flush(); });
  }

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
  private enqueueDisk<T>(task: (database: DeviceDatabase) => Promise<T>, fallback: T): Promise<T> {
    const run = this.chain.then(async () => {
      try { return this.database ? await task(this.database) : fallback; }
      catch { return fallback; }
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async loadIndex(database: DeviceDatabase): Promise<void> {
    if (this.indexLoaded) return;
    const rows = await database.readIndex();
    for (const row of rows) if (!this.index.has(row.key)) this.index.set(row.key, row);
    this.indexLoaded = true;
  }

  private async remove(database: DeviceDatabase, keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    await database.write(new Map(keys.map(key => [key, null] as const)));
    for (const key of keys) { this.index.delete(key); }
  }

  /** Drops whole records, oldest update first, until the disk total is under the cap by `room` bytes. Pinned records stay, so mounted sessions may exceed it. */
  private async evictOldest(database: DeviceDatabase, room: number, keep: ReadonlySet<string>): Promise<void> {
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

/** The device store of this page. */
export const deviceStore = new DeviceStore();
export const configureDeviceStorePersistence = (persistent: () => boolean): void => deviceStore.configurePersistence(persistent);
