import { createHash } from 'node:crypto';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { nativeHistory } from './native-history.js';
import { nativeError } from './normalize.js';
import { turnIds, type NativeMessage } from './v2-native.js';
import type { OpenCodeTransport } from './transport.js';

/** Source reads never resume native sessions or expose private reasoning or binary attachments. */
export async function readReferenceHistory(transport: OpenCodeTransport, id: string, _cwd: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
  const limit = query.limit ?? 5, textOffset = query.textOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(textOffset) || textOffset < 0 ||
    (query.query !== undefined && (typeof query.query !== 'string' || !query.query || query.query.length > 200 || query.turnId !== undefined))) throw new Error('Invalid OpenCode source history query.');
  const scope = createHash('sha256').update(JSON.stringify([id, query.query ?? null, query.turnId ?? null])).digest('hex');
  let after: string | undefined;
  if (query.cursor !== undefined) {
    try { const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); if (cursor.scope !== scope || typeof cursor.after !== 'string') throw new Error(); after = cursor.after; }
    catch { throw new Error('Invalid OpenCode source history cursor for this query.'); }
  }
  // A page may begin with a steer. Read the complete bounded history before assigning turns.
  const entries = projectEntries(await nativeHistory(transport, id), query);
  const offset = after === undefined ? 0 : entries.findIndex(entry => entry.id === after) + 1;
  if (after !== undefined && offset === 0) throw new Error('OpenCode source history changed; start a fresh query.');
  const page = entries.slice(offset, offset + limit);
  return { entries: page.map(entry => ({ ...entry, textOffset, totalChars: entry.text.length, text: entry.text.slice(textOffset, textOffset + 6000) })),
    ...(offset + page.length < entries.length ? { nextCursor: Buffer.from(JSON.stringify({ scope, after: page.at(-1)!.id })).toString('base64url') } : {}) };
}

function projectEntries(messages: readonly NativeMessage[], query: AgentHistoryQuery) {
  const entries: Array<{ id: string; turnId: string; role: string; text: string }> = [];
  const turns = turnIds(messages, { startsAtBeginning: true });
  for (const message of messages) {
    const turnId = turns.get(message.id);
    if (!turnId || query.turnId && query.turnId !== turnId) continue;
    if (message.type === 'shell' && !query.query) {
      entries.push({ id: message.id, turnId, role: 'tool', text: JSON.stringify({ name: 'shell', status: message.status, input: { command: message.command }, ...(message.output ? { output: message.output.output } : {}) }) });
      continue;
    }
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    const text = message.type === 'user' ? message.text : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const visible = message.type === 'user' || typeof message.time.completed === 'number' && typeof message.finish === 'string' && !['tool-calls', 'unknown'].includes(message.finish);
    if (text && (!query.query || visible && text.toLowerCase().includes(query.query.toLowerCase()))) entries.push({ id: message.id, turnId, role: message.type, text });
    if (query.query || message.type !== 'assistant') continue;
    for (const part of message.content) if (part.type === 'tool') {
      const state = part.state;
      entries.push({ id: `${message.id}:${part.id}`, turnId, role: 'tool', text: JSON.stringify({ name: part.name, status: state.status, input: state.input,
        ...(state.status === 'completed' || state.status === 'error' ? { output: (state.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') } : {}),
        ...(state.status === 'error' ? { error: nativeError(state.error) } : {}) }) });
    }
  }
  if (!query.query) entries.reverse();
  return entries;
}
