import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeCatalog {
  list(): Promise<SDKSessionInfo[]>;
  rename?(sessionId: string, title: string): Promise<void>;
  info(sessionId: string): Promise<SDKSessionInfo | undefined>;
  messages(sessionId: string): Promise<SessionMessage[]>;
  children?(sessionId: string): Promise<Array<{ id: string; messages: SessionMessage[] }>>;
  childMessages?(sessionId: string, childId: string): Promise<SessionMessage[]>;
}

/** SDK catalog APIs read process.env; a helper isolates each configured native home. */
export function createClaudeCatalog(env: NodeJS.ProcessEnv, timeout: number): ClaudeCatalog {
  async function execute<T>(operation: string, sessionId?: string, argument?: string): Promise<T> {
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./catalog-worker.js', import.meta.url)), operation, ...(sessionId ? [sessionId] : []), ...(argument ? [argument] : [])],
      { env: { ...process.env, ...env }, timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })
      .catch(() => { throw new Error('Claude native catalog is unavailable.'); });
    return JSON.parse(stdout) as T;
  }
  return { rename: (id, title) => execute<void>('rename', id, title), list: () => execute('list'), info: async (id) => await execute<SDKSessionInfo | null>('info', id) ?? undefined,
    messages: (id) => execute('messages', id), children: (id) => execute('children', id), childMessages: (id, child) => execute('child-messages', id, child) };
}
