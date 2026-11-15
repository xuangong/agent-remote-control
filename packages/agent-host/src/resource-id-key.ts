import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The secret behind stable resource ids, kept in the Controller's state directory so ids survive a restart. It is 32 random
 * bytes readable only by the Controller's user. A missing or damaged file is replaced by a new key; ids made under the old
 * key are then replaced as the resources settle again.
 */
export function loadResourceIdKey(file: string): string {
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (KEY_PATTERN.test(saved)) {
      chmodSync(file, 0o600);
      return saved;
    }
  } catch { /* No key yet. */ }
  const key = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  // The key never exists at its final path with other content or looser permissions.
  const staging = `${file}.${process.pid}.tmp`;
  writeFileSync(staging, `${key}\n`, { mode: 0o600 });
  chmodSync(staging, 0o600);
  renameSync(staging, file);
  return key;
}
