import { SessionReferenceStore, sourceSessionExtensions } from './session-reference.js';
import { randomUUID } from 'node:crypto';
import type { CodexAppServerProvider, CodexSessionSummary } from '@orchardworks/agent-provider-codex';
import type { AgentPersistenceHandle, AgentSession, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

/** Keeps new native sessions alive before and after their relay projection is attached. */
export function createCodexSessionDirectory(
  provider: Pick<CodexAppServerProvider, 'listSessions' | 'createSession' | 'resumeSession' | 'openChildSession'> & Partial<Pick<CodexAppServerProvider, 'readSessionTitle' | 'renameSession' | 'readSessionHistory' | 'readSessionWorkspace' | 'canReleaseSession' | 'reconcileIdleSession' | 'forkForPromptEdit' | 'validatePromptEdit'>>,
  workspaces: readonly AgentHostWorkspace[],
  references?: SessionReferenceStore,
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string }>();
  const controllerTools = new Set<string>();
  let discovery: Promise<CodexSessionSummary[]> | undefined;
  let closed = false;
  let sourceAccessCheck: ((nativeSessionId: string) => Promise<void>) | undefined;
  async function readSource(id: string, query: AgentHistoryQuery) {
    if (closed) throw new Error('Codex directory is closed.');
    await sourceAccessCheck?.(id);
    return provider.readSessionHistory!(id, query);
  }
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
          : info.status === 'failed' ? 'unavailable' : info.status === 'idle' ? 'idle' : 'unknown' });
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
    ...(provider.readSessionTitle ? { sessionTitle: provider.readSessionTitle.bind(provider) } : {}),
    ...(provider.renameSession ? { renameSession: provider.renameSession.bind(provider) } : {}),
    requiresController: id => controllerTools.has(id),
    supportsPromptEditing: !!provider.forkForPromptEdit,
    async validatePromptEdit(target) {
      await sourceAccessCheck?.(target.nativeSessionId);
      if (await references?.get(target.nativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
      await provider.validatePromptEdit?.(target);
    },
    reconcileIdleSession: id => provider.reconcileIdleSession?.(id) ?? Promise.resolve(false),
    canReleaseSession: id => provider.canReleaseSession?.(id) === true,
    sessionReleased(id) { opened.delete(id); controllerTools.delete(id); },
    supportsSourceReferences: !!references && !!provider.readSessionHistory,
    ...(provider.readSessionWorkspace ? { sessionWorkspace: provider.readSessionWorkspace.bind(provider) } : {}),
    setSourceAccessCheck(check) { sourceAccessCheck = check; },
    list() { if (closed) throw new Error('Codex directory is closed.'); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    async create(input) {
      if (closed) throw new Error('Codex directory is closed.');
      if (input.editNativeSessionId) {
        if (!provider.forkForPromptEdit || !input.editTurnId || !input.editMessageId) throw new Error('Native prompt editing is unavailable.');
        await sourceAccessCheck?.(input.editNativeSessionId);
        if (await references?.get(input.editNativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
        return remember(await provider.forkForPromptEdit({ nativeSessionId: input.editNativeSessionId, turnId: input.editTurnId, messageId: input.editMessageId }));
      }
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown Codex workspace.');
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      const { sourceNativeSessionId, ...config } = input;
      if (sourceNativeSessionId && (!references || !provider.readSessionHistory)) throw new Error('Source references are unavailable on this Host.');
      const extensions = sourceNativeSessionId ? sourceSessionExtensions(sourceNativeSessionId, readSource) : {};
      const systemPrompt = [config.systemPrompt, extensions.systemPrompt].filter(Boolean).join('\n\n');
      const session = await provider.createSession({ ...config, ...extensions, sessionId: randomUUID(), ...(cwd ? { cwd } : {}),
        ...(systemPrompt ? { systemPrompt } : {}) });
      const id = await remember(session);
      if (extensions.tools?.length || config.tools?.length) controllerTools.add(id);
      if (sourceNativeSessionId) {
        try { await references!.set({ sourceNativeSessionId, systemPrompt, handle: opened.get(id)!.handle }); }
        catch (error) { opened.delete(id); await session.dispose(); throw error; }
      }
      return id;
    },
    async open(nativeSessionId) {
      if (closed) throw new Error('Codex directory is closed.');
      const existing = opened.get(nativeSessionId);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const grant = await references?.get(nativeSessionId);
      if (grant && !provider.readSessionHistory) throw new Error('Source history tools are unavailable on this Host.');
      const extensions = grant ? sourceSessionExtensions(grant.sourceNativeSessionId, readSource) : undefined;
      // Let native saved settings win after a Host restart; only restore Host instructions and tools.
      const session = await provider.resumeSession(existing?.handle ?? { providerId: 'codex', sessionId: nativeSessionId, opaque: '{}' },
        extensions ? { tools: extensions.tools, systemPrompt: grant!.systemPrompt } : undefined);
      await remember(session);
      if (extensions?.tools?.length) controllerTools.add(nativeSessionId);
      return session;
    },
    async openChild(parentNativeSessionId, nativeSessionId) {
      if (closed) throw new Error('Codex directory is closed.');
      return provider.openChildSession(parentNativeSessionId, nativeSessionId);
    },
    async close() { closed = true; await discovery?.catch(() => undefined);
      await Promise.allSettled([...opened.values()].map(({ session }) => session.dispose())); opened.clear(); },
  };
}
