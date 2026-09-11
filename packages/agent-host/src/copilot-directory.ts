import { randomUUID } from 'node:crypto';
import type { CopilotSessionSummary } from '@borgee/agent-provider-copilot';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSession } from '@borgee/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

/** Owns native queries independently of the currently paired uplink. */
export function createCopilotSessionDirectory(
  provider: Pick<AgentProviderAdapter, 'createSession' | 'resumeSession'> & {
    listSessions(): Promise<CopilotSessionSummary[]>;
    openChildSession?(parent: string, child: string): Promise<AgentSession>;
    dispose?(): Promise<void>;
  },
  workspaces: readonly AgentHostWorkspace[],
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string }>();
  let discovery: Promise<CopilotSessionSummary[]> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  async function discover(): Promise<CopilotSessionSummary[]> {
    const summaries = new Map((await provider.listSessions()).map((summary) => [summary.nativeSessionId, summary]));
    for (const [nativeSessionId, entry] of opened) {
      const info = await entry.session.runtimeInfo();
      const previous = summaries.get(nativeSessionId);
      summaries.set(nativeSessionId, { nativeSessionId, providerId: 'copilot', title: previous?.title ?? 'New Copilot session',
        ...(info.cwd ?? previous?.workspace ? { workspace: info.cwd ?? previous?.workspace } : {}),
        createdAt: previous?.createdAt ?? entry.createdAt, updatedAt: previous?.updatedAt ?? entry.createdAt,
        state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting' : info.status === 'failed' ? 'unavailable' : 'idle' });
    }
    return [...summaries.values()];
  }
  async function remember(session: AgentSession): Promise<string> {
    try {
      if (closed) throw new Error('Copilot directory is closed.');
      const info = await session.runtimeInfo();
      if (closed) throw new Error('Copilot directory is closed.');
      if (!info.persistence || !info.sessionId) throw new Error('Copilot did not return a native persistence handle.');
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString() });
      return info.sessionId;
    } catch (error) { await session.dispose(); throw error; }
  }
  return {
    providerId: 'copilot',
    list() { if (closed) throw new Error('Copilot directory is closed.'); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    async create(input) {
      if (closed) throw new Error('Copilot directory is closed.');
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown Copilot workspace.');
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      return remember(await provider.createSession({ ...input, sessionId: randomUUID(), ...(cwd ? { cwd } : {}) }));
    },
    async open(nativeSessionId) {
      if (closed) throw new Error('Copilot directory is closed.');
      const existing = opened.get(nativeSessionId);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const session = await provider.resumeSession(existing?.handle ?? { providerId: 'copilot', sessionId: nativeSessionId, opaque: '{}' });
      await remember(session);
      return session;
    },
    close() {
      if (closing) return closing;
      closed = true;
      return closing = (async () => {
        await discovery?.catch(() => undefined);
        await Promise.allSettled([...opened.values()].map(({ session }) => session.dispose()));
        opened.clear();
        await provider.dispose?.();
      })();
    },
    ...(provider.openChildSession ? { async openChild(parentNativeSessionId: string, nativeSessionId: string) {
      if (closed) throw new Error('Copilot directory is closed.');
      return provider.openChildSession!(parentNativeSessionId, nativeSessionId);
    } } : {}),
  };
}
