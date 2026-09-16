import { randomUUID } from 'node:crypto';
import type { ClaudeAgentProvider, ClaudeSessionSummary } from '@agent-remote-controller/agent-provider-claude';
import type { AgentPersistenceHandle, AgentSession } from '@agent-remote-controller/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

/** Owns native queries independently of the currently paired uplink. */
export function createClaudeSessionDirectory(
  provider: Pick<ClaudeAgentProvider, 'listSessions' | 'createSession' | 'resumeSession'> & Partial<Pick<ClaudeAgentProvider, 'openChildSession'>>,
  workspaces: readonly AgentHostWorkspace[],
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string }>();
  let discovery: Promise<ClaudeSessionSummary[]> | undefined;
  let closed = false;
  async function discover(): Promise<ClaudeSessionSummary[]> {
    const summaries = new Map((await provider.listSessions()).map((summary) => [summary.nativeSessionId, summary]));
    for (const [nativeSessionId, entry] of opened) {
      const info = await entry.session.runtimeInfo();
      const previous = summaries.get(nativeSessionId);
      summaries.set(nativeSessionId, { nativeSessionId, providerId: 'claude', title: previous?.title ?? 'New Claude session',
        ...(info.cwd ?? previous?.workspace ? { workspace: info.cwd ?? previous?.workspace } : {}),
        createdAt: previous?.createdAt ?? entry.createdAt, updatedAt: previous?.updatedAt ?? entry.createdAt,
        state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting' : info.status === 'failed' ? 'unavailable' : info.status === 'idle' ? 'idle' : 'unknown' });
    }
    return [...summaries.values()];
  }
  async function remember(session: AgentSession): Promise<string> {
    try {
      if (closed) throw new Error('Claude directory is closed.');
      const info = await session.runtimeInfo();
      if (closed) throw new Error('Claude directory is closed.');
      if (!info.persistence || !info.sessionId) throw new Error('Claude did not return a native persistence handle.');
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString() });
      return info.sessionId;
    } catch (error) { await session.dispose(); throw error; }
  }
  return {
    providerId: 'claude',
    list() { if (closed) throw new Error('Claude directory is closed.'); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    async create(input) {
      if (closed) throw new Error('Claude directory is closed.');
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown Claude workspace.');
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      return remember(await provider.createSession({ ...input, sessionId: randomUUID(), ...(cwd ? { cwd } : {}) }));
    },
    async open(nativeSessionId) {
      if (closed) throw new Error('Claude directory is closed.');
      const existing = opened.get(nativeSessionId);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const session = await provider.resumeSession(existing?.handle ?? { providerId: 'claude', sessionId: nativeSessionId, opaque: '{}' });
      await remember(session);
      return session;
    },
    async close() {
      closed = true;
      await discovery?.catch(() => undefined);
      await Promise.allSettled([...opened.values()].map(({ session }) => session.dispose()));
      opened.clear();
    },
    ...(provider.openChildSession ? { async openChild(parentNativeSessionId: string, nativeSessionId: string) {
      if (closed) throw new Error('Claude directory is closed.');
      return provider.openChildSession!(parentNativeSessionId, nativeSessionId);
    } } : {}),
  };
}
