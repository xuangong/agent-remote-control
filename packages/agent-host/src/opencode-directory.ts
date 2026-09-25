import { SessionReferenceStore, sourceSessionExtensions } from './session-reference.js';
import { randomUUID } from 'node:crypto';
import type { OpenCodeAgentProvider, OpenCodeSessionSummary } from '@orchardworks/agent-provider-opencode';
import type { AgentSession, AgentHistoryQuery, AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

type OpenCodeDirectoryProvider = Pick<OpenCodeAgentProvider, 'listSessions' | 'getSession' | 'createSession' | 'resumeSession' | 'renameSession' | 'close'>
  & Partial<Pick<OpenCodeAgentProvider, 'forkForPromptEdit' | 'validatePromptEdit' | 'openChildSession' | 'readSessionHistory'>>;

/** The native server owns all work; directory lifetime only controls local subscriptions. */
export function createOpenCodeSessionDirectory(provider: OpenCodeDirectoryProvider, workspaces: readonly AgentHostWorkspace[], references?: SessionReferenceStore, callbacksAvailable = false): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string; verifiedParent?: string }>();
  const controllerTools = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let sourceAccessCheck: ((nativeSessionId: string) => Promise<void>) | undefined;
  function assertOpen() { if (closed) throw new Error('OpenCode directory is closed.'); }
  async function readSource(id: string, query: AgentHistoryQuery) {
    assertOpen(); await sourceAccessCheck?.(id);
    return provider.readSessionHistory!(id, query);
  }
  async function summary(id: string): Promise<OpenCodeSessionSummary | undefined> { assertOpen(); return provider.getSession(id); }
  async function remember(session: AgentSession): Promise<string> {
    try {
      assertOpen(); const info = await session.runtimeInfo(); assertOpen();
      if (!info.sessionId || !info.persistence) throw new Error('OpenCode did not return a native persistence handle.');
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString() }); return info.sessionId;
    } catch (error) { await session.dispose(); throw error; }
  }
  return {
    providerId: 'opencode',
    supportsSourceReferences: callbacksAvailable && !!references && !!provider.readSessionHistory,
    requiresController: id => controllerTools.has(id),
    supportsPromptEditing: !!provider.forkForPromptEdit,
    setSourceAccessCheck(check) { sourceAccessCheck = check; },
    async validatePromptEdit(target) {
      assertOpen();
      if (!provider.validatePromptEdit) throw new Error('OpenCode prompt editing is unavailable.');
      await sourceAccessCheck?.(target.nativeSessionId);
      if (await references?.get(target.nativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
      await provider.validatePromptEdit(target);
    },
    workspaces: () => [...workspaces],
    sessionWorkspace: async id => (await summary(id))?.cwd,
    sessionTitle: async id => (await summary(id))?.title,
    async renameSession(id, title) {
      const native = await summary(id); if (!native) throw new Error('OpenCode session was not found.');
      if (native.title !== title) await provider.renameSession(id, title);
      return title;
    },
    canReleaseSession: id => !controllerTools.has(id),
    sessionReleased(id) { opened.delete(id); controllerTools.delete(id); },
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
      if (input.editNativeSessionId) {
        if (!provider.forkForPromptEdit || !input.editTurnId || !input.editMessageId) throw new Error('OpenCode prompt editing requires a complete native prompt identity.');
        await sourceAccessCheck?.(input.editNativeSessionId);
        if (await references?.get(input.editNativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
        return remember(await provider.forkForPromptEdit({ nativeSessionId: input.editNativeSessionId, turnId: input.editTurnId, messageId: input.editMessageId }));
      }
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(workspace => workspace.id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown OpenCode workspace.');
      const { workspaceId: _workspaceId, sourceNativeSessionId: _source, editNativeSessionId: _edit, editTurnId: _turn, editMessageId: _message, ...config } = input;
      const cwd = config.cwd ?? selected?.path ?? workspaces[0]?.path;
      const source = input.sourceNativeSessionId;
      if (source && (!callbacksAvailable || !references || !provider.readSessionHistory)) throw new Error('OpenCode source references require a connected native callback plugin.');
      if (source) { await sourceAccessCheck?.(source); if (!await summary(source)) throw new Error('OpenCode source session was not found.'); }
      const extensions = source ? sourceSessionExtensions(source, readSource) : {};
      const systemPrompt = [config.systemPrompt, extensions.systemPrompt].filter(Boolean).join('\n\n');
      const tools = [...(config.tools ?? []), ...(extensions.tools ?? [])];
      const session = await provider.createSession({ ...config, sessionId: randomUUID(), ...(cwd ? { cwd } : {}),
        ...(systemPrompt ? { systemPrompt } : {}), ...(tools.length ? { tools } : {}) });
      const id = await remember(session);
      if (tools.length) controllerTools.add(id);
      if (source) {
        try { await references!.set({ sourceNativeSessionId: source, systemPrompt, handle: opened.get(id)!.handle }); }
        catch (error) { opened.delete(id); controllerTools.delete(id); await session.dispose(); throw error; }
      }
      return id;
    },
    async open(id, options) {
      assertOpen();
      if (options?.takeOver) throw new Error('OpenCode uses shared session control; takeover is unavailable.');
      const existing = opened.get(id);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const native = await summary(id); if (!native) throw new Error('OpenCode session was not found.');
      const grant = await references?.get(id);
      if (grant && (!callbacksAvailable || !provider.readSessionHistory)) throw new Error('OpenCode source references require a connected native callback plugin.');
      if (grant) { await sourceAccessCheck?.(grant.sourceNativeSessionId); if (!await summary(grant.sourceNativeSessionId)) throw new Error('OpenCode source session was not found.'); }
      const extensions = grant ? sourceSessionExtensions(grant.sourceNativeSessionId, readSource) : undefined;
      const session = await provider.resumeSession({ providerId: 'opencode', sessionId: id, opaque: JSON.stringify({ cwd: native.cwd }) },
        extensions ? { tools: extensions.tools, systemPrompt: grant!.systemPrompt } : undefined);
      await remember(session); if (extensions?.tools?.length) controllerTools.add(id); return session;
    },
    async openChild(parentNativeSessionId, nativeSessionId) {
      assertOpen();
      if (!provider.openChildSession) throw new Error('OpenCode child sessions are unavailable.');
      await sourceAccessCheck?.(parentNativeSessionId);
      await sourceAccessCheck?.(nativeSessionId);
      const existing = opened.get(nativeSessionId);
      if (existing?.verifiedParent === parentNativeSessionId && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
      const session = await provider.openChildSession(parentNativeSessionId, nativeSessionId);
      const id = await remember(session);
      opened.get(id)!.verifiedParent = parentNativeSessionId;
      return session;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...opened.values()].map(({ session }) => session.dispose()));
        opened.clear(); controllerTools.clear(); await provider.close();
      })();
      return closing;
    },
  };
}
