import { randomUUID } from 'node:crypto';
import type { CodexAppServerProvider, CodexSessionSummary } from '@borgee/agent-provider-codex';
import type { AgentPersistenceHandle, AgentSession } from '@borgee/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

/** Keeps new native sessions alive before and after their relay projection is attached. */
export function createCodexSessionDirectory(
  provider: Pick<CodexAppServerProvider, 'listSessions' | 'createSession' | 'resumeSession' | 'openChildSession'>,
  workspaces: readonly AgentHostWorkspace[],
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string }>();
  let discovery: Promise<CodexSessionSummary[]> | undefined;
  let closed = false;
  async function discover(): Promise<CodexSessionSummary[]> {
    const summaries = new Map<string, CodexSessionSummary>();
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
      summaries.set(nativeSessionId, { nativeSessionId, providerId: 'codex', title: previous?.title ?? 'New Codex session',
        ...(info.cwd ?? previous?.workspace ? { workspace: info.cwd ?? previous?.workspace } : {}),
        ...(info.model ? { model: info.model } : {}), createdAt: previous?.createdAt ?? entry.createdAt,
        updatedAt: previous?.updatedAt ?? entry.createdAt, state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting'
          : info.status === 'failed' ? 'unavailable' : 'idle' });
    }
    return [...summaries.values()];
  }
  async function remember(session: AgentSession): Promise<string> {
    try {
      if (closed) throw new Error('Codex directory is closed.');
      const info = await session.runtimeInfo();
      if (closed) throw new Error('Codex directory is closed.');
      if (!info.persistence || !info.sessionId) throw new Error('Codex did not return a native persistence handle.');
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString() });
      return info.sessionId;
    } catch (error) { await session.dispose(); throw error; }
  }
  return {
    providerId: 'codex',
    list() { if (closed) throw new Error('Codex directory is closed.'); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    async create(input) {
      if (closed) throw new Error('Codex directory is closed.');
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown Codex workspace.');
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      return remember(await provider.createSession({ ...input, sessionId: randomUUID(), ...(cwd ? { cwd } : {}) }));
    },
    async open(nativeSessionId) {
      if (closed) throw new Error('Codex directory is closed.');
      const existing = opened.get(nativeSessionId);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const session = await provider.resumeSession(existing?.handle ?? { providerId: 'codex', sessionId: nativeSessionId, opaque: '{}' });
      await remember(session); return session;
    },
    async openChild(parentNativeSessionId, nativeSessionId) {
      if (closed) throw new Error('Codex directory is closed.');
      return provider.openChildSession(parentNativeSessionId, nativeSessionId);
    },
    async close() { closed = true; await discovery?.catch(() => undefined);
      await Promise.allSettled([...opened.values()].map(({ session }) => session.dispose())); opened.clear(); },
  };
}
