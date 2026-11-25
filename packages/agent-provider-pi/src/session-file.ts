import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord, record, str } from './native.js';
import { userText, type PiEntry } from './projector.js';

export interface PiSessionHeader { id: string; cwd: string; timestamp: string; parentSession?: string }
export interface PiSessionContent { header: PiSessionHeader; entries: PiEntry[] }

/** Where pi keeps its profile: `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. */
export function piAgentDirectory(env: Record<string, string | undefined>): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME ?? env.USERPROFILE ?? homedir(), '.pi', 'agent');
}
/** Where pi keeps its sessions: `PI_CODING_AGENT_SESSION_DIR`, or `sessions` in the profile. */
export function piSessionDirectory(env: Record<string, string | undefined>): string {
  return env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(piAgentDirectory(env), 'sessions');
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validPiSessionId = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id);

/** Parses a session file: its header, then its entries. A line that is not JSON (a write cut short) is left out. */
export function parsePiSession(text: string): PiSessionContent | undefined {
  let header: PiSessionHeader | undefined;
  const entries: PiEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isRecord(value) || typeof value.type !== 'string') continue;
    if (value.type === 'session') {
      if (header || !validPiSessionId(value.id) || typeof value.cwd !== 'string') return undefined;
      header = { id: value.id, cwd: value.cwd, timestamp: str(value.timestamp) ?? '', ...(typeof value.parentSession === 'string' ? { parentSession: value.parentSession } : {}) };
    } else if (header) entries.push(value as PiEntry);
  }
  return header ? { header, entries } : undefined;
}

/** The entries from the root to the leaf: the leaf is the last entry written, as pi continues from it. */
export function activeBranch(entries: readonly PiEntry[]): PiEntry[] {
  const byId = new Map<string, PiEntry>();
  for (const entry of entries) if (typeof entry.id === 'string') byId.set(entry.id, entry);
  const branch: PiEntry[] = [];
  const seen = new Set<string>();
  for (let entry: PiEntry | undefined = entries.at(-1); entry; entry = typeof entry.parentId === 'string' ? byId.get(entry.parentId) : undefined) {
    if (typeof entry.id === 'string') { if (seen.has(entry.id)) break; seen.add(entry.id); }
    branch.push(entry);
  }
  return branch.reverse();
}

/** The display name set with `/name`, else the first prompt. */
export function sessionTitle(entries: readonly PiEntry[]): string | undefined {
  const named = [...entries].reverse().find(entry => entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim());
  if (named) return String(named.name).trim();
  const first = entries.find(entry => entry.type === 'message' && record(entry.message).role === 'user');
  const text = first ? userText(record(first.message).content).replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, 120) : undefined;
}

export interface PiSessionFileSummary { id: string; path: string; cwd: string; title?: string; createdAt: number; updatedAt: number }

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

/** Reads what a listing needs without loading a long session: its head and its tail. */
async function readHeadTail(path: string): Promise<{ text: string; size: number; mtimeMs: number } | undefined> {
  let handle;
  try { handle = await open(path, 'r'); } catch { return undefined; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const head = Buffer.alloc(Math.min(info.size, HEAD_BYTES));
    await handle.read(head, 0, head.length, 0);
    let text = head.toString('utf8');
    if (info.size > HEAD_BYTES) {
      const tailLength = Math.min(TAIL_BYTES, info.size - HEAD_BYTES);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, info.size - tailLength);
      // The head and the tail may cut a line; the parser leaves those out.
      text += `\n${tail.toString('utf8')}`;
    }
    return { text, size: info.size, mtimeMs: info.mtimeMs };
  } finally { await handle.close(); }
}

/** The session files under a sessions directory. */
export async function listPiSessionFiles(sessionDirectory: string): Promise<PiSessionFileSummary[]> {
  let folders: string[];
  try { folders = await readdir(sessionDirectory); } catch { return []; }
  const summaries: PiSessionFileSummary[] = [];
  for (const folder of folders) {
    let files: string[];
    try { files = await readdir(join(sessionDirectory, folder)); } catch { continue; }
    for (const file of files) {
      const id = /_([0-9a-f-]{36})\.jsonl$/i.exec(file)?.[1];
      if (!id || !validPiSessionId(id)) continue;
      const path = join(sessionDirectory, folder, file);
      const read = await readHeadTail(path);
      const parsed = read && parsePiSession(read.text);
      if (!read || !parsed || parsed.header.id !== id) continue;
      const title = sessionTitle(parsed.entries);
      summaries.push({ id, path, cwd: parsed.header.cwd, ...(title ? { title } : {}), createdAt: Date.parse(parsed.header.timestamp) || read.mtimeMs, updatedAt: read.mtimeMs });
    }
  }
  return summaries;
}

/** The file of a session by its id, or undefined when no session of that id exists. */
export async function findPiSessionFile(sessionDirectory: string, id: string): Promise<string | undefined> {
  if (!validPiSessionId(id)) return undefined;
  let folders: string[];
  try { folders = await readdir(sessionDirectory); } catch { return undefined; }
  for (const folder of folders) {
    let files: string[];
    try { files = await readdir(join(sessionDirectory, folder)); } catch { continue; }
    const file = files.find(name => name.endsWith(`_${id}.jsonl`));
    if (file) return join(sessionDirectory, folder, file);
  }
  return undefined;
}

/** A whole session file, parsed; undefined when it is missing or is not a pi session. */
export async function readPiSession(path: string): Promise<PiSessionContent | undefined> {
  let text: string;
  try { if (!(await stat(path)).isFile()) return undefined; text = await readFile(path, 'utf8'); } catch { return undefined; }
  return parsePiSession(text);
}

/** The model and thinking level a session last used, from its model and thinking entries (the file records every change). */
export function lastSelections(entries: readonly PiEntry[]): { model?: string; thinkingLevel?: string } {
  let model: string | undefined, thinkingLevel: string | undefined;
  for (const entry of entries) {
    if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') model = `${entry.provider}/${entry.modelId}`;
    if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') thinkingLevel = entry.thinkingLevel;
  }
  return { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
}
