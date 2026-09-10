import { randomUUID } from 'node:crypto';
import type { CodexAppServerProvider } from '@borgee/agent-provider-codex';
import type { AgentPersistenceHandle, AgentSession } from '@borgee/agent-provider-sdk';
import type { RemoteSessionSummary } from '@agent-remote-control/dsh';
import type { SessionDirectorySource } from './session-directory.js';

/** Keeps unpersisted new threads alive until their first turn is written by Codex. */
export function createCodexDirectory(provider: Pick<CodexAppServerProvider, 'listSessions' | 'createSession' | 'resumeSession'> & Partial<Pick<CodexAppServerProvider, 'openChildSession'>>, workspace: string): SessionDirectorySource {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string }>();
  let discovery: Promise<RemoteSessionSummary[]> | undefined;
  let closed = false;
  async function discover(): Promise<RemoteSessionSummary[]> {
    const summaries = new Map<string, RemoteSessionSummary>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page = await provider.listSessions({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const summary of page.sessions) summaries.set(summary.nativeSessionId, summary);
      cursor = page.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('Codex returned a repeated catalog cursor.');
      cursors.add(cursor);
    }
    for (const [nativeSessionId, entry] of opened) {
      const info = await entry.session.runtimeInfo();
      const previous = summaries.get(nativeSessionId);
      summaries.set(nativeSessionId, {
        nativeSessionId, providerId: 'codex', title: previous?.title ?? 'New Codex session',
        workspace: info.cwd ?? previous?.workspace, model: info.model ?? undefined,
        createdAt: previous?.createdAt ?? entry.createdAt, updatedAt: previous?.updatedAt ?? entry.createdAt,
        state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting'
          : info.status === 'failed' ? 'unavailable' : 'idle',
      });
    }
    return [...summaries.values()];
  }
  async function remember(session: AgentSession): Promise<string> {
    try {
      if (closed) throw new Error('Codex directory is closed.');
      const info = await session.runtimeInfo();
      if (!info.persistence || !info.sessionId) throw new Error('Codex did not return a native persistence handle.');
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString() });
      return info.sessionId;
    } catch (error) { await session.dispose(); throw error; }
  }
  return {
    providerId: 'codex',
    list() {
      if (closed) throw new Error('Codex directory is closed.');
      return discovery ??= discover().finally(() => { discovery = undefined; });
    },
    workspaces: () => [{ id: workspace, path: workspace, name: workspace }],
    async create(input) {
      if (closed) throw new Error('Codex directory is closed.');
      if (input.workspaceId !== undefined && input.workspaceId !== workspace) throw new Error('Unknown Codex workspace.');
      return remember(await provider.createSession({ ...input, sessionId: randomUUID(), cwd: input.cwd ?? workspace }));
    },
    async open(nativeSessionId) {
      if (closed) throw new Error('Codex directory is closed.');
      const existing = opened.get(nativeSessionId);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const session = await provider.resumeSession(existing?.handle ?? { providerId: 'codex', sessionId: nativeSessionId, opaque: '{}' });
      await remember(session);
      return session;
    },
    async openChild(parentNativeSessionId, nativeSessionId) {
      if (closed) throw new Error('Codex directory is closed.');
      if (!provider.openChildSession) throw new Error('Native child attachment is unavailable.');
      return provider.openChildSession(parentNativeSessionId, nativeSessionId);
    },
    async close() {
      closed = true;
      await discovery?.catch(() => undefined);
      await Promise.all([...opened.values()].map(({ session }) => session.dispose()));
      opened.clear();
    },
  };
}
