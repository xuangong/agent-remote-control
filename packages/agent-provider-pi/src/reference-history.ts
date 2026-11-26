import { createHash } from 'node:crypto';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { PiProjector, type PiEntry } from './projector.js';
import { activeBranch, type PiSessionContent } from './session-file.js';

const MAX_ENTRIES = 16384;
const TEXT_PAGE = 6000;

export class PiHistoryError extends Error {}

/** A bounded page of a session's conversation as a person reads it, for a source reference: no private reasoning, no attached images. */
export function readPiHistoryPage(content: PiSessionContent, query: AgentHistoryQuery): AgentHistoryPage {
  const limit = query.limit ?? 5, textOffset = query.textOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(textOffset) || textOffset < 0
    || query.query !== undefined && (typeof query.query !== 'string' || !query.query || query.query.length > 200 || query.turnId !== undefined)
    || query.turnId !== undefined && (typeof query.turnId !== 'string' || !query.turnId || query.turnId.length > 4096)) throw new PiHistoryError('Invalid pi source history query.');
  const scope = createHash('sha256').update(JSON.stringify([content.header.id, query.query ?? null, query.turnId ?? null])).digest('hex');
  let after: string | undefined;
  if (query.cursor !== undefined) {
    try { const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { scope?: unknown; after?: unknown }; if (cursor.scope !== scope || typeof cursor.after !== 'string') throw new Error(); after = cursor.after; }
    catch { throw new PiHistoryError('Invalid pi source history cursor for this query.'); }
  }
  const projector = new PiProjector(content.header.cwd);
  let entries: Array<{ id: string; turnId: string; role: string; text: string }> = [];
  for (const row of projector.history(activeBranch(content.entries) as PiEntry[])) {
    if (row.event.type !== 'timeline') continue;
    const item = row.event.item, turnId = row.event.turnId ?? '';
    const role = item.type === 'user_message' ? 'user' : item.type === 'assistant_message' ? 'assistant' : item.type === 'tool_call' ? 'tool' : undefined;
    const text = item.type === 'user_message' || item.type === 'assistant_message' ? item.text
      : item.type === 'tool_call' ? JSON.stringify({ name: item.name, status: item.status, detail: item.detail, result: item.result, error: item.error }) : undefined;
    if (!role || text === undefined || query.turnId && query.turnId !== turnId) continue;
    entries.push({ id: row.key, turnId, role, text });
    if (entries.length > MAX_ENTRIES) throw new PiHistoryError('pi source history limit exceeded.');
  }
  if (query.query !== undefined) entries = entries.filter(entry => entry.role !== 'tool' && entry.text.toLowerCase().includes(query.query!.toLowerCase()));
  else entries.reverse();
  const offset = after === undefined ? 0 : entries.findIndex(entry => entry.id === after) + 1;
  if (after !== undefined && offset === 0) throw new PiHistoryError('pi source history changed; start a fresh query.');
  const page = entries.slice(offset, offset + limit);
  return { entries: page.map(entry => ({ ...entry, textOffset, totalChars: entry.text.length, text: entry.text.slice(textOffset, textOffset + TEXT_PAGE) })),
    ...(offset + page.length < entries.length ? { nextCursor: Buffer.from(JSON.stringify({ scope, after: page.at(-1)!.id })).toString('base64url') } : {}) };
}
