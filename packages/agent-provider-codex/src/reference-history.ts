import type { AgentHistoryPage, AgentHistoryQuery } from '@agent-remote-controller/agent-provider-sdk';
import type { CodexAppServerTransport } from './app-server-transport.js';
import { isRecord, readString } from './native.js';
import { CodexEventProjector } from './projector.js';

/** Native pagination stays inside the adapter; source threads are never resumed. */
export async function readSessionHistoryPage(transport: Pick<CodexAppServerTransport, 'request'>, threadId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
  const limit = query.limit ?? 5;
  const textOffset = query.textOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(textOffset) || textOffset < 0) throw new Error('Invalid source history page bounds.');
  const search = query.query !== undefined;
  const response = await transport.request(search ? 'thread/searchOccurrences' : 'thread/items/list', {
    threadId, limit, ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(search ? { searchTerm: query.query } : { sortDirection: 'desc', ...(query.turnId ? { turnId: query.turnId } : {}) }),
  });
  if (!isRecord(response) || !Array.isArray(response.data)) throw new Error('Codex returned an invalid source history page.');
  const projector = new CodexEventProjector(threadId, { delivery: 'history' });
  const entries: AgentHistoryPage['entries'] = [];
  for (const value of response.data.slice(0, limit)) {
    if (!isRecord(value)) continue;
    const turnId = readString(value.turnId) ?? '';
    if (search) {
      const text = readString(value.snippet) ?? '';
      entries.push({ id: readString(value.itemId) ?? '', turnId, role: 'match', text: text.slice(textOffset, textOffset + 6000), textOffset, totalChars: text.length });
      continue;
    }
    if (!isRecord(value.item)) continue;
    const observation = projector.projectHistoryItem(value.item, turnId);
    if (observation?.event.type !== 'timeline') continue;
    const item = observation.event.item;
    // Binary media is not copied into text tool results.
    const text = item.type === 'user_message' || item.type === 'assistant_message' ? item.text
      : item.type === 'tool_call' ? JSON.stringify({ name: item.name, status: item.status, detail: item.detail, result: item.result, error: item.error }) : undefined;
    if (text === undefined) continue;
    entries.push({ id: readString(value.item.id) ?? '', turnId, role: item.type === 'user_message' ? 'user' : item.type === 'assistant_message' ? 'assistant' : 'tool',
      text: text.slice(textOffset, textOffset + 6000), textOffset, totalChars: text.length });
  }
  return { entries, ...(readString(response.nextCursor) ? { nextCursor: readString(response.nextCursor) } : {}) };
}
