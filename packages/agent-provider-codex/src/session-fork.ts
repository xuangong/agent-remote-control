import type { CodexAppServerTransport } from './app-server-transport.js';
import { isRecord, readString } from './native.js';

/** A history fork creates no model turn and does not transfer native task ownership. */
export async function prepareNativeFork(transport: Pick<CodexAppServerTransport, 'request'>, nativeSessionId: string): Promise<{ cwd: string; lastTurnId: string | null }> {
  const metadata = await transport.request('thread/read', { threadId: nativeSessionId, includeTurns: false });
  if (!isRecord(metadata) || !isRecord(metadata.thread) || metadata.thread.id !== nativeSessionId || !readString(metadata.thread.cwd)) throw new Error('The source conversation and workspace could not be verified.');
  if (isRecord(metadata.thread.source) && 'subAgent' in metadata.thread.source) throw new Error('Native child conversations cannot become handoff sources.');
  const history = await transport.request('thread/turns/list', { threadId: nativeSessionId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
  if (!isRecord(history) || !Array.isArray(history.data) || history.data.length > 1 || !history.data.length && history.nextCursor) throw new Error('The source history boundary is unavailable.');
  const last = history.data[0];
  if (last !== undefined && (!isRecord(last) || !readString(last.id) || !['completed', 'interrupted', 'failed'].includes(String(last.status)))) throw new Error('Wait for the source turn to finish before forking settled history.');
  return { cwd: metadata.thread.cwd as string, lastTurnId: last?.id ?? null };
}
