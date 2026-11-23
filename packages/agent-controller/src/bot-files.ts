import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ATTACHMENT_LIMIT_BYTES, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import type { BotFiles } from './bot-tools.js';

/** How long a downloaded file stays in the temporary directory. */
const DOWNLOAD_KEEP_MS = 24 * 60 * 60_000;

/**
 * The local files of bots' attachments (bots design 3.4). A bot attaches a regular file of its machine, found relative to its
 * session's working directory; a file it downloads is saved in a directory of its own under the temporary directory, owned by
 * the person who runs the Controller, and nothing applies it.
 */
export function botFiles(workingDirectory: (ref: NativeSessionRef) => Promise<string | undefined>, directory = join(tmpdir(), 'agent-remote-attachments'), now: () => number = Date.now): BotFiles {
  return {
    async read(ref, path) {
      const base = isAbsolute(path) ? undefined : await workingDirectory(ref);
      if (!isAbsolute(path) && !base) throw new Error('This session\'s working directory is unknown; give the file\'s absolute path.');
      const full = base ? resolve(base, path) : path, info = await stat(full).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`${path} is not a file on this computer.`);
      if (info.size > ATTACHMENT_LIMIT_BYTES) throw new Error(`${path} is over ${ATTACHMENT_LIMIT_BYTES / 1024 / 1024} MiB; attach less, or move it through a repository.`);
      return { name: basename(full), bytes: new Uint8Array(await readFile(full)) };
    },
    async save(id, name, bytes) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Directories of earlier downloads go after a day.
      for (const entry of await readdir(directory).catch(() => [])) {
        const info = await stat(join(directory, entry)).catch(() => undefined);
        if (info && now() - info.mtimeMs > DOWNLOAD_KEEP_MS) await rm(join(directory, entry), { recursive: true, force: true });
      }
      const folder = join(directory, id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = join(folder, basename(name));
      await writeFile(file, bytes, { mode: 0o600 });
      return file;
    },
  };
}
