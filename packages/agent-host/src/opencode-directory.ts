import { randomUUID } from 'node:crypto';
import type { OpenCodeAgentProvider, OpenCodeSessionSummary } from '@orchardworks/agent-provider-opencode';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

type OpenCodeDirectoryProvider = Pick<OpenCodeAgentProvider, 'listSessions' | 'getSession' | 'createSession' | 'resumeSession' | 'renameSession' | 'close'>;

/** The native server owns all work; directory lifetime only controls local subscriptions. */
export function createOpenCodeSessionDirectory(provider: OpenCodeDirectoryProvider, workspaces: readonly AgentHostWorkspace[]): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; createdAt: string }>();
  let closed = false;
  let closing: Promise<void> | undefined;
  function assertOpen() { if (closed) throw new Error('OpenCode directory is closed.'); }
  async function summary(id: string): Promise<OpenCodeSessionSummary | undefined> { assertOpen(); return provider.getSession(id); }
  async function remember(session: AgentSession): Promise<string> {
    try {
      assertOpen(); const info = await session.runtimeInfo(); assertOpen();
      if (!info.sessionId || !info.persistence) throw new Error('OpenCode did not return a native persistence handle.');
      opened.set(info.sessionId, { session, createdAt: new Date().toISOString() }); return info.sessionId;
    } catch (error) { await session.dispose(); throw error; }
  }
  return {
    providerId: 'opencode',
    workspaces: () => [...workspaces],
    sessionWorkspace: async id => (await summary(id))?.cwd,
    sessionTitle: async id => (await summary(id))?.title,
    async renameSession(id, title) {
      const native = await summary(id); if (!native) throw new Error('OpenCode session was not found.');
      if (native.title !== title) await provider.renameSession(id, title);
      return title;
    },
    canReleaseSession: () => true,
    sessionReleased(id) { opened.delete(id); },
    async list() {
      assertOpen();
      const entries = new Map<string, RemoteSessionSummary>((await provider.listSessions()).map(native => [native.id, {
        providerId: 'opencode', nativeSessionId: native.id, title: native.title, workspace: native.cwd,
        createdAt: native.createdAt ?? native.updatedAt, updatedAt: native.updatedAt, state: 'unknown',
        ...(native.parentId ? { parentNativeSessionId: native.parentId } : {}),
      }]));
      for (const [id, entry] of opened) {
        const info = await entry.session.runtimeInfo(); if (info.status === 'closed') continue;
        const previous = entries.get(id);
        entries.set(id, { ...previous, providerId: 'opencode', nativeSessionId: id, title: previous?.title ?? 'New OpenCode session',
          workspace: info.cwd ?? previous?.workspace, createdAt: previous?.createdAt ?? entry.createdAt,
          updatedAt: previous?.updatedAt ?? entry.createdAt, ...(info.model ? { model: info.model } : {}),
          state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting' : info.status === 'idle' ? 'idle' : info.status === 'failed' ? 'unavailable' : 'unknown' });
      }
      assertOpen(); return [...entries.values()];
    },
    async create(input) {
      assertOpen();
      if (input.sourceNativeSessionId) throw new Error('OpenCode source references are unavailable.');
      if (input.editNativeSessionId) throw new Error('OpenCode prompt editing is unavailable.');
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(workspace => workspace.id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown OpenCode workspace.');
      const { workspaceId: _workspaceId, sourceNativeSessionId: _source, editNativeSessionId: _edit, editTurnId: _turn, editMessageId: _message, ...config } = input;
      const cwd = config.cwd ?? selected?.path ?? workspaces[0]?.path;
      return remember(await provider.createSession({ ...config, sessionId: randomUUID(), ...(cwd ? { cwd } : {}) }));
    },
    async open(id, options) {
      assertOpen();
      if (options?.takeOver) throw new Error('OpenCode uses shared session control; takeover is unavailable.');
      const existing = opened.get(id);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const native = await summary(id); if (!native) throw new Error('OpenCode session was not found.');
      const session = await provider.resumeSession({ providerId: 'opencode', sessionId: id, opaque: JSON.stringify({ cwd: native.cwd }) });
      await remember(session); return session;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...opened.values()].map(({ session }) => session.dispose()));
        opened.clear(); await provider.close();
      })();
      return closing;
    },
  };
}
