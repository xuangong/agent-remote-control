import { successionResumeHandle, nativePrefixResumeHandle } from './local-succession-preparation.js';
import { AgentSessionInUseError, serializeAgentEmptyCreationResult, resolveAgentNativePrefixCapability } from '@orchardworks/agent-provider-sdk';
import { NativeSessionOwnerError } from './native-session-owner.js';
import { SessionReferenceStore, disposeAfterSourceGrantFailure, sourceSessionExtensions, type SourceBindingReader } from './session-reference.js';
import { randomUUID } from 'node:crypto';
import type { CodexAppServerProvider, CodexSessionSummary } from '@orchardworks/agent-provider-codex';
import type { AgentProviderAdapter, AgentPersistenceHandle, AgentSession, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';
import { requireSessionExtensionIdentity, sessionExtensionIdentity } from './session-extension-identity.js';

/** Keeps new native sessions alive before and after their relay projection is attached. */
export function createCodexSessionDirectory(
  provider: Pick<CodexAppServerProvider, 'listSessions' | 'createSession' | 'resumeSession' | 'openChildSession'> & Pick<AgentProviderAdapter, 'nativePrefix'> & Partial<Pick<CodexAppServerProvider, 'createdSessionIdMaxLength' | 'inspectSessionOwner' | 'releaseSessionOwner' | 'readSessionTitle' | 'renameSession' | 'readSessionHistory' | 'readSessionWorkspace' | 'canReleaseSession' | 'reconcileIdleSession' | 'forkSession' | 'forkForPromptEdit' | 'validatePromptEdit'>>,
  workspaces: readonly AgentHostWorkspace[],
  references?: SessionReferenceStore,
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string; extensionIdentity: string; nativeCreation?: string; nativePrefix?: string }>();
  const controllerTools = new Set<string>();
  let discovery: Promise<CodexSessionSummary[]> | undefined;
  let closed = false;
  let sourceAccessCheck: ((nativeSessionId: string) => Promise<void>) | undefined;
  let sourceBindingReader: SourceBindingReader | undefined;
  let sourceReferenceAncestors: ((id: string, preparationHandle?: AgentPersistenceHandle) => Promise<readonly string[]>) | undefined;
  async function lookupSourceGrant(id: string, preparationHandle?: AgentPersistenceHandle) {
    return references?.resolve(sourceReferenceAncestors ? await sourceReferenceAncestors(id, preparationHandle) : [id]);
  }
  async function readSource(id: string, query: AgentHistoryQuery) {
    if (closed) throw new Error('Codex directory is closed.');
    await sourceAccessCheck?.(id);
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
  async function remember(session: AgentSession, extensionIdentity = sessionExtensionIdentity()): Promise<string> {
    try {
      if (closed) throw new Error('Codex directory is closed.');
      const info = await session.runtimeInfo();
      if (closed) throw new Error('Codex directory is closed.');
      if (!info.persistence || !info.sessionId) throw new Error('Codex did not return a native persistence handle.');
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString(), extensionIdentity });
      return info.sessionId;
    } catch (error) {
      try { await session.dispose(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Codex initialization cleanup could not be confirmed.', { cause: error });
      }
      throw error;
    }
  }
  return {
    providerId: 'codex',
    ...(provider.readSessionTitle ? { sessionTitle: provider.readSessionTitle.bind(provider) } : {}),
    ...(provider.renameSession ? { renameSession: provider.renameSession.bind(provider) } : {}),
    requiresController: id => controllerTools.has(id),
    supportsPromptEditing: !!provider.forkForPromptEdit,
    async supportsNativePrefix(target) {
      const capability = resolveAgentNativePrefixCapability(provider);
      if (closed || !capability || capability.createdSessionIdMaxLength > 512) return false;
      await sourceAccessCheck?.(target.nativeSessionId);
      if (await lookupSourceGrant(target.nativeSessionId) && (!sourceReferenceAncestors || !sourceBindingReader)) return false;
      await capability.validate(target); return true;
    },
    async createNativePrefix(target, extensions, evidence, candidateKnown) {
      const capability = resolveAgentNativePrefixCapability(provider);
      if (closed || !capability || capability.createdSessionIdMaxLength > 512) throw new Error('Native prefix preparation is unavailable.');
      if (typeof candidateKnown !== 'function') throw new Error('Native prefix creation requires a checkpoint.');
      await sourceAccessCheck?.(target.nativeSessionId);
      const grant = await lookupSourceGrant(target.nativeSessionId);
      if (grant && (!sourceReferenceAncestors || !sourceBindingReader)) throw new Error('Source prefix routing is unavailable on this Host.');
      let readerId: string | undefined;
      const source = grant ? sourceExtensions(grant.sourceNativeSessionId, () => readerId, grant.handle.sessionId) : undefined;
      const boundExtensions = source ? { ...extensions, systemPrompt: [grant!.systemPrompt, extensions.systemPrompt].filter(Boolean).join('\n\n'), tools: [...(source.tools ?? []), ...(extensions.tools ?? [])] } : extensions;
      let checkpoint: AgentPersistenceHandle | undefined;
      const session = await capability.create(target, boundExtensions, async handle => {
        checkpoint = nativePrefixResumeHandle('codex', handle.sessionId, handle);
        await candidateKnown(checkpoint);
        readerId = checkpoint.sessionId;
      });
      if (!checkpoint) { await session.dispose(); throw new Error('Native prefix creation did not checkpoint its handle.'); }
      evidence?.completed();
      const id = await remember(session, sessionExtensionIdentity(boundExtensions)), entry = opened.get(id)!;
      const handle = nativePrefixResumeHandle('codex', id, checkpoint);
      readerId = id;
      entry.nativePrefix = JSON.stringify(handle);
      if (boundExtensions.tools?.length) controllerTools.add(id);
      return handle;
    },
    async verifyNativePrefix(target, handle) {
      const capability = resolveAgentNativePrefixCapability(provider);
      if (closed || !capability || capability.createdSessionIdMaxLength > 512) throw new Error('Native prefix verification is unavailable.');
      await sourceAccessCheck?.(target.nativeSessionId);
      await capability.verify(target, nativePrefixResumeHandle('codex', handle.sessionId, handle));
    },
    async validatePromptEdit(target) {
      await sourceAccessCheck?.(target.nativeSessionId);
      if (await lookupSourceGrant(target.nativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
      await provider.validatePromptEdit?.(target);
    },
    reconcileIdleSession: id => provider.reconcileIdleSession?.(id) ?? Promise.resolve(false),
    canReleaseSession: id => provider.canReleaseSession?.(id) === true,
    sessionReleased(id) { opened.delete(id); controllerTools.delete(id); },
    supportsSourceReferences: !!references && !!provider.readSessionHistory,
    async supportsBoundedSourceCreate(input) {
      const limit = provider.createdSessionIdMaxLength;
      return !closed && !!input.sourceNativeSessionId?.trim() && !input.editNativeSessionId && !input.editTurnId && !input.editMessageId
        && typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 512;
    },
    ...(provider.readSessionWorkspace ? { sessionWorkspace: provider.readSessionWorkspace.bind(provider) } : {}),
    setSourceAccessCheck(check) { sourceAccessCheck = check; },
    setSourceBindingReader(reader) { sourceBindingReader = reader; },
    setSourceReferenceAncestors(resolve) { sourceReferenceAncestors = resolve; },
    sourceReferences: () => references?.list() ?? Promise.resolve([]),
    ...(provider.forkSession ? { async forkSession(nativeSessionId: string) {
      if (closed) throw new Error('Codex directory is closed.');
      await sourceAccessCheck?.(nativeSessionId);
      if (await lookupSourceGrant(nativeSessionId)) throw new Error('Primary handoff is unavailable in side or Ask conversations.');
      return remember(await provider.forkSession!(nativeSessionId));
    } } : {}),
    list() { if (closed) throw new Error('Codex directory is closed.'); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    async create(input, evidence) {
      if (closed) throw new Error('Codex directory is closed.');
      if (input.editNativeSessionId) {
        if (!provider.forkForPromptEdit || !input.editTurnId || !input.editMessageId) throw new Error('Native prompt editing is unavailable.');
        await sourceAccessCheck?.(input.editNativeSessionId);
        if (await lookupSourceGrant(input.editNativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
        const native = await provider.forkForPromptEdit({ nativeSessionId: input.editNativeSessionId, turnId: input.editTurnId, messageId: input.editMessageId });
        evidence?.completed();
        return remember(native);
      }
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown Codex workspace.');
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      const { sourceNativeSessionId, ...config } = input;
      if (sourceNativeSessionId && (!references || !provider.readSessionHistory)) throw new Error('Source references are unavailable on this Host.');
      let readerId: string | undefined;
      const extensions = sourceNativeSessionId ? sourceExtensions(sourceNativeSessionId, () => readerId) : {};
      const systemPrompt = [config.systemPrompt, extensions.systemPrompt].filter(Boolean).join('\n\n');
      const nativeConfig = { ...config, ...extensions, sessionId: randomUUID(), ...(cwd ? { cwd } : {}),
        ...(systemPrompt ? { systemPrompt } : {}) };
      const identity = sessionExtensionIdentity(nativeConfig);
      const session = await provider.createSession(nativeConfig);
      evidence?.completed();
      const id = await remember(session, identity);
      if (extensions.tools?.length || config.tools?.length) controllerTools.add(id);
      if (sourceNativeSessionId) {
        try { await references!.set({ sourceNativeSessionId, systemPrompt, handle: opened.get(id)!.handle }); }
        catch (error) { opened.delete(id); controllerTools.delete(id); return disposeAfterSourceGrantFailure(error, () => session.dispose()); }
      }
      readerId = id;
      return id;
    },
    async open(nativeSessionId, options) {
      if (closed) throw new Error('Codex directory is closed.');
      if (options?.nativePrefix && (options.nativeCreation || options.resumeHandle || options.resumeOptions)) throw new Error('Native prefix cannot use empty creation recovery options.');
      const prefixHandle = options?.nativePrefix && nativePrefixResumeHandle('codex', nativeSessionId, options.nativePrefix);
      const prefixIdentity = prefixHandle && JSON.stringify(prefixHandle);
      const handle = prefixHandle ?? successionResumeHandle('codex', nativeSessionId, options?.nativeCreation, options?.resumeHandle);
      const creationIdentity = options?.nativeCreation ? serializeAgentEmptyCreationResult(options.nativeCreation) : undefined;
      const existing = opened.get(nativeSessionId);
      const reusable = existing && (await existing.session.runtimeInfo()).status !== 'closed';
      if (reusable && prefixIdentity && existing.nativePrefix !== prefixIdentity) throw new Error('Existing attachment does not match the original native prefix handle.');
      if (reusable && creationIdentity && existing.nativeCreation !== creationIdentity) throw new Error('Existing attachment does not match the original native creation evidence.');
      if (reusable && options?.extensions === undefined) return existing.session;
      const grant = await lookupSourceGrant(nativeSessionId, prefixHandle);
      if (grant && !provider.readSessionHistory) throw new Error('Source history tools are unavailable on this Host.');
      const extensions = grant ? sourceExtensions(grant.sourceNativeSessionId, () => nativeSessionId, grant.handle.sessionId) : undefined;
      const resumedExtensions = extensions || options?.extensions ? { ...(extensions ? { tools: extensions.tools, systemPrompt: grant!.systemPrompt } : {}),
        ...options?.extensions, ...(prefixHandle && grant ? { systemPrompt: [grant.systemPrompt, options?.extensions?.systemPrompt].filter(Boolean).join('\n\n') } : {}), tools: [...(extensions?.tools ?? []), ...(options?.extensions?.tools ?? [])] } : undefined;
      if (reusable) {
        requireSessionExtensionIdentity(existing.extensionIdentity, resumedExtensions);
        return existing.session;
      }
      const identity = sessionExtensionIdentity(resumedExtensions);
      // Let native saved settings win after a Host restart; only restore Host instructions and tools.
      const resume = () => provider.resumeSession(handle ?? existing?.handle ?? { providerId: 'codex', sessionId: nativeSessionId, opaque: '{}' },
        resumedExtensions);
      let session: AgentSession;
      try { session = await resume(); }
      catch (error) {
        if (!(error instanceof AgentSessionInUseError) || !provider.releaseSessionOwner) throw error;
        const owner = await provider.inspectSessionOwner?.(nativeSessionId);
        if (!owner) throw error;
        const identity = {kind: 'native_cli' as const, generation: owner.generation};
        if (!options?.takeOver) throw new NativeSessionOwnerError('native_session_owned', 'This session is open in a private Codex client. Interrupt it and resume the same session with shared control.', identity);
        if (options.takeOver !== owner.generation) throw new NativeSessionOwnerError('native_owner_changed', 'The Codex writer changed. Check the session before taking over again.', identity);
        try { await provider.releaseSessionOwner(nativeSessionId, options.takeOver); }
        catch (failure) {
          const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
          throw new NativeSessionOwnerError(code === 'native_owner_changed' ? code : 'native_handoff_unknown', failure instanceof Error ? failure.message : 'Codex release was not confirmed.');
        }
        try { session = await resume(); }
        catch { throw new NativeSessionOwnerError('native_handoff_unknown', 'The original Codex client was asked to stop, but shared recovery was not confirmed. Check the session before retrying.'); }
      }
      const resumedId = await remember(session, identity);
      if (resumedId !== nativeSessionId) { opened.delete(resumedId); await session.dispose(); throw new Error('Native creation attachment identity changed.'); }
      if (creationIdentity) opened.get(nativeSessionId)!.nativeCreation = creationIdentity;
      if (prefixIdentity) opened.get(nativeSessionId)!.nativePrefix = prefixIdentity;
      if (extensions?.tools?.length || options?.extensions?.tools?.length) controllerTools.add(nativeSessionId);
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
