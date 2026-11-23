import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentStorage } from '@orchardworks/agent-relay-core';

/** The files bots attach to messages, kept as files of a directory beside the Relay's state file; each key is one file named by it. */
export class FileAttachmentStorage implements AttachmentStorage {
  constructor(private readonly directory: string) {}
  private path(key: string): string {
    if (!key || key.length > 512) throw new Error('Invalid attachment storage key.');
    return join(this.directory, encodeURIComponent(key));
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    try { return new Uint8Array(await readFile(this.path(key))); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async put(key: string, value: Uint8Array): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), value, { mode: 0o600 });
  }
  async delete(key: string): Promise<void> { await rm(this.path(key), { force: true }); }
  async list(prefix: string): Promise<string[]> {
    try { return (await readdir(this.directory)).map(name => decodeURIComponent(name)).filter(key => key.startsWith(prefix)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}
