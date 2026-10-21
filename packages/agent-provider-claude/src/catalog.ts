import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';

export interface ClaudeCatalog {
  list(): Promise<SDKSessionInfo[]>;
  rename?(sessionId: string, title: string): Promise<void>;
  info(sessionId: string): Promise<SDKSessionInfo | undefined>;
  messages(sessionId: string): Promise<SessionMessage[]>;
  /** Conversation rows for presentation, including input the native runtime folded into a running turn. */
  timelineMessages?(sessionId: string): Promise<SessionMessage[]>;
  history?(sessionId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage>;
  children?(sessionId: string): Promise<Array<{ id: string; messages: SessionMessage[] }>>;
  childMessages?(sessionId: string, childId: string): Promise<SessionMessage[]>;
}

/** SDK catalog APIs read process.env; a helper isolates each configured native home. */
export function createClaudeCatalog(env: NodeJS.ProcessEnv, timeout: number): ClaudeCatalog {
  async function execute<T>(operation: string, sessionId?: string, argument?: string): Promise<T> {
    if (operation === 'history' && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error('Claude source history requires a positive process deadline.');
    const { stdout } = await promisify(execFile)(process.execPath,
      [...(operation === 'history' ? ['--max-old-space-size=192'] : []), fileURLToPath(new URL('./catalog-worker.js', import.meta.url)), operation, ...(sessionId ? [sessionId] : []), ...(argument ? [argument] : [])],
      { env: { ...process.env, ...env }, timeout, maxBuffer: operation === 'history' ? 512 * 1024 : 32 * 1024 * 1024, encoding: 'utf8' })
      .catch(() => { throw new Error('Claude native catalog is unavailable.'); });
    return JSON.parse(stdout) as T;
  }
  return { rename: (id, title) => execute<void>('rename', id, title), list: () => execute('list'), info: async (id) => await execute<SDKSessionInfo | null>('info', id) ?? undefined,
    history: async (id, query) => {
      const result = await execute<{ page?: AgentHistoryPage; error?: string }>('history', id, JSON.stringify(query));
      if (!result.page || result.error) throw new Error(result.error ?? 'Claude source history is unavailable.');
      return result.page;
    },
    messages: (id) => execute('messages', id), timelineMessages: (id) => execute('timeline-messages', id), children: (id) => execute('children', id), childMessages: (id, child) => execute('child-messages', id, child) };
}
