import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseRecording, type SessionRecording } from './recording.js';

export interface RecordingDirectory {
  directory: string;
  parent: string;
  entries: { name: string; path: string; type: 'directory' | 'recording' }[];
  truncated: boolean;
}
export async function readRecordingFile(path: string): Promise<SessionRecording> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const limit = 64 * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error('Select a regular JSONL file no larger than 64 MiB.');
    const parts: Buffer[] = []; let bytes = 0;
    for await (const part of file.createReadStream({ start: 0, end: limit, autoClose: false })) {
      bytes += part.length;
      if (bytes > limit) throw new Error('Recording exceeds 64 MiB.');
      parts.push(part);
    }
    return parseRecording(Buffer.concat(parts).toString('utf8'));
  } finally { await file.close(); }
}
export async function serveRecordingFiles(request: IncomingMessage, response: ServerResponse, url: string, baseDirectory: string): Promise<boolean> {
  const target = new URL(request.url ?? '/', url);
  if (!['/__ardb/files', '/__ardb/files/open'].includes(target.pathname)) return false;
  if (request.method !== 'GET') { response.writeHead(405).end(); return true; }
  try {
    let result: RecordingDirectory | { name: string; recording: SessionRecording };
    if (target.pathname.endsWith('/open')) {
      const path = resolve(baseDirectory, target.searchParams.get('path') ?? '');
      if (!['.jsonl', '.ndjson'].includes(extname(path).toLowerCase())) throw new Error('Select a .jsonl or .ndjson recording.');
      result = { name: basename(path), recording: await readRecordingFile(path) };
    } else {
      const directory = await realpath(resolve(baseDirectory, target.searchParams.get('directory') || '.'));
      const entries: RecordingDirectory['entries'] = [];
      let scanned = 0, truncated = false;
      for await (const entry of await opendir(directory)) {
        if (++scanned > 10000 || entries.length >= 1000) { truncated = true; break; }
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory() || entry.isFile() && ['.jsonl', '.ndjson'].includes(extname(entry.name).toLowerCase())) {
          entries.push({ name: entry.name, path: join(directory, entry.name), type: entry.isDirectory() ? 'directory' : 'recording' });
        }
      }
      entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
      result = { directory, parent: dirname(directory), entries, truncated };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Cannot read recording.' }));
  }
  return true;
}
