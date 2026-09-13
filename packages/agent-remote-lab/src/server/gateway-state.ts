import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One writer, atomic authenticated snapshots; no transcript or raw device keys. */
export function openGatewayState<T>(file: string, secret: string, scope: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock';
  // Serialize stale-lock recovery too: a second contender must never unlink a new owner's lock.
  const guard = lock + '.recovery';
  const guardFd = openSync(guard, 'wx', 0o600);
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try {
    if (existsSync(lock)) {
      const previous: unknown = JSON.parse(readFileSync(lock, 'utf8'));
      const pid = typeof previous === 'number' ? previous : previous && typeof previous === 'object' && 'pid' in previous ? previous.pid : undefined;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Relay state lock is invalid.');
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Another Relay process owns this state file.');
      unlinkSync(lock);
    }
    const fd = openSync(lock, 'wx', 0o600);
    try { writeFileSync(fd, owner); } finally { closeSync(fd); }
  } finally { closeSync(guardFd); unlinkSync(guard); }
  const unlock = () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === owner) unlinkSync(lock); };
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
      close() { if (closed) return; closed = true; unlock(); },
    };
  } catch (error) { unlock(); throw error; }
}
