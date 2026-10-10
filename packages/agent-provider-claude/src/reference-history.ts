import type { GetSessionMessagesOptions, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { createHash } from 'node:crypto';
import { ClaudeEventProjector, record } from './projector.js';
import { ClaudeImageRegistry } from './images.js';

const maxRows = 2048;
const maxBytes = 8 * 1024 * 1024;
export class ClaudeHistoryError extends Error {}
interface HistoryCursor { version: 1; source: string; query: string | null; limit: number; position: number; fingerprint: string }

export interface ClaudeHistoryCatalog {
  info(sessionId: string): Promise<SDKSessionInfo | undefined>;
  messages(sessionId: string, options: GetSessionMessagesOptions): Promise<SessionMessage[]>;
}

/** The public SDK may parse the transcript internally; these bounds limit returned native rows and adapter work. */
export async function readClaudeHistoryPage(catalog: ClaudeHistoryCatalog, sessionId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new ClaudeHistoryError('Invalid Claude session identity.');
  const { limit, textOffset, search, cursor } = parseQuery(sessionId, query);
  const info = await catalog.info(sessionId);
  if (!info) throw new ClaudeHistoryError('Claude native source session is unavailable.');
  if (info.sessionId !== sessionId) throw new ClaudeHistoryError('Claude catalog source identity does not match.');
  const rows = await readRows(catalog, sessionId);
  const fingerprint = digest(rows);
  if (cursor && cursor.fingerprint !== fingerprint) throw new ClaudeHistoryError('Claude source history changed; start a new query.');
  // Offset-based public reads have no atomic snapshot guarantee. A second bounded observation detects changes, not native quiescence.
  if (digest(await readRows(catalog, sessionId)) !== fingerprint) throw new ClaudeHistoryError('Claude source history changed during observation; retry a new query.');
  const images = new ClaudeImageRegistry(sessionId, { maxImages: 0 });
  const projector = new ClaudeEventProjector(sessionId, 'history', images);
  const entries: AgentHistoryPage['entries'] = [];
  let normalizedBytes = 0;
  try {
    for (const row of rows) {
      for (const observation of projector.project(row)) {
        if (observation.event.type !== 'timeline') continue;
        const item = observation.event.item;
        const toolImage = observation.sourceKey.includes(':image:');
        const role = toolImage ? 'tool' : item.type === 'user_message' ? 'user' : item.type === 'assistant_message' ? 'assistant' : item.type === 'tool_call' ? 'tool' : undefined;
        const text = item.type === 'user_message' || item.type === 'assistant_message' ? item.text
          : item.type === 'tool_call' ? JSON.stringify({ name: item.name, status: item.status, detail: item.detail, result: item.result, error: item.error }) : undefined;
        const searchText = item.type === 'user_message' && item.content
          ? item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : text;
        if (!role || text === undefined) continue;
        // SessionMessage carries native row UUIDs, but no authoritative turn grouping.
        const entry = { id: observation.sourceKey, turnId: '', role, text, textOffset: 0, totalChars: text.length };
        normalizedBytes += Buffer.byteLength(JSON.stringify(entry));
        if (normalizedBytes > maxBytes || entries.length >= 16384) throw new ClaudeHistoryError('Claude normalized source history limit exceeded; complete bounded reads are unsupported.');
        if (search !== null && (role === 'tool' || !searchText?.toLowerCase().includes(search.toLowerCase()))) continue;
        entries.push(entry);
      }
    }
  } finally { images.stop(); }
  if (search === null) entries.reverse();
  const position = cursor?.position ?? 0;
  if (cursor && position >= entries.length) throw new ClaudeHistoryError('Invalid Claude history cursor position.');
  const page = entries.slice(position, position + limit).map(entry => ({ ...entry, text: entry.text.slice(textOffset, textOffset + 6000), textOffset }));
  const nextPosition = position + page.length;
  return { entries: page, ...(nextPosition < entries.length ? { nextCursor: Buffer.from(JSON.stringify({
    version: 1, source: sessionId, query: search, limit, position: nextPosition, fingerprint,
  } satisfies HistoryCursor)).toString('base64url') } : {}) };
}

function parseQuery(sessionId: string, query: AgentHistoryQuery) {
  if (!record(query) || Object.keys(query).some(key => !['cursor', 'turnId', 'query', 'limit', 'textOffset'].includes(key))) throw new ClaudeHistoryError('Invalid Claude history query.');
  const limit = query.limit ?? 5, textOffset = query.textOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(textOffset) || textOffset < 0
    || query.query !== undefined && (typeof query.query !== 'string' || !query.query || query.query.length > 200)
    || query.turnId !== undefined && (typeof query.turnId !== 'string' || !query.turnId || query.turnId.length > 4096)
    || query.turnId !== undefined && query.query !== undefined) throw new ClaudeHistoryError('Invalid Claude history page bounds or query.');
  if (query.turnId !== undefined) throw new ClaudeHistoryError('Claude source turn reads are unsupported by the public catalog.');
  const search = query.query ?? null;
  let cursor: HistoryCursor | undefined;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 4096) throw new ClaudeHistoryError('Invalid Claude history cursor.');
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!record(cursor) || Object.keys(cursor).sort().join(',') !== 'fingerprint,limit,position,query,source,version'
        || cursor.version !== 1 || cursor.source !== sessionId || cursor.query !== search || cursor.limit !== limit
        || !Number.isSafeInteger(cursor.position) || cursor.position < 1 || cursor.position > maxRows * 100
        || typeof cursor.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint)) throw new ClaudeHistoryError();
    } catch { throw new ClaudeHistoryError('Invalid Claude history cursor for this source and query.'); }
  }
  return { limit, textOffset, search, cursor };
}

async function readRows(catalog: ClaudeHistoryCatalog, sessionId: string): Promise<SessionMessage[]> {
  const rows = await catalog.messages(sessionId, { limit: maxRows + 1, offset: 0 });
  if (!Array.isArray(rows)) throw new ClaudeHistoryError('Claude catalog returned invalid source history.');
  if (rows.length > maxRows) throw new ClaudeHistoryError('Claude source history scan limit exceeded; complete bounded reads are unsupported.');
  let bytes = 0;
  let blocks = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!record(row) || row.session_id !== sessionId || typeof row.uuid !== 'string' || !row.uuid || row.uuid.length > 4096
      || !['user', 'assistant', 'system'].includes(row.type) || row.parent_tool_use_id !== null || row.parent_agent_id !== null
      || !record(row.message) || !(typeof row.message.content === 'string' || Array.isArray(row.message.content))) throw new ClaudeHistoryError('Claude catalog returned invalid source message identity or content.');
    if (seen.has(row.uuid)) throw new ClaudeHistoryError('Claude catalog repeated a source message identity.');
    seen.add(row.uuid);
    if (Array.isArray(row.message.content)) {
      blocks += row.message.content.length;
      if (row.message.content.length > 256 || blocks > 8192) throw new ClaudeHistoryError('Claude source history projection limit exceeded; complete bounded reads are unsupported.');
      for (const block of row.message.content) validateContentBlock(block, row.type);
    }
    bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (bytes > maxBytes) throw new ClaudeHistoryError('Claude source history byte limit exceeded; complete bounded reads are unsupported.');
  }
  return rows;
}

function validateContentBlock(block: unknown, role: SessionMessage['type']): void {
  if (!record(block)) throw new ClaudeHistoryError('Unsupported Claude source content block.');
  if (block.type === 'text' && typeof block.text === 'string' || role === 'assistant' && block.type === 'thinking' && typeof block.thinking === 'string'
    || role === 'assistant' && block.type === 'redacted_thinking') return;
  if (role === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && record(block.input)) return;
  if (role === 'user' && block.type === 'image') return;
  if (role === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
    && (typeof block.content === 'string' || Array.isArray(block.content))) {
    if (Array.isArray(block.content)) {
      if (block.content.length > 256) throw new ClaudeHistoryError('Claude source history projection limit exceeded.');
      for (const part of block.content) if (!record(part) || !(part.type === 'text' && typeof part.text === 'string' || part.type === 'image')) throw new ClaudeHistoryError('Unsupported Claude source tool content block.');
    }
    return;
  }
  throw new ClaudeHistoryError('Unsupported Claude source content block.');
}

function digest(rows: SessionMessage[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
}
