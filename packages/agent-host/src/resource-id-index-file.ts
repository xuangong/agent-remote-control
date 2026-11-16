import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DurableResourceEntry, ResourceIdIndex } from '@orchardworks/agent-remote-relay';

export const RESOURCE_ID_INDEX_CAPACITY = 10_000;
const FLUSH_DELAY_MS = 250;

/**
 * The resources whose ids stay readable across a restart, kept in the Controller's state directory. The least recently used
 * entries go first, at most `capacity` stay, and the file is private to the Controller's user and replaced atomically.
 * It is a cache: a missing or damaged file starts empty.
 */
export class FileResourceIdIndex implements ResourceIdIndex {
  private readonly entries = new Map<string, DurableResourceEntry>();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(private readonly file: string, private readonly capacity = RESOURCE_ID_INDEX_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('The resource id index needs a positive capacity.');
    for (const entry of readEntries(file)) this.entries.set(keyOf(entry.agentId, entry.resourceId), entry);
    while (this.entries.size > capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  get(agentId: string, resourceId: string): DurableResourceEntry | undefined {
    const key = keyOf(agentId, resourceId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry };
  }

  put(entry: DurableResourceEntry): void {
    const key = keyOf(entry.agentId, entry.resourceId);
    const known = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, { ...entry });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    if (known && known.readLocator === entry.readLocator && known.sha256 === entry.sha256 && known.normalizedLocator === entry.normalizedLocator) return;
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS).unref();
  }

  /** Writes what changed since the last write. A write that fails is tried again with the next change. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty) return;
    const staging = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const descriptor = openSync(staging, 'wx', 0o600);
      try {
        writeSync(descriptor, JSON.stringify({ version: 1, entries: [...this.entries.values()] }));
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(staging, this.file);
      try { chmodSync(this.file, 0o600); } catch { /* Best effort. */ }
      this.dirty = false;
    } catch {
      try { unlinkSync(staging); } catch { /* Nothing was staged. */ }
    }
  }
}

const keyOf = (agentId: string, resourceId: string) => `${agentId}\0${resourceId}`;

function readEntries(file: string): DurableResourceEntry[] {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; entries?: unknown };
    if (value.version !== 1 || !Array.isArray(value.entries)) return [];
    return value.entries.filter((entry): entry is DurableResourceEntry => isEntry(entry));
  } catch { return []; }
}

function isEntry(value: unknown): value is DurableResourceEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return ['agentId', 'resourceId', 'normalizedLocator', 'readLocator'].every(name => typeof entry[name] === 'string' && (entry[name] as string).length > 0)
    && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256);
}
