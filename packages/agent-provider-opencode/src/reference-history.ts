import { createHash } from 'node:crypto';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import type { NativeMessage } from './normalize.js';
import type { OpenCodeTransport } from './transport.js';

/** Source reads never resume native sessions or expose private reasoning or binary attachments. */
export async function readReferenceHistory(transport: OpenCodeTransport, id: string, cwd: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
  const limit = query.limit ?? 5, textOffset = query.textOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(textOffset) || textOffset < 0 ||
    (query.query !== undefined && (typeof query.query !== 'string' || !query.query || query.query.length > 200 || query.turnId !== undefined))) throw new Error('Invalid OpenCode source history query.');
  const scope = createHash('sha256').update(JSON.stringify([id, query.query ?? null, query.turnId ?? null])).digest('hex');
  let after: string | undefined;
  if (query.cursor !== undefined) {
    try { const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); if (cursor.scope !== scope || typeof cursor.after !== 'string') throw new Error(); after = cursor.after; }
    catch { throw new Error('Invalid OpenCode source history cursor for this query.'); }
  }
  const native = new Map<string, NativeMessage>();
  const cursors = new Set<string>();
  let before: string | undefined;
  const deadline = Date.now() + 10000;
  for (let pageIndex = 0; ; pageIndex++) {
    if (pageIndex >= 50 || Date.now() >= deadline) throw new Error('OpenCode source history exceeds the bounded read budget.');
    const page = await transport.requestWithResponse(() => transport.client.session.messages({ sessionID: id, directory: cwd, limit: 100, ...(before ? { before } : {}) }));
    for (const message of page.data) native.set(message.info.id, message);
    const next = page.response.headers.get('x-next-cursor');
    if (!next) break;
    if (!query.query) {
      const available = projectEntries([...native.values()], query);
      const anchor = after === undefined ? -1 : available.findIndex(entry => entry.id === after);
      if ((after === undefined || anchor >= 0) && available.length - anchor - 1 > limit) break;
    }
    if (cursors.has(next)) throw new Error('OpenCode source history pagination did not advance.');
    cursors.add(next); before = next;
  }
  const entries = projectEntries([...native.values()], query);
  const offset = after === undefined ? 0 : entries.findIndex(entry => entry.id === after) + 1;
  if (after !== undefined && offset === 0) throw new Error('OpenCode source history changed; start a fresh query.');
  const page = entries.slice(offset, offset + limit);
  return { entries: page.map(entry => ({ ...entry, textOffset, totalChars: entry.text.length, text: entry.text.slice(textOffset, textOffset + 6000) })),
    ...(offset + page.length < entries.length ? { nextCursor: Buffer.from(JSON.stringify({ scope, after: page.at(-1)!.id })).toString('base64url') } : {}) };
}

function projectEntries(native: NativeMessage[], query: AgentHistoryQuery) {
  const entries: Array<{ id: string; turnId: string; role: string; text: string }> = [];
  const messages = native.sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id));
  for (const { info, parts } of messages) {
    const turnId = info.role === 'user' ? info.id : info.parentID;
    if (query.turnId && query.turnId !== turnId) continue;
    const text = parts.flatMap(part => part.type === 'text' && !part.ignored && !part.synthetic ? [part.text] : []).join('\n');
    const visible = info.role === 'user' || info.role === 'assistant' && !info.summary && typeof info.time.completed === 'number' && typeof info.finish === 'string' && !['tool-calls', 'unknown'].includes(info.finish);
    if (text && (!query.query || visible && text.toLowerCase().includes(query.query.toLowerCase()))) entries.push({ id: info.id, turnId, role: info.role, text });
    if (query.query) continue;
    for (const part of parts) if (part.type === 'tool') {
      const state = part.state;
      entries.push({ id: `${info.id}:${part.id}`, turnId, role: 'tool', text: JSON.stringify({ name: part.tool, status: state.status, input: state.input,
        ...(state.status === 'completed' ? { output: state.output } : state.status === 'error' ? { error: state.error } : {}) }) });
    }
  }
  if (!query.query) entries.reverse();
  return entries;
}
