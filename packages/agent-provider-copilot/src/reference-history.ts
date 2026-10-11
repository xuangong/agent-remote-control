import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { Projector, record } from './projector.js';

const maxEvents = 4096;
const maxBytes = 8 * 1024 * 1024;
type ReadEvents = CopilotSession['rpc']['eventLog']['read'];
interface HistoryCursor { version: 1; source: string; query: string | null; limit: number; position: number; fingerprint: string }
export class CopilotHistoryError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (events: SessionEvent[]) => createHash('sha256').update(JSON.stringify(events)).digest('hex');

/** Cold reads interpret the native persisted SessionEvent log without resuming or claiming the source. */
export async function readCopilotHistoryPage(profile: string, sessionId: string, query: AgentHistoryQuery, read?: ReadEvents): Promise<AgentHistoryPage> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new CopilotHistoryError('Invalid Copilot source session identity.');
  const { limit, textOffset, search, cursor } = parseQuery(sessionId, query);
  const load = () => read ? readOpenEvents(sessionId, read) : readStoredEvents(profile, sessionId);
  const events = await load(), fingerprint = digest(events);
  if (cursor && cursor.fingerprint !== fingerprint) throw new CopilotHistoryError('Copilot source history changed; start a new query.');
  // Public event pagination and native files have no atomic snapshot guarantee.
  if (digest(await load()) !== fingerprint) throw new CopilotHistoryError('Copilot source history changed during observation; retry a new query.');
  const primary = events.filter(event => !event.agentId && !record(event.data).parentToolCallId && !record(event.data).agentId
    && !event.type.endsWith('_delta') && !event.ephemeral);
  const projector = new Projector(); projector.prepareHistory(primary);
  const projected = new Map<string, AgentHistoryPage['entries'][number]>();
  let normalizedBytes = 0;
  for (const event of primary) for (const observation of projector.projectAll(event, 'history')) {
    if (observation.event.type !== 'timeline') continue;
    const item = observation.event.item;
    const role = item.type === 'user_message' ? 'user' : item.type === 'assistant_message' ? 'assistant' : item.type === 'tool_call' ? 'tool' : undefined;
    const text = item.type === 'user_message' || item.type === 'assistant_message' ? item.text
      : item.type === 'tool_call' ? JSON.stringify({ name: item.name, status: item.status, detail: item.detail, result: item.result, error: item.error }) : undefined;
    if (!role || text === undefined) continue;
    // Native model-step numbers do not establish a stable user-turn grouping.
    const entry = { id: observation.key, turnId: '', role, text, textOffset: 0, totalChars: text.length };
    normalizedBytes += Buffer.byteLength(JSON.stringify(entry));
    if (normalizedBytes > maxBytes || projected.size >= 16384) throw new CopilotHistoryError('Copilot normalized source history limit exceeded.');
    projected.set(observation.key, entry);
  }
  let entries = [...projected.values()];
  if (search === null) entries.reverse();
  else entries = entries.filter(entry => entry.role !== 'tool' && entry.text.toLowerCase().includes(search.toLowerCase()));
  const position = cursor?.position ?? 0;
  if (cursor && position >= entries.length) throw new CopilotHistoryError('Invalid Copilot history cursor position.');
  const page = entries.slice(position, position + limit).map(entry => ({ ...entry, text: entry.text.slice(textOffset, textOffset + 6000), textOffset }));
  const nextPosition = position + page.length;
  return { entries: page, ...(nextPosition < entries.length ? { nextCursor: Buffer.from(JSON.stringify({
    version: 1, source: sessionId, query: search, limit, position: nextPosition, fingerprint,
  } satisfies HistoryCursor)).toString('base64url') } : {}) };
}

function parseQuery(sessionId: string, query: AgentHistoryQuery) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['cursor', 'turnId', 'query', 'limit', 'textOffset'].includes(key))) throw new CopilotHistoryError('Invalid Copilot history query.');
  const limit = query.limit ?? 5, textOffset = query.textOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(textOffset) || textOffset < 0
    || query.query !== undefined && (typeof query.query !== 'string' || !query.query || query.query.length > 200)
    || query.turnId !== undefined && (typeof query.turnId !== 'string' || !query.turnId || query.turnId.length > 4096)
    || query.turnId !== undefined && query.query !== undefined) throw new CopilotHistoryError('Invalid Copilot history page bounds or query.');
  if (query.turnId !== undefined) throw new CopilotHistoryError('Copilot source turn reads are unsupported by native event history.');
  const search = query.query ?? null;
  let cursor: HistoryCursor | undefined;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 4096) throw new CopilotHistoryError('Invalid Copilot history cursor.');
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!object(cursor) || Object.keys(cursor).sort().join(',') !== 'fingerprint,limit,position,query,source,version'
        || cursor.version !== 1 || cursor.source !== sessionId || cursor.query !== search || cursor.limit !== limit
        || !Number.isSafeInteger(cursor.position) || cursor.position < 1 || cursor.position > maxEvents
        || typeof cursor.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint)) throw new Error();
    } catch { throw new CopilotHistoryError('Invalid Copilot history cursor for this source and query.'); }
  }
  return { limit, textOffset, search, cursor };
}

async function readOpenEvents(sessionId: string, read: ReadEvents): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [], cursors = new Set<string>();
  let cursor: string | undefined, bytes = 0;
  for (let page = 0; page <= maxEvents / 256; page++) {
    const result = await read({ cursor, max: 256, waitMs: 0, agentScope: 'primary', includeEphemeral: false });
    if (!Array.isArray(result.events) || typeof result.cursor !== 'string' || result.cursor.length > 16384
      || typeof result.hasMore !== 'boolean' || result.cursorStatus !== 'ok') throw new CopilotHistoryError('Copilot native source history is unavailable or changed during pagination.');
    bytes += Buffer.byteLength(JSON.stringify(result.events));
    if (bytes > maxBytes || events.length + result.events.length > maxEvents || result.events.length > 256) throw new CopilotHistoryError('Copilot source history scan limit exceeded.');
    events.push(...result.events);
    if (!result.hasMore) return validateEvents(events, sessionId);
    if (!result.events.length || !result.cursor || cursors.has(result.cursor)) throw new CopilotHistoryError('Copilot source history pagination did not advance.');
    cursors.add(result.cursor); cursor = result.cursor;
  }
  throw new CopilotHistoryError('Copilot source history page limit exceeded.');
}

async function readStoredEvents(profile: string, sessionId: string): Promise<SessionEvent[]> {
  let canonical: string, directory: string;
  try {
    canonical = await realpath(profile);
    directory = join(canonical, 'session-state', sessionId);
    if (await realpath(directory) !== directory) throw new CopilotHistoryError('Copilot source history path is outside its profile scope.');
  } catch (error) {
    if (error instanceof CopilotHistoryError) throw error;
    throw new CopilotHistoryError('Copilot native source session is unavailable.');
  }
  const path = join(directory, 'events.jsonl');
  const pathBefore = await scopedFile(path, directory);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new CopilotHistoryError('Copilot native source history is unavailable.'); });
  let text: string;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) throw new CopilotHistoryError('Copilot native source history is unavailable.');
    if (before.size > maxBytes) throw new CopilotHistoryError('Copilot source history byte limit exceeded.');
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    const pathAfter = await scopedFile(path, directory);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) throw new CopilotHistoryError('Copilot source history changed during observation.');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new CopilotHistoryError('Copilot source history contains invalid text.'); }
  } finally { await file.close(); }
  if (!text.endsWith('\n')) throw new CopilotHistoryError('Copilot native source history is incomplete or unavailable.');
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length > maxEvents) throw new CopilotHistoryError('Copilot source history scan limit exceeded.');
  let rows: unknown[];
  try { rows = lines.map(line => JSON.parse(line)); }
  catch { throw new CopilotHistoryError('Copilot source history contains invalid native events.'); }
  return validateEvents(rows, sessionId);
}

async function scopedFile(path: string, directory: string) {
  try {
    const info = await lstat(path);
    // Real paths and identities enforce the scope on platforms without O_NOFOLLOW.
    if (info.isSymbolicLink() || !info.isFile() || await realpath(directory) !== directory || await realpath(path) !== path) {
      throw new CopilotHistoryError('Copilot source history path is outside its profile scope.');
    }
    return info;
  } catch (error) {
    if (error instanceof CopilotHistoryError) throw error;
    throw new CopilotHistoryError('Copilot native source history is unavailable.');
  }
}

function validateEvents(events: unknown[], sessionId: string): SessionEvent[] {
  const seen = new Set<string>(); let start = false;
  for (const event of events) {
    if (!object(event) || typeof event.id !== 'string' || !event.id || event.id.length > 4096
      || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))
      || typeof event.type !== 'string' || !event.type || !object(event.data)) throw new CopilotHistoryError('Copilot source history contains invalid native events.');
    if (seen.has(event.id)) throw new CopilotHistoryError('Copilot source history repeated a native event identity.');
    seen.add(event.id);
    if (event.type === 'session.start') {
      if (start || event.data.sessionId !== sessionId) throw new CopilotHistoryError('Copilot source history identity does not match.');
      start = true;
    }
    if (['user.message', 'assistant.message'].includes(event.type) && typeof event.data.content !== 'string'
      || event.type === 'assistant.message' && typeof event.data.messageId !== 'string'
      || event.type === 'tool.execution_start' && (typeof event.data.toolCallId !== 'string' || typeof event.data.toolName !== 'string')
      || event.type === 'tool.execution_complete' && (typeof event.data.toolCallId !== 'string' || typeof event.data.success !== 'boolean')) throw new CopilotHistoryError('Copilot source history contains unsupported native content.');
  }
  if (!start) throw new CopilotHistoryError('Copilot source history has no verified native session identity.');
  return events as SessionEvent[];
}
