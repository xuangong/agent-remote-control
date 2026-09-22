import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isRelayDiagnostic, parseRelayDiagnosticBatch, type RelayDiagnostic } from '@orchardworks/agent-remote-hosted/relay-diagnostics';
import { DEFAULT_DIAGNOSTIC_LOG_ARCHIVES, DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES } from './diagnostic-log.js';

export interface RelayDiagnosticSinkOptions { path: string; maxBytes?: number; archiveCount?: number }

/** A successful append acknowledges local file ownership of this batch. */
export function createRelayDiagnosticSink(options: RelayDiagnosticSinkOptions): { append(entries: RelayDiagnostic[]): Promise<void> } {
  const maxBytes = options.maxBytes ?? DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES;
  const archives = options.archiveCount ?? DEFAULT_DIAGNOSTIC_LOG_ARCHIVES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(archives) || archives < 0)
    throw new Error('Invalid relay diagnostic log bounds.');
  return {
    async append(entries) {
      if (!parseRelayDiagnosticBatch({ entries })) throw new Error('Invalid relay diagnostic batch.');
      const lines = entries.map(entry => JSON.stringify(entry) + '\n');
      if (lines.some(line => Buffer.byteLength(line) > maxBytes)) throw new Error('Relay diagnostic record exceeds log bound.');
      boundExisting(options.path, maxBytes, archives);
      // Synchronous file operations serialize concurrent RPC batches without an unbounded queue.
      for (const line of lines) {
        if (existsSync(options.path)) {
          const metadata = lstatSync(options.path);
          if (!metadata.isFile()) throw new Error('Relay diagnostic destination must be a regular file.');
          chmodSync(options.path, 0o600);
          if (metadata.size + Buffer.byteLength(line) > maxBytes) rotate(options.path, archives);
        }
        appendFileSync(options.path, line, { mode: 0o600 });
        chmodSync(options.path, 0o600);
      }
    },
  };
}

function rotate(path: string, archives: number): void {
  if (archives === 0) { unlinkSync(path); return; }
  for (let index = archives; index >= 1; index--) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    if (!existsSync(source)) continue;
    if (!lstatSync(source).isFile()) throw new Error('Relay diagnostic archive must be a regular file.');
    if (existsSync(destination)) {
      if (!lstatSync(destination).isFile()) throw new Error('Relay diagnostic archive must be a regular file.');
      unlinkSync(destination);
    }
    renameSync(source, destination);
    chmodSync(destination, 0o600);
  }
}

function boundExisting(path: string, maxBytes: number, archives: number): void {
  const prefix = `${basename(path)}.`;
  const files = [path];
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) continue;
    const archive = join(dirname(path), name);
    if (!lstatSync(archive).isFile()) throw new Error('Relay diagnostic archive must be a regular file.');
    const index = Number(name.slice(prefix.length));
    if (index < 1 || index > archives) unlinkSync(archive);
    else files.push(archive);
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    const metadata = lstatSync(file);
    if (!metadata.isFile()) throw new Error('Relay diagnostic destination must be a regular file.');
    chmodSync(file, 0o600);
    if (metadata.size <= maxBytes) continue;
    const buffer = Buffer.alloc(maxBytes);
    const descriptor = openSync(file, 'r');
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const count = readSync(descriptor, buffer, offset, buffer.length - offset, metadata.size - maxBytes + offset);
        if (!count) break;
        offset += count;
      }
    } finally { closeSync(descriptor); }
    const lines = buffer.subarray(0, offset).toString('utf8').split('\n').filter(line => {
      try { return isRelayDiagnostic(JSON.parse(line)); } catch { return false; }
    });
    let tail = lines.length ? `${lines.join('\n')}\n` : '';
    while (Buffer.byteLength(tail) > maxBytes) { lines.shift(); tail = lines.length ? `${lines.join('\n')}\n` : ''; }
    writeFileSync(file, tail, { mode: 0o600 });
  }
}
