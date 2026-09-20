import { CodexAppServerRpcError, type CodexAppServerTransport } from './app-server-transport.js';
import { isRecord, readString } from './native.js';

export const CODEX_HISTORY_PAGE_SIZE = 10;

/** A bounded native snapshot, with turns in chronological display order. */
export async function readCodexHistoryPage(
  transport: Pick<CodexAppServerTransport, 'request'>,
  threadId: string,
  options: { cursor?: string; metadata?: unknown } = {},
): Promise<{ thread: Record<string, unknown>; historyCursor?: string }> {
  let page: unknown;
  try {
    page = await transport.request('thread/turns/list', {
      threadId, limit: CODEX_HISTORY_PAGE_SIZE, sortDirection: 'desc', itemsView: 'full',
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
  } catch (error) {
    // Older native servers do not expose turn pagination. Never hide timeouts or malformed responses.
    if (options.cursor !== undefined || !(error instanceof CodexAppServerRpcError) || error.code !== -32601) throw error;
    const legacy = await transport.request('thread/read', { threadId, includeTurns: true });
    if (!isRecord(legacy) || !isRecord(legacy.thread) || legacy.thread.id !== threadId) throw new Error('Codex history returned an incompatible thread');
    return { ...legacy, thread: legacy.thread };
  }
  if (!isRecord(page) || !Array.isArray(page.data) || page.data.length > CODEX_HISTORY_PAGE_SIZE
    || page.data.some(turn => !isRecord(turn) || !readString(turn.id) || !Array.isArray(turn.items))) {
    throw new Error('Codex returned an invalid turn history page');
  }
  if (page.nextCursor != null && !readString(page.nextCursor)) throw new Error('Codex returned an invalid history cursor');
  const cursor = readString(page.nextCursor);
  if (cursor && cursor === options.cursor) throw new Error('Codex history cursor did not advance');
  const metadata = options.metadata ?? await transport.request('thread/read', { threadId, includeTurns: false });
  if (!isRecord(metadata) || !isRecord(metadata.thread) || metadata.thread.id !== threadId) throw new Error('Codex history returned an incompatible thread');
  return { ...metadata, thread: { ...metadata.thread, turns: [...page.data].reverse() }, ...(cursor ? { historyCursor: cursor } : {}) };
}
