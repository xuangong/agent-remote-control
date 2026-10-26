import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '@orchardworks/agent-platform';

/**
 * The permission mode each native session's owner last confirmed, kept on this Host so the session reopens in it
 * after an idle release or a Controller restart. Only modes the provider accepts are read back.
 */
export class SessionPermissionModeStore<Mode extends string> {
  private writes = Promise.resolve();
  constructor(private readonly directory: string, private readonly accepts: (mode: unknown) => mode is Mode) {}
  private path(sessionId: string) { return join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`); }
  async read(sessionId: string): Promise<Mode | undefined> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path(sessionId), 'utf8')); } catch { return undefined; }
    const saved = value as { sessionId?: unknown; permissionMode?: unknown } | null;
    return saved?.sessionId === sessionId && this.accepts(saved.permissionMode) ? saved.permissionMode : undefined;
  }
  write(sessionId: string, permissionMode: Mode): Promise<void> {
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWriteFile(this.path(sessionId), JSON.stringify({ sessionId, permissionMode }));
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
