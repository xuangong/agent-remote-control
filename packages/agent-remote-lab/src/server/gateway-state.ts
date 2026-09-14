import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { open, rename, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

/** One writer, atomic authenticated snapshots; no transcript or raw device keys. */
export function openGatewayState<T>(file: string, secret: string, scope: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lockFd = openSync(file + '.lock', 'a+', 0o600);
  try { acquireStateLock(lockFd); } catch (error) { closeSync(lockFd); throw error; }
  // Keep this inode and open file description for the entire writer lifetime.
  // The kernel releases its advisory lock even after SIGKILL or PID namespace reuse.
  const unlock = () => closeSync(lockFd);
  const sign = (payload: string) => createHmac('sha256', secret).update('arc-state-v1\0' + scope + '\0' + payload).digest('hex');
  try {
    let initial: T | undefined;
    if (existsSync(file)) {
      if (statSync(file).size > 64 * 1024 * 1024) throw new Error('Relay state is too large.');
      const record: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!record || typeof record !== 'object' || !('payload' in record) || !('signature' in record) || typeof record.payload !== 'string' || typeof record.signature !== 'string') throw new Error('Invalid Relay state.');
      const actual = Buffer.from(record.signature, 'hex'); const expected = Buffer.from(sign(record.payload), 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Relay state does not match its signing secret or configured origins.');
      initial = JSON.parse(record.payload) as T;
    }
    let closed = false;
    return { initial,
      save(value: T) {
        if (closed) throw new Error('Relay state is closed.');
        const payload = JSON.stringify(value); const temporary = file + '.' + randomUUID() + '.tmp';
        const output = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(output, JSON.stringify({ payload, signature: sign(payload) })); fsyncSync(output); } finally { closeSync(output); }
        try { renameSync(temporary, file); const directory = openSync(dirname(file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
        finally { if (existsSync(temporary)) unlinkSync(temporary); }
      },
      async commit(value: T) {
        if (closed) throw new Error('Relay state is closed.');
        const payload = JSON.stringify(value); const temporary = file + '.' + randomUUID() + '.tmp';
        const output = await open(temporary, 'wx', 0o600);
        try {
          try { await output.writeFile(JSON.stringify({ payload, signature: sign(payload) })); await output.sync(); }
          finally { await output.close(); }
          await rename(temporary, file);
          const directory = await open(dirname(file), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      },
      close() { if (closed) return; closed = true; unlock(); },
    };
  } catch (error) { unlock(); throw error; }
}

function acquireStateLock(fd: number) {
  const conflict = 73;
  const python = 'import fcntl, sys\ntry: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)';
  const executable = process.platform === 'linux' ? '/usr/bin/flock' : process.platform === 'darwin' ? '/usr/bin/python3' : undefined;
  if (!executable) throw new Error('Durable Relay state locking requires Linux flock or macOS system Python.');
  const args = process.platform === 'linux' ? ['-n', '-E', String(conflict), '3'] : ['-c', python];
  // Child fd 3 duplicates our open file description; its flock survives child exit.
  const result = spawnSync(executable, args, { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 3000, maxBuffer: 16384 });
  if (result.status === conflict) throw new Error('Another Relay process owns this state file.');
  if (result.error || result.status !== 0) throw new Error(`Relay advisory locking is unavailable; ${executable} must be installed and usable.`);
}
