import { randomUUID } from 'node:crypto';

export interface RemoteSessionSummary {
  nativeSessionId: string;
  providerId: string;
  title: string;
  workspace?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable';
}

export interface RemoteCatalogPage {
  items: RemoteSessionSummary[];
  nextCursor?: string;
  hasMore: boolean;
  revision: string;
}

export interface RemoteHostCatalogOptions {
  roots: () => readonly RemoteSessionSummary[] | Promise<readonly RemoteSessionSummary[]>;
  now?: () => number;
  viewTtlMs?: number;
  maxViews?: number;
  maxViewBytes?: number;
}

export class RemoteHostCatalogError extends Error {
  readonly status: number;
  constructor(readonly code: 'invalid_request' | 'cursor_expired' | 'capacity_exceeded' | 'catalog_unavailable', message: string) {
    super(message);
    this.name = 'RemoteHostCatalogError';
    this.status = code === 'invalid_request' ? 400 : code === 'cursor_expired' ? 409 : code === 'capacity_exceeded' ? 429 : 503;
  }
}

interface CatalogEntry {
  summary: RemoteSessionSummary;
  generation: number;
  sortTime: number;
  bytes: number;
}

interface CatalogView {
  id: string;
  entries: readonly CatalogEntry[];
  limit: number;
  revision: string;
  expiresAt: number;
  bytes: number;
}

interface CatalogCursor {
  viewId: string;
  limit: number;
  offset: number;
}

export class RemoteHostCatalog {
  private readonly namespace = randomUUID();
  private readonly roots: RemoteHostCatalogOptions['roots'];
  private readonly now: () => number;
  private readonly viewTtlMs: number;
  private readonly maxViews: number;
  private readonly maxViewBytes: number;
  private entries = new Map<string, CatalogEntry>();
  private readonly views = new Map<string, CatalogView>();
  private retainedBytes = 0;
  private revisionNumber = 0;
  private generation = 0;
  private disposed = false;
  private refresh: Promise<void> | undefined;

  constructor(options: RemoteHostCatalogOptions) {
    this.roots = options.roots;
    this.now = options.now ?? Date.now;
    this.viewTtlMs = options.viewTtlMs ?? 120_000;
    this.maxViews = options.maxViews ?? 16;
    this.maxViewBytes = options.maxViewBytes ?? 16 * 1024 * 1024;
    if (![this.viewTtlMs, this.maxViews, this.maxViewBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new RemoteHostCatalogError('invalid_request', 'Catalog limits must be positive safe integers.');
    }
  }

  async page(query: { limit?: number; cursor?: string } = {}): Promise<RemoteCatalogPage> {
    this.assertActive();
    if (query.limit !== undefined) validateLimit(query.limit);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor && query.limit !== undefined && query.limit !== cursor.limit) {
      throw new RemoteHostCatalogError('invalid_request', 'Continuation page size must match the original page size.');
    }
    await this.reconcile();
    const now = this.now();
    this.expireViews(now);
    if (cursor) {
      const view = this.views.get(cursor.viewId);
      if (!view) throw cursorExpired();
      if (cursor.limit !== view.limit || cursor.offset >= view.entries.length || cursor.offset % view.limit !== 0) {
        throw new RemoteHostCatalogError('invalid_request', 'Invalid catalog cursor.');
      }
      return this.readPage(view, cursor.offset);
    }

    const limit = query.limit ?? 30;
    const entries = [...this.entries.values()].sort(compareEntries);
    // Each retained view is charged its full serialized UTF-8 metadata, even when entries are shared.
    const bytes = 2 + entries.reduce((total, entry) => total + entry.bytes, 0) + Math.max(0, entries.length - 1);
    if (bytes > this.maxViewBytes) {
      throw new RemoteHostCatalogError('capacity_exceeded', 'The catalog exceeds the read view metadata budget.');
    }
    const view: CatalogView = {
      id: randomUUID(), entries, limit, bytes,
      revision: this.currentRevision(), expiresAt: now + this.viewTtlMs,
    };
    if (entries.length > limit) {
      while (this.views.size >= this.maxViews || this.retainedBytes + bytes > this.maxViewBytes) {
        const oldest = this.views.keys().next().value;
        if (oldest === undefined) break;
        this.removeView(oldest);
      }
      this.views.set(view.id, view);
      this.retainedBytes += view.bytes;
    }
    return this.readPage(view, 0);
  }

  async revision(): Promise<string> {
    this.assertActive();
    await this.reconcile();
    return this.currentRevision();
  }

  async session(nativeSessionId: string): Promise<RemoteSessionSummary | undefined> {
    this.assertActive();
    await this.reconcile();
    const entry = this.entries.get(nativeSessionId);
    return entry ? copySummary(entry.summary) : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.views.clear();
    this.retainedBytes = 0;
  }

  private assertActive(): void {
    if (this.disposed) throw cursorExpired();
  }

  private currentRevision(): string {
    return `${this.namespace}:${this.revisionNumber}`;
  }

  private reconcile(): Promise<void> {
    return this.refresh ??= this.readRoots().finally(() => { this.refresh = undefined; });
  }

  private async readRoots(): Promise<void> {
    const roots = await this.roots();
    this.assertActive();
    const next = new Map<string, CatalogEntry>();
    let changed = false;
    for (const root of roots) {
      const previous = this.entries.get(root.nativeSessionId);
      if (previous && sameSummary(previous.summary, root)) {
        next.set(root.nativeSessionId, previous);
        continue;
      }
      const summary = copySummary(root);
      next.set(summary.nativeSessionId, {
        summary,
        generation: previous?.generation ?? ++this.generation,
        sortTime: activityTime(summary),
        bytes: Buffer.byteLength(JSON.stringify(summary), 'utf8'),
      });
      changed = true;
    }
    if (changed || next.size !== this.entries.size) this.revisionNumber++;
    this.entries = next;
  }

  private readPage(view: CatalogView, offset: number): RemoteCatalogPage {
    const end = Math.min(offset + view.limit, view.entries.length);
    const items = view.entries.slice(offset, end).map((entry) => {
      const summary = { ...entry.summary };
      if (this.entries.get(summary.nativeSessionId)?.generation !== entry.generation) summary.state = 'unavailable';
      return summary;
    });
    const hasMore = end < view.entries.length;
    // Keep the view after the last page so a lost response can be retried until expiry or eviction.
    return {
      items, hasMore, revision: view.revision,
      ...(hasMore ? { nextCursor: encodeCursor(view, end) } : {}),
    };
  }

  private expireViews(now: number): void {
    for (const [id, view] of this.views) {
      if (view.expiresAt <= now) this.removeView(id);
    }
  }

  private removeView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.retainedBytes -= view.bytes;
    this.views.delete(id);
  }
}

function copySummary(summary: RemoteSessionSummary): RemoteSessionSummary {
  return {
    nativeSessionId: summary.nativeSessionId,
    providerId: summary.providerId,
    title: summary.title,
    ...(summary.workspace !== undefined ? { workspace: summary.workspace } : {}),
    ...(summary.model !== undefined ? { model: summary.model } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    state: summary.state,
  };
}

function sameSummary(left: RemoteSessionSummary, right: RemoteSessionSummary): boolean {
  return left.nativeSessionId === right.nativeSessionId && left.providerId === right.providerId
    && left.title === right.title && left.workspace === right.workspace && left.model === right.model
    && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt && left.state === right.state;
}

function activityTime(summary: RemoteSessionSummary): number {
  const updated = Date.parse(summary.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(summary.createdAt);
  return Number.isFinite(created) ? created : Number.NEGATIVE_INFINITY;
}

function compareEntries(left: CatalogEntry, right: CatalogEntry): number {
  if (left.sortTime !== right.sortTime) return left.sortTime > right.sortTime ? -1 : 1;
  const leftId = left.summary.nativeSessionId;
  const rightId = right.summary.nativeSessionId;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RemoteHostCatalogError('invalid_request', 'Catalog page size must be an integer from 1 to 100.');
  }
}

function cursorExpired(): RemoteHostCatalogError {
  return new RemoteHostCatalogError('cursor_expired', 'The catalog read view is unavailable. Refresh the catalog.');
}

function encodeCursor(view: CatalogView, offset: number): string {
  return Buffer.from(JSON.stringify([view.id, view.limit, offset])).toString('base64url');
}

function decodeCursor(cursor: string): CatalogCursor {
  try {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3) throw new Error();
    const [viewId, limit, offset] = value;
    if (typeof viewId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(viewId)) throw new Error();
    validateLimit(limit);
    if (!Number.isSafeInteger(offset) || offset <= 0) throw new Error();
    return { viewId, limit, offset };
  } catch {
    throw new RemoteHostCatalogError('invalid_request', 'Invalid catalog cursor.');
  }
}
