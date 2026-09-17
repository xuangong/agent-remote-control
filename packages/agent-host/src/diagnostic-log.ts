import {
  chmodSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DIAGNOSTIC_LOG_ARCHIVES = 3;
export const DEFAULT_DIAGNOSTIC_LINE_MAX_BYTES = 64 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 1_000;

export interface DiagnosticLog {
  write(line: string, secrets?: Iterable<string>): void;
  cleanupNow(): void;
  dispose(): void;
}

export interface DiagnosticLogOptions {
  path: string;
  maxBytes?: number;
  archiveCount?: number;
  maxLineBytes?: number;
  cleanupIntervalMs?: number;
  sink?: (line: string) => void;
}

export function boundedDiagnosticLine(
  line: string,
  secrets: Iterable<string>,
  maxBytes = DEFAULT_DIAGNOSTIC_LINE_MAX_BYTES,
): string {
  positiveInteger(maxBytes, 'Diagnostic line byte limit');
  let sanitized = line.replace(/[\r\n]+/g, ' ').trimEnd();
  for (const secret of secrets) if (secret) sanitized = sanitized.split(secret).join('[redacted]');
  const complete = `${sanitized}\n`;
  if (Buffer.byteLength(complete) <= maxBytes) return complete;
  if (maxBytes === 1) return '\n';

  const marker = maxBytes >= 4 ? '…' : '';
  const contentLimit = maxBytes - Buffer.byteLength(marker) - 1;
  const retained: string[] = [];
  let retainedBytes = 0;
  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character);
    if (retainedBytes + characterBytes > contentLimit) break;
    retained.push(character);
    retainedBytes += characterBytes;
  }
  return `${retained.join('')}${marker}\n`;
}

export function createDiagnosticLog(options: DiagnosticLogOptions): DiagnosticLog {
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES, 'Diagnostic log byte limit');
  const archiveCount = nonNegativeInteger(options.archiveCount ?? DEFAULT_DIAGNOSTIC_LOG_ARCHIVES, 'Diagnostic archive count');
  const maxLineBytes = Math.min(maxBytes, positiveInteger(options.maxLineBytes ?? DEFAULT_DIAGNOSTIC_LINE_MAX_BYTES, 'Diagnostic line byte limit'));
  const cleanupIntervalMs = positiveInteger(options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS, 'Diagnostic cleanup interval');
  const sink = options.sink ?? ((line: string) => { process.stderr.write(line); });
  let disposed = false;

  ensurePrivateFile(options.path);

  const cleanupNow = (): void => {
    if (disposed) return;
    boundArchives(options.path, archiveCount, maxBytes);
    try {
      chmodSync(options.path, 0o600);
      if (statSync(options.path).size > maxBytes) rotateActive(options.path, archiveCount, maxBytes);
    } catch {
      // Diagnostic cleanup cannot safely report to the file it is trying to bound.
    }
  };

  cleanupNow();
  const timer = setInterval(cleanupNow, cleanupIntervalMs);
  timer.unref();

  return {
    write(line, secrets = []) {
      if (disposed) return;
      const output = boundedDiagnosticLine(line, secrets, maxLineBytes);
      try {
        if (statSync(options.path).size > maxBytes) cleanupNow();
      } catch {
        ensurePrivateFile(options.path);
      }
      try { sink(output); } catch { /* A diagnostic sink failure must not destabilize the daemon. */ }
    },
    cleanupNow,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}

function ensurePrivateFile(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'a', 0o600);
    chmodSync(path, 0o600);
  } catch {
    // Startup will report the original failure through its inherited descriptor.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function boundArchives(path: string, archiveCount: number, maxBytes: number): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  let entries: string[];
  try { entries = readdirSync(directory); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const index = Number(suffix);
    const archive = join(directory, entry);
    if (!regularFile(archive)) continue;
    if (index < 1 || index > archiveCount) {
      try { unlinkSync(archive); } catch { /* Cleanup retries on the next interval. */ }
      continue;
    }
    boundFileTail(archive, maxBytes);
  }
}

function rotateActive(path: string, archiveCount: number, maxBytes: number): void {
  let tail: Buffer | undefined;
  try { tail = readTail(path, maxBytes); } catch { /* Active truncation may still succeed. */ }

  if (tail && archiveCount > 0) {
    shiftArchives(path, archiveCount);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(`${path}.1`, 'w', 0o600);
      writeAll(descriptor, tail);
      chmodSync(`${path}.1`, 0o600);
    } catch {
      // Losing an archive is preferable to allowing the active inode to grow forever.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r+');
    ftruncateSync(descriptor, 0);
    chmodSync(path, 0o600);
  } catch {
    // Cleanup retries on the next owned write or timer interval.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function shiftArchives(path: string, archiveCount: number): void {
  for (let index = archiveCount - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    const destination = `${path}.${index + 1}`;
    if (!regularFile(source)) continue;
    try {
      if (regularFile(destination)) unlinkSync(destination);
      renameSync(source, destination);
      chmodSync(destination, 0o600);
    } catch {
      // Other archive slots can still be retained and the active file still bounded.
    }
  }
}

function boundFileTail(path: string, maxBytes: number): void {
  let metadata;
  try {
    metadata = statSync(path);
    chmodSync(path, 0o600);
  } catch { return; }
  if (metadata.size <= maxBytes) return;
  let tail: Buffer;
  try { tail = readTail(path, maxBytes); } catch { return; }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r+');
    ftruncateSync(descriptor, 0);
    writeAll(descriptor, tail);
    chmodSync(path, 0o600);
  } catch {
    // Cleanup retries on the next interval.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readTail(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const output = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = readSync(descriptor, output, read, length - read, size - length + read);
      if (count === 0) break;
      read += count;
    }
    return output.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor: number, content: Buffer): void {
  let written = 0;
  while (written < content.length) written += writeSync(descriptor, content, written, content.length - written, written);
}

function regularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer.`);
  return value;
}
