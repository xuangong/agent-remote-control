import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SESSION_STATE_STALE_MS } from '@orchardworks/agent-remote-protocol';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';

import type { SessionListingStatus } from '@orchardworks/agent-remote-protocol';
export type HostListingStatus = SessionListingStatus;

/** Native sessions listed only on request: reads serve the last listing and never ask the native agent to list again. */
export interface HostSessionListing {
  status(): HostListingStatus;
  /** Lists the native sessions unless a listing is already running; settles when that listing ends. */
  refresh(): Promise<void>;
}

export interface SessionListingPage<T> { sessions: T[]; nextCursor?: string }
export interface SessionListingOptions {
  /** Keeps the last listing across Controller restarts. */
  file?: string;
  pageSize?: number;
  /** A listing reads at most this many pages; older sessions are left out. */
  pageLimit?: number;
  now?(): number;
}

interface Entry<T> { summary: T; readAt: number; recorded?: number }
interface SavedListing { version: 1; listedAt?: string; complete?: boolean; sessions: Array<{ summary: unknown; readAt: unknown }> }

const states = new Set<string>(['idle', 'running', 'waiting', 'unknown', 'unavailable']);

/**
 * A native catalog that is costly to list: each listing reads the sessions it returns, which on a large native history
 * takes minutes and slows the agent's own work. The list is therefore read only when someone asks for it, page by
 * page, keeping what each page found; sessions the Controller creates or opens are added without listing.
 */
export class SessionListing<T extends RemoteSessionSummary> implements HostSessionListing {
  private entries = new Map<string, Entry<T>>();
  private state: HostListingStatus = { refreshing: false, complete: false, version: 0 };
  private readonly loading: Promise<void>;
  private running?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  private recorded = 0;
  private readonly pageSize: number;
  private readonly pageLimit: number;
  private readonly now: () => number;

  constructor(private readonly readPage: (query: { limit: number; cursor?: string }) => Promise<SessionListingPage<T>>, private readonly options: SessionListingOptions = {}) {
    this.pageSize = options.pageSize ?? 50;
    this.pageLimit = options.pageLimit ?? 10;
    this.now = options.now ?? Date.now;
    this.loading = this.load();
  }

  /** The listed sessions; a state older than the session state lifetime is no longer known. */
  async sessions(): Promise<T[]> {
    await this.loading;
    const now = this.now();
    return [...this.entries.values()].map(({ summary, readAt }) => now - readAt < SESSION_STATE_STALE_MS ? { ...summary } : { ...summary, state: 'unknown' });
  }

  status(): HostListingStatus { return { ...this.state }; }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.running) {
      const recordedBeforeListing = this.recorded;
      this.change({ refreshing: true, error: undefined });
      this.running = this.list(recordedBeforeListing).finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  /** Adds or replaces one session the Controller learned about outside a listing. */
  async record(summary: T): Promise<void> {
    await this.loading;
    this.entries.set(summary.nativeSessionId, { summary: { ...summary }, readAt: this.now(), recorded: ++this.recorded });
    this.change({});
    this.save();
  }

  async retitle(nativeSessionId: string, title: string): Promise<void> {
    await this.loading;
    const entry = this.entries.get(nativeSessionId);
    if (!entry) return;
    entry.summary = { ...entry.summary, title };
    entry.recorded = ++this.recorded;
    this.change({});
    this.save();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.running?.catch(() => undefined);
    await this.writing;
  }

  private async list(recordedBeforeListing: number): Promise<void> {
    try {
      await this.loading;
      const seen = new Map<string, Entry<T>>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 1; !this.closed; page += 1) {
        const result = await this.readPage({ limit: this.pageSize, ...(cursor ? { cursor } : {}) });
        if (this.closed) return;
        const readAt = this.now();
        for (const summary of result.sessions) seen.set(summary.nativeSessionId, { summary: { ...summary }, readAt });
        cursor = result.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('The native agent repeated a session list cursor.');
        if (cursor) cursors.add(cursor);
        const complete = !cursor || page >= this.pageLimit;
        this.entries = this.merged(seen, recordedBeforeListing, complete);
        this.change({ listedAt: new Date(readAt).toISOString(), complete });
        this.save();
        if (complete) return;
      }
    } catch (error) {
      this.change({ complete: false, error: (error instanceof Error && error.message ? error.message : 'The native sessions could not be listed.').slice(0, 300) });
    } finally {
      this.change({ refreshing: false });
      this.save();
    }
  }

  /**
   * The sessions a listing read so far. Sessions sort by update time, so a known session that is not listed yet but
   * is older than every session read so far may still be on a later page; a newer one is gone. A session recorded
   * while the listing ran is newer than anything the listing could know.
   */
  private merged(seen: ReadonlyMap<string, Entry<T>>, recordedBeforeListing: number, complete: boolean): Map<string, Entry<T>> {
    let oldest = Infinity;
    for (const { summary } of seen.values()) oldest = Math.min(oldest, Date.parse(summary.updatedAt));
    const next = new Map(seen);
    for (const [id, entry] of this.entries) {
      const listed = next.get(id);
      if (listed) { if ((entry.recorded ?? 0) > recordedBeforeListing) next.set(id, entry); continue; }
      if ((entry.recorded ?? 0) > recordedBeforeListing || !complete && Date.parse(entry.summary.updatedAt) <= oldest) next.set(id, entry);
    }
    return next;
  }

  private change(patch: Partial<Omit<HostListingStatus, 'version'>>): void {
    const next = { ...this.state, ...patch, version: this.state.version + 1 };
    if (next.error === undefined) delete next.error;
    this.state = next;
  }

  private async load(): Promise<void> {
    if (!this.options.file) return;
    let saved: SavedListing;
    try { saved = JSON.parse(await readFile(this.options.file, 'utf8')) as SavedListing; } catch { return; }
    if (!saved || saved.version !== 1 || !Array.isArray(saved.sessions)) return;
    const entries = new Map<string, Entry<T>>();
    for (const row of saved.sessions) {
      if (!validSummary(row?.summary) || typeof row.readAt !== 'number' || !Number.isFinite(row.readAt)) return;
      entries.set(row.summary.nativeSessionId, { summary: row.summary as T, readAt: row.readAt });
    }
    this.entries = entries;
    this.state = { ...this.state, complete: saved.complete === true, ...(typeof saved.listedAt === 'string' ? { listedAt: saved.listedAt } : {}) };
  }

  /** Writes in order, so a later write always holds the later list; a failed write leaves the list in memory only. */
  private save(): void {
    const file = this.options.file;
    if (!file) return;
    const saved: SavedListing = { version: 1, ...(this.state.listedAt ? { listedAt: this.state.listedAt } : {}), complete: this.state.complete,
      sessions: [...this.entries.values()].map(({ summary, readAt }) => ({ summary, readAt })) };
    const content = JSON.stringify(saved);
    this.writing = this.writing.then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, file);
      } catch { await rm(temporary, { force: true }).catch(() => undefined); }
    });
  }
}

function validSummary(value: unknown): value is RemoteSessionSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.nativeSessionId === 'string' && typeof summary.providerId === 'string' && typeof summary.title === 'string'
    && typeof summary.createdAt === 'string' && typeof summary.updatedAt === 'string' && typeof summary.state === 'string' && states.has(summary.state)
    && (summary.workspace === undefined || typeof summary.workspace === 'string') && (summary.model === undefined || typeof summary.model === 'string');
}
