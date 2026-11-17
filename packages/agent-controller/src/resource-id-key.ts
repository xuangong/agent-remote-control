import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The secret behind stable resource ids, kept in the Controller's state directory so ids survive a restart. It is 32 random
 * bytes readable only by the Controller's user.
 *
 * The key is created only when the file does not exist: written to a private temporary file, flushed, and linked into place,
 * so the file never exists with partial content and a Controller that starts at the same time adopts the key that won. A
 * file that exists but does not hold a key stops the Controller with an error; replacing it would silently change every
 * resource id the journals already name.
 */
export function loadResourceIdKey(file: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const existing = readKey(file);
  if (existing !== undefined) return existing;
  const staging = `${file}.${randomUUID()}.tmp`;
  let failure: unknown;
  let key: string | undefined;
  try {
    const descriptor = openSync(staging, 'wx', 0o600);
    try {
      writeSync(descriptor, `${randomBytes(32).toString('hex')}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    try { linkSync(staging, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    syncDirectory(dirname(file));
    key = readKey(file);
  } catch (error) { failure = error; }
  try { unlinkSync(staging); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
  if (key === undefined) throw new Error(`The resource id key file ${file} disappeared while it was created.`);
  return key;
}

/** The key in the file, or undefined when there is no file. A file with anything else in it is an error. */
function readKey(file: string): string | undefined {
  let content: string;
  try { content = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const key = content.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`The resource id key file ${file} does not hold a key (64 hexadecimal characters). Move it away to make a new key; resource ids made under the old one stop resolving.`);
  }
  // Tightening permissions is a courtesy; a key that is readable but cannot be tightened is still the key.
  try { chmodSync(file, 0o600); } catch { /* Best effort. */ }
  return key;
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch { /* Some platforms cannot flush a directory. */ }
}
