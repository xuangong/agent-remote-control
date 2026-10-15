import { sessionExtensionIdentity, requireSessionExtensionIdentity } from './session-extension-identity.js';
import { SessionReferenceStore, disposeAfterSourceGrantFailure, sourceSessionExtensions, type SourceBindingReader } from './session-reference.js';
import { randomUUID } from 'node:crypto';
import type { OpenCodeAgentProvider, OpenCodeSessionSummary } from '@orchardworks/agent-provider-opencode';
import type { AgentSession, AgentHistoryQuery, AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';
import { nativePrefixResumeHandle, successionCreationHandle } from './local-succession-preparation.js';
import { serializeAgentEmptyCreationResult } from '@orchardworks/agent-provider-sdk';

type OpenCodeDirectoryProvider = Pick<OpenCodeAgentProvider, 'listSessions' | 'getSession' | 'createSession' | 'resumeSession' | 'renameSession' | 'close'>
  & Partial<Pick<OpenCodeAgentProvider, 'createdSessionIdMaxLength' | 'forkForPromptEdit' | 'validatePromptEdit' | 'verifyPromptEditBranch' | 'openChildSession' | 'readSessionHistory'>>;

/** The native server owns all work; directory lifetime only controls local subscriptions. */
export function createOpenCodeSessionDirectory(provider: OpenCodeDirectoryProvider, workspaces: readonly AgentHostWorkspace[], references?: SessionReferenceStore, callbacksAvailable = false): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string; verifiedParent?: string; nativeCreation?: string; nativePrefix?: string; prefixExtensions?: string }>();
  const controllerTools = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let sourceAccessCheck: ((nativeSessionId: string) => Promise<void>) | undefined;
  let sourceBindingReader: SourceBindingReader | undefined;
  let sourceReferenceAncestors: ((id: string, preparationHandle?: AgentPersistenceHandle) => Promise<readonly string[]>) | undefined;
  async function lookupSourceGrant(id: string, preparationHandle?: AgentPersistenceHandle) {
    return references?.resolve(sourceReferenceAncestors ? await sourceReferenceAncestors(id, preparationHandle) : [id]);
  }
  function assertOpen() { if (closed) throw new Error('OpenCode directory is closed.'); }
  async function readSource(id: string, query: AgentHistoryQuery) {
    assertOpen(); await sourceAccessCheck?.(id);
    return provider.readSessionHistory!(id, query);
  }
  function sourceExtensions(source: string, reader: () => string | undefined, canonicalReader?: string) {
    return sourceSessionExtensions(source, readSource, async query => {
      const id = reader(); if (!id) throw new Error('Source reader identity is not ready.');
      if (sourceBindingReader) {
        return sourceBindingReader(id, source, query, readSource, canonicalReader);
      }
      if (query.sourceContext) throw new Error('Source context is unavailable on this Host.');
      return { ...await readSource(source, query), sourceSessionId: source };
    });
  }
  async function summary(id: string): Promise<OpenCodeSessionSummary | undefined> { assertOpen(); return provider.getSession(id); }
  async function remember(session: AgentSession): Promise<string> {
    try {
      assertOpen(); const info = await session.runtimeInfo(); assertOpen();
      if (!info.sessionId || !info.persistence) throw new Error('OpenCode did not return a native persistence handle.');
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString() }); return info.sessionId;
    } catch (error) {
      try { await session.dispose(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'OpenCode initialization cleanup could not be confirmed.', { cause: error });
      }
      throw error;
    }
  }
  return {
    providerId: 'opencode',
    supportsSourceReferences: callbacksAvailable && !!references && !!provider.readSessionHistory,
    async supportsBoundedSourceCreate(input) {
      const limit = provider.createdSessionIdMaxLength;
      return !closed && !!input.sourceNativeSessionId?.trim() && !input.editNativeSessionId && !input.editTurnId && !input.editMessageId
        && typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 512;
    },
    requiresController: id => controllerTools.has(id),
    supportsPromptEditing: !!provider.forkForPromptEdit,
    setSourceAccessCheck(check) { sourceAccessCheck = check; },
    setSourceBindingReader(reader) { sourceBindingReader = reader; },
    setSourceReferenceAncestors(resolve) { sourceReferenceAncestors = resolve; },
    sourceReferences: () => references?.list() ?? Promise.resolve([]),
    async supportsNativePrefix(target) {
      const limit = provider.createdSessionIdMaxLength;
      if (closed || !provider.forkForPromptEdit || !provider.verifyPromptEditBranch || !provider.validatePromptEdit
        || !Number.isInteger(limit) || !limit || limit > 512 || limit < 1) return false;
      await sourceAccessCheck?.(target.nativeSessionId);
      if (await lookupSourceGrant(target.nativeSessionId) && (!sourceReferenceAncestors || !sourceBindingReader || !callbacksAvailable)) return false;
      await provider.validatePromptEdit(target); return true;
    },
    async createNativePrefix(target, extensions, evidence, candidateKnown) {
      assertOpen();
      if (!provider.forkForPromptEdit || !provider.verifyPromptEditBranch) throw new Error('Native prefix preparation is unavailable.');
      await sourceAccessCheck?.(target.nativeSessionId);
      const grant = await lookupSourceGrant(target.nativeSessionId);
      if (grant && (!sourceReferenceAncestors || !sourceBindingReader || !callbacksAvailable)) throw new Error('Source prefix routing is unavailable on this Host.');
      let readerId: string | undefined;
      const source = grant ? sourceExtensions(grant.sourceNativeSessionId, () => readerId, grant.handle.sessionId) : undefined;
      const boundExtensions = source ? { ...extensions, systemPrompt: [grant!.systemPrompt, extensions.systemPrompt].filter(Boolean).join('\n\n'), tools: [...(source.tools ?? []), ...(extensions.tools ?? [])] } : extensions;
      let checkpoint: AgentPersistenceHandle | undefined;
      const session = await provider.forkForPromptEdit(target, boundExtensions, async handle => {
        checkpoint = nativePrefixResumeHandle('opencode', handle.sessionId, handle);
        await candidateKnown?.(checkpoint);
        readerId = checkpoint.sessionId;
      });
      evidence?.completed();
      const id = await remember(session), entry = opened.get(id)!;
      const handle = nativePrefixResumeHandle('opencode', id, checkpoint ?? entry.handle);
      readerId = id;
      entry.nativePrefix = JSON.stringify(handle);
      entry.prefixExtensions = sessionExtensionIdentity(boundExtensions);
      if (boundExtensions.tools?.length) controllerTools.add(id);
      return handle;
    },
    async verifyNativePrefix(target, handle) {
      assertOpen();
      if (!provider.verifyPromptEditBranch) throw new Error('Native prefix verification is unavailable.');
      await sourceAccessCheck?.(target.nativeSessionId);
      await provider.verifyPromptEditBranch(target, nativePrefixResumeHandle('opencode', handle.sessionId, handle));
    },
    async validatePromptEdit(target) {
      assertOpen();
      if (!provider.validatePromptEdit) throw new Error('OpenCode prompt editing is unavailable.');
      await sourceAccessCheck?.(target.nativeSessionId);
      if (await lookupSourceGrant(target.nativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
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
    async create(input, evidence) {
      assertOpen();
      if (input.editNativeSessionId) {
        if (!provider.forkForPromptEdit || !input.editTurnId || !input.editMessageId) throw new Error('OpenCode prompt editing requires a complete native prompt identity.');
        await sourceAccessCheck?.(input.editNativeSessionId);
        if (await lookupSourceGrant(input.editNativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
        const native = await provider.forkForPromptEdit({ nativeSessionId: input.editNativeSessionId, turnId: input.editTurnId, messageId: input.editMessageId });
        evidence?.completed();
        return remember(native);
      }
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(workspace => workspace.id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown OpenCode workspace.');
      const { workspaceId: _workspaceId, sourceNativeSessionId: _source, editNativeSessionId: _edit, editTurnId: _turn, editMessageId: _message, ...config } = input;
      const cwd = config.cwd ?? selected?.path ?? workspaces[0]?.path;
      const source = input.sourceNativeSessionId;
      if (source && (!callbacksAvailable || !references || !provider.readSessionHistory)) throw new Error('OpenCode source references require a connected native callback plugin.');
      if (source) { await sourceAccessCheck?.(source); if (!await summary(source)) throw new Error('OpenCode source session was not found.'); }
      let readerId: string | undefined;
      const extensions = source ? sourceExtensions(source, () => readerId) : {};
      const systemPrompt = [config.systemPrompt, extensions.systemPrompt].filter(Boolean).join('\n\n');
      const tools = [...(config.tools ?? []), ...(extensions.tools ?? [])];
      const session = await provider.createSession({ ...config, sessionId: randomUUID(), ...(cwd ? { cwd } : {}),
        ...(systemPrompt ? { systemPrompt } : {}), ...(tools.length ? { tools } : {}) });
      evidence?.completed();
      const id = await remember(session);
      if (tools.length) controllerTools.add(id);
      if (source) {
        try { await references!.set({ sourceNativeSessionId: source, systemPrompt, handle: opened.get(id)!.handle }); }
        catch (error) { opened.delete(id); controllerTools.delete(id); return disposeAfterSourceGrantFailure(error, () => session.dispose()); }
      }
      readerId = id;
      return id;
    },
    async open(id, options) {
      assertOpen();
      if (options?.nativePrefix && (options.nativeCreation || options.resumeHandle || options.resumeOptions)) throw new Error('Native prefix cannot use empty creation recovery options.');
      const prefixHandle = options?.nativePrefix && nativePrefixResumeHandle('opencode', id, options.nativePrefix);
      const prefixIdentity = prefixHandle && JSON.stringify(prefixHandle);
      const creationHandle = options?.nativeCreation ? successionCreationHandle('opencode', id, options.nativeCreation) : undefined;
      const creationIdentity = options?.nativeCreation ? serializeAgentEmptyCreationResult(options.nativeCreation) : undefined;
      if (options?.takeOver) throw new Error('OpenCode uses shared session control; takeover is unavailable.');
      const existing = opened.get(id);
      if (existing && (await existing.session.runtimeInfo()).status !== 'closed') {
        if (prefixIdentity && existing.nativePrefix !== prefixIdentity) throw new Error('Existing attachment does not match the original native prefix handle.');
        if (prefixIdentity && options?.extensions) {
          const grant = await lookupSourceGrant(id, prefixHandle);
          const source = grant ? sourceExtensions(grant.sourceNativeSessionId, () => id, grant.handle.sessionId) : undefined;
          const requested = source ? { ...options.extensions, systemPrompt: [grant!.systemPrompt, options.extensions.systemPrompt].filter(Boolean).join('\n\n'), tools: [...(source.tools ?? []), ...(options.extensions.tools ?? [])] } : options.extensions;
          requireSessionExtensionIdentity(existing.prefixExtensions!, requested);
        }
        if (creationIdentity && existing.nativeCreation !== creationIdentity) throw new Error('Existing attachment does not match the original native creation evidence.');
        return existing.session;
      }
      const native = await summary(id); if (!native) throw new Error('OpenCode session was not found.');
      const grant = await lookupSourceGrant(id, prefixHandle);
      if (grant && (!callbacksAvailable || !provider.readSessionHistory)) throw new Error('OpenCode source references require a connected native callback plugin.');
      if (grant) { await sourceAccessCheck?.(grant.sourceNativeSessionId); if (!await summary(grant.sourceNativeSessionId)) throw new Error('OpenCode source session was not found.'); }
      const sourceGrant = grant ? sourceExtensions(grant.sourceNativeSessionId, () => id, grant.handle.sessionId) : undefined;
      const tools = [...(sourceGrant?.tools ?? []), ...(options?.extensions?.tools ?? [])];
      const systemPrompt = [grant?.systemPrompt, options?.extensions?.systemPrompt].filter(Boolean).join('\n\n');
      const extensions = sourceGrant || options?.extensions ? { ...(options?.extensions?.instructions ? { instructions: options.extensions.instructions } : {}), ...(tools.length ? { tools } : {}), ...(systemPrompt ? { systemPrompt } : {}) } : undefined;
      const session = await provider.resumeSession(prefixHandle ?? creationHandle ?? { providerId: 'opencode', sessionId: id, opaque: JSON.stringify({ cwd: native.cwd }) },
        extensions);
      const resumed = await remember(session);
      if (resumed !== id) { opened.delete(resumed); await session.dispose(); throw new Error('Native creation attachment identity changed.'); }
      if (creationIdentity) opened.get(id)!.nativeCreation = creationIdentity;
      if (prefixIdentity) { opened.get(id)!.nativePrefix = prefixIdentity; opened.get(id)!.prefixExtensions = sessionExtensionIdentity(extensions); }
      if (extensions?.tools?.length) controllerTools.add(id); return session;
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
