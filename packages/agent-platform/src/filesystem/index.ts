import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { posixFilesystem } from './posix.js';
import { windowsFilesystem } from './windows.js';
import type { PlatformFilesystem } from './types.js';

export function filesystemFor(platform: NodeJS.Platform = process.platform): PlatformFilesystem {
  return platform === 'win32' ? windowsFilesystem : posixFilesystem;
}

/** The caller owns directory creation, write serialization, and persisted schemas. */
export async function atomicWriteFile(path: string, contents: string | Uint8Array, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.atomic-${randomUUID()}.tmp`);
  const filesystem = filesystemFor();
  try {
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await filesystem.rename(temporary, path, { retries: 7, delayMs: 25, maxDelayMs: 175 });
    await filesystem.syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}
