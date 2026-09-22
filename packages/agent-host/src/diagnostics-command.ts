import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isRelayDiagnostic } from '@orchardworks/agent-remote-hosted/relay-diagnostics';
import { DEFAULT_DIAGNOSTIC_LOG_ARCHIVES, DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES, DEFAULT_DIAGNOSTIC_LINE_MAX_BYTES } from './diagnostic-log.js';

type Source = 'controller' | 'server';

export async function runDiagnosticsCommand(args: string[], directory: string, print: (text: string) => void): Promise<void> {
  let source: Source | 'all' = 'all', since: number | undefined, limit = 100, pathsOnly = false;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--paths') { pathsOnly = true; continue; }
    const value = args[++index];
    if (option === '--source' && (value === 'controller' || value === 'server' || value === 'all')) source = value;
    else if (option === '--since' && value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) since = Date.parse(value);
    else if (option === '--limit' && value && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1000) limit = Number(value);
    else throw new Error('Usage: diagnostics [--paths] [--source controller|server|all] [--since ISO] [--limit 1..1000]');
  }
  const paths = { controller: join(directory, 'agent-host.log'), server: join(directory, 'relay-diagnostics.log') };
  const selected: Source[] = source === 'all' ? ['controller', 'server'] : [source];
  const result: Partial<Record<Source, unknown>> = {};
  for (const key of selected) result[key] = pathsOnly ? paths[key] : await readRecords(paths[key], key, since, limit);
  print(`${JSON.stringify(result, null, 2)}\n`);
}

async function readRecords(path: string, source: Source, since: number | undefined, limit: number): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (let archive = DEFAULT_DIAGNOSTIC_LOG_ARCHIVES; archive >= 0; archive--) {
    const text = await readBoundedTail(archive === 0 ? path : `${path}.${archive}`);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { if (source === 'server' || since !== undefined) continue; entry = { message: line }; }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (source === 'server' && !isRelayDiagnostic(entry)) continue;
      if (since !== undefined) {
        const record = entry as Record<string, unknown>;
        const timestamp = record.timestamp ?? record.time;
        if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) < since) continue;
      }
      entries.push(entry);
      if (entries.length > limit) entries.shift();
    }
  }
  return entries;
}

async function readBoundedTail(path: string): Promise<string> {
  let file;
  try { file = await open(path, 'r'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('Diagnostic log must be a regular file.');
    const length = Math.min(metadata.size, DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES + DEFAULT_DIAGNOSTIC_LINE_MAX_BYTES);
    const start = metadata.size - length;
    const buffer = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const { bytesRead } = await file.read(buffer, count, length - count, start + count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const text = buffer.subarray(0, count).toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { await file.close(); }
}
