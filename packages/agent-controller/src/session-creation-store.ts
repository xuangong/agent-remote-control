import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import type { AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';

/** How long a creation handle is kept; a session that has not received input by then no longer reopens empty. */
export const SESSION_CREATION_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * The creation handles of sessions this Host created. An agent that saves a session only with its first message has
 * nothing native to reopen a session that never received input from once its process is gone; its creation handle
 * reopens it empty. Native history wins once the session has some; handles are dropped after the retention period.
 */
export class SessionCreationStore {
  private writes = Promise.resolve();
  constructor(private readonly directory: string, private readonly providerId: string, private readonly now: () => number = Date.now) {}
  private path(sessionId: string) { return join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`); }
  async get(sessionId: string): Promise<AgentPersistenceHandle | undefined> {
    const saved = await this.read(this.path(sessionId));
    return saved?.handle.sessionId === sessionId && this.now() - saved.createdAt < SESSION_CREATION_RETENTION_MS ? saved.handle : undefined;
  }
  set(handle: AgentPersistenceHandle): Promise<void> {
    if (handle.providerId !== this.providerId) return Promise.reject(new Error('Session creation provider does not match the store.'));
    const saved = { handle: { providerId: handle.providerId, sessionId: handle.sessionId, opaque: handle.opaque }, createdAt: this.now() };
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWriteFile(this.path(handle.sessionId), JSON.stringify(saved));
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const existing = await this.read(join(this.directory, name));
        if (existing && this.now() - existing.createdAt >= SESSION_CREATION_RETENTION_MS) await rm(join(this.directory, name), { force: true });
      }
    });
  }
  private async read(path: string): Promise<{ handle: AgentPersistenceHandle; createdAt: number } | undefined> {
    let value: unknown;
    try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; }
    const saved = value as { handle?: Partial<AgentPersistenceHandle>; createdAt?: unknown } | null;
    const handle = saved?.handle;
    if (handle?.providerId !== this.providerId || typeof handle.sessionId !== 'string' || typeof handle.opaque !== 'string'
      || typeof saved!.createdAt !== 'number') return undefined;
    return { handle: handle as AgentPersistenceHandle, createdAt: saved!.createdAt };
  }
  private serialize(operation: () => Promise<void>): Promise<void> {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => {});
    return pending;
  }
}
