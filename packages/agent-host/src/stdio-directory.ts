import { nativePrefixResumeHandle, successionResumeHandle } from './local-succession-preparation.js';
import { resolveAgentNativePrefixCapability, serializeAgentEmptyCreationResult, type AgentNativePrefixTarget } from '@orchardworks/agent-provider-sdk';
import {acquireNativeSession, inspectNativeOwner, NativeSessionOwnerError, type NativeSessionLease, type NativeOwnerDiagnostic, type NativeOwnerIdentity, type NativeHandoffGrant} from './native-session-owner.js';
import { randomUUID } from 'node:crypto';
import type {RemoteSessionSummary} from '@orchardworks/agent-remote-relay';
import type { AgentHistoryQuery, AgentPersistenceHandle, AgentProviderAdapter, AgentSession, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';
import { requireSessionExtensionIdentity, sessionExtensionIdentity } from './session-extension-identity.js';
import { SessionReferenceStore, disposeAfterSourceGrantFailure, sourceSessionExtensions, type SourceBindingReader } from './session-reference.js';

export type ManagedStdioProvider = Pick<AgentProviderAdapter, 'createSession' | 'resumeSession' | 'readSessionHistory' | 'nativePrefix'> & {
    validatePromptEdit?(target: AgentNativePrefixTarget): Promise<void>;
    /** Pre-effect guarantee: ordinary createSession returns a same-provider ID with nonempty trim,
     * at most this many UTF-16 units. Covers every selected create mode, not resume/fork or history. */
    readonly createdSessionIdMaxLength?: number;
    listSessions(): Promise<RemoteSessionSummary[]>;
    readSessionTitle?(id: string): Promise<string | undefined>;
    renameSession?(id: string, title: string): Promise<string>;
    validateSessionTitle?(title: string): void;
    /** Some runtimes expose metadata writes only on a loaded native session. */
    sessionRenameRequiresOpen?: boolean;
    sessionWorkspace?(id: string, handle?: AgentPersistenceHandle): Promise<string | undefined>;
    openChildSession?(parent: string, child: string): Promise<AgentSession>;
    dispose?(): Promise<void>;
    releaseSession?(id: string): Promise<void>;
    /** Only clean up a failed open owned by this provider; never close an external writer. */
    cleanupFailedSession?(id: string): Promise<void>;
  };

/** Owns stdio sessions and their managed native leases independently of the paired uplink. */
export function createManagedStdioDirectory(
  providerId: string,
  displayName: string,
  provider: ManagedStdioProvider,
  workspaces: readonly AgentHostWorkspace[],
  ownership?: {root: string; onDiagnostic?: (event: NativeOwnerDiagnostic) => void},
  references?: SessionReferenceStore,
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string; extensionIdentity: string; sourceAvailable: boolean; nativeCreation?: string; nativePrefix?: string; owner?: NativeSessionLease }>();
  const leases = new Map<string, NativeSessionLease>();
  const yielded = new Set<string>();
  const unconfirmedStarts = new Set<string>();
  const rejectedStarts = new Map<string, { session: AgentSession; owner?: NativeSessionLease }>();
  const controllerTools = new Set<string>();
  let sourceAccessCheck: ((id: string) => Promise<void>) | undefined;
  let sourceBindingReader: SourceBindingReader | undefined;
  let onHandoff: ((id: string, next: NativeOwnerIdentity) => Promise<void>) | undefined;
  let onHandoffAdmission: ((id: string, current: NativeOwnerIdentity, next: NativeOwnerIdentity) => NativeHandoffGrant) | undefined;
  const loading = new Map<string, Promise<AgentSession>>();
  async function lease(id: string, takeOver?: string) {
    if (!ownership) return undefined;
    const key = {...ownership, providerId, sessionId: id};
    if (yielded.has(id) && !takeOver && !await inspectNativeOwner(key)) throw new NativeSessionOwnerError('native_session_released', 'Control was transferred to the CLI. Explicitly take control to reopen this session.', {kind: 'native_cli', generation: leases.get(id)!.generation});
    const value = await acquireNativeSession({...key, kind: 'controller', takeOver});
    leases.set(id, value); yielded.delete(id); return value;
  }
  async function releaseFailedStart(id: string): Promise<void> {
    if (!unconfirmedStarts.has(id)) return;
    await provider.cleanupFailedSession?.(id);
    await leases.get(id)?.release();
    unconfirmedStarts.delete(id);
  }
  async function releaseRejectedStart(id: string): Promise<void> {
    const rejected = rejectedStarts.get(id);
    if (!rejected) return;
    await rejected.session.dispose();
    await rejected.owner?.release();
    rejectedStarts.delete(id);
  }
  function managed(session: AgentSession, id: string, owner?: NativeSessionLease): AgentSession {
    if (!owner && !references) return session;
    let transferring = false, shutdownRequested = false, nativeReleased = false;
    let shutdown: Promise<void> | undefined;
    const releaseNative = async () => {
      if (nativeReleased) return;
      if (!provider.releaseSession) throw new Error('Native release cannot be confirmed.');
      await provider.releaseSession(id);
      nativeReleased = true;
    };
    const dispose = async () => {
      shutdownRequested = true;
      const entry = opened.get(id);
      if (entry?.session === managedSession) entry.sourceAvailable = false;
      shutdown ??= (async () => {
        const info = await session.runtimeInfo();
        const entry = opened.get(id);
        if (entry?.session === managedSession && info.persistence) entry.handle = info.persistence;
        if (transferring) await releaseNative();
        await session.dispose();
      })().catch(error => { shutdown = undefined; throw error; });
      await shutdown;
      if (!transferring) await owner?.release();
    };
    owner?.activate(async next => {
      transferring = true; yielded.add(id);
      await onHandoff?.(id, {kind: 'controller', generation: owner.generation});
      await dispose();
      // A directory shutdown may have started before this transfer request.
      await releaseNative();
      return 'requested';
    }, next => { void onHandoff?.(id, next).catch(error => ownership?.onDiagnostic?.({event: 'native_handoff_notification_failed', providerId, sessionId: id, generation: owner.generation, at: new Date().toISOString(), outcome: String(error)})); }, next => onHandoffAdmission ? onHandoffAdmission(id, { kind: 'controller', generation: owner.generation }, next) : { completed() {}, failed() {} });
    const managedSession = new Proxy(session, {get(target, key) {
      if (key === 'dispose') return dispose;
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (owner && ['sendMessage','sendMessageContent','steer','cancel','respondToInteraction','setPlanning','setSessionSetting','executeCommand','readResource'].includes(String(key))) return (...args: unknown[]) => {
        if (shutdownRequested || !owner.active) return Promise.reject(new Error('Native control was transferred. Take ownership before interacting.'));
        return Reflect.apply(value, target, args);
      };
      return value.bind(target);
    }});
    return managedSession;
  }
  let discovery: Promise<RemoteSessionSummary[]> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  async function discover(): Promise<RemoteSessionSummary[]> {
    const summaries = new Map((await provider.listSessions()).map((summary) => [summary.nativeSessionId, summary]));
    for (const [nativeSessionId, entry] of opened) {
      const info = await entry.session.runtimeInfo();
      const previous = summaries.get(nativeSessionId);
      summaries.set(nativeSessionId, { nativeSessionId, providerId, title: previous?.title ?? `New ${displayName} session`,
        ...(info.cwd ?? previous?.workspace ? { workspace: info.cwd ?? previous?.workspace } : {}),
        createdAt: previous?.createdAt ?? entry.createdAt, updatedAt: previous?.updatedAt ?? entry.createdAt,
        state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting' : info.status === 'failed' ? 'unavailable' : info.status === 'idle' ? 'idle' : 'unknown' });
    }
    return [...summaries.values()];
  }
  async function remember(session: AgentSession, owner: NativeSessionLease | undefined, extensionIdentity: string, expectedId?: string): Promise<string> {
    try {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      const info = await session.runtimeInfo();
      if (closed) throw new Error(`${displayName} directory is closed.`);
      if (!info.persistence || !info.sessionId) throw new Error(`${displayName} did not return a native persistence handle.`);
      if (info.providerId !== providerId || info.persistence.providerId !== providerId || info.persistence.sessionId !== info.sessionId
        || expectedId !== undefined && info.sessionId !== expectedId) throw new Error(`${displayName} returned a mismatched native session identity.`);
      owner ??= await lease(info.sessionId);
      if (closed) throw new Error(`${displayName} directory is closed.`);
      session = managed(session, info.sessionId, owner);
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString(), extensionIdentity, sourceAvailable: true, owner });
      return info.sessionId;
    } catch (error) {
      try { await session.dispose(); await owner?.release(); }
      catch (cleanupError) {
        rejectedStarts.set(expectedId ?? randomUUID(), { session, owner });
        throw new AggregateError([error, cleanupError], `${displayName} initialization cleanup could not be confirmed.`);
      }
      throw error;
    }
  }
  async function readSource(id: string, query: AgentHistoryQuery) {
    await requireSourceAccess(id);
    if (!provider.readSessionHistory) throw new Error('Source history tools are unavailable on this Host.');
    const page = await provider.readSessionHistory(id, query);
    await requireSourceAccess(id);
    return page;
  }
  async function requireSourceAccess(id: string) {
    if (closed) throw new Error(`${displayName} directory is closed.`);
    const check = sourceAccessCheck;
    await check?.(id);
    if (closed) throw new Error(`${displayName} directory is closed.`);
    if (sourceAccessCheck !== check) throw new Error('Source access policy changed during validation.');
  }
  function requireSourceReader(id: string, session: AgentSession) {
    if (closed) throw new Error(`${displayName} directory is closed.`);
    const entry = opened.get(id);
    if (entry?.session !== session || !entry.sourceAvailable || entry.owner && !entry.owner.active) throw new Error('Source reader control was transferred or closed.');
  }
  async function validateSourceReader(id: string, session: AgentSession) {
    requireSourceReader(id, session);
    const info = await session.runtimeInfo();
    requireSourceReader(id, session);
    if (info.status === 'closed') throw new Error('Source reader is closed.');
    if (info.providerId !== providerId || info.sessionId !== id || info.persistence?.providerId !== providerId || info.persistence.sessionId !== id) throw new Error('Source reader identity does not match.');
  }
  function sourceExtensions(source: string, reader: () => string | undefined, readerSession: () => AgentSession | undefined = () => undefined) {
    const extensions = sourceSessionExtensions(source, readSource, async query => {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      const id = reader();
      const session = id && opened.get(id)?.session;
      if (!id || !session || session !== readerSession()) throw new Error('Source reader identity is not ready or is obsolete.');
      await validateSourceReader(id, session);
      requireSourceReader(id, session);
      const localSources = new Set<string>();
      const readLocal = async (sourceId: string, historyQuery: AgentHistoryQuery) => {
        const result = await readSource(sourceId, historyQuery);
        localSources.add(sourceId);
        return result;
      };
      let page;
      if (sourceBindingReader) page = await sourceBindingReader(id, source, query, readLocal);
      else {
        if (query.sourceContext) throw new Error('Source context is unavailable on this Host.');
        page = { ...await readLocal(source, query), sourceSessionId: source };
      }
      await validateSourceReader(id, session);
      for (const sourceId of localSources) {
        await requireSourceAccess(sourceId);
        requireSourceReader(id, session);
      }
      requireSourceReader(id, session);
      return page;
    });
    return { instructions: extensions.systemPrompt, tools: extensions.tools };
  }
  function composeExtensions(base: AgentSessionExtensions = {}, additional: AgentSessionExtensions = {}): AgentSessionExtensions {
    if (base.systemPrompt !== undefined && additional.systemPrompt !== undefined && base.systemPrompt !== additional.systemPrompt) throw new Error('Conflicting native system prompt extensions.');
    const tools = [...(base.tools ?? []), ...(additional.tools ?? [])];
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate or conflicting session tool names.');
    const instructions = [...new Set([base.instructions, additional.instructions].filter((value): value is string => !!value))].join('\n\n');
    return { ...(base.systemPrompt !== undefined || additional.systemPrompt !== undefined ? { systemPrompt: base.systemPrompt ?? additional.systemPrompt } : {}),
      ...(instructions ? { instructions } : {}), ...(tools.length ? { tools } : {}) };
  }
  async function resumedExtensions(id: string, requested: AgentSessionExtensions | undefined, reader: () => string | undefined, readerSession?: () => AgentSession | undefined) {
    const grant = await references?.get(id);
    if (!grant) { composeExtensions(requested); return requested; }
    if (!provider.readSessionHistory) throw new Error('Source history tools are unavailable on this Host.');
    const base = { ...(grant.systemPromptProvided ?? !!grant.systemPrompt ? { systemPrompt: grant.systemPrompt } : {}), ...(grant.instructions ? { instructions: grant.instructions } : {}) };
    return composeExtensions(composeExtensions(base, requested), sourceExtensions(grant.sourceNativeSessionId, reader, readerSession));
  }
  const directory: AgentHostDirectory = {
    providerId,
    supportsSourceReferences: !!references && !!provider.readSessionHistory,
    async supportsBoundedSourceCreate(input) {
      const limit = provider.createdSessionIdMaxLength;
      return !closed && !!input.sourceNativeSessionId?.trim() && !input.editNativeSessionId && !input.editTurnId && !input.editMessageId
        && typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 512;
    },
    setSourceAccessCheck(check) { sourceAccessCheck = check; },
    setSourceBindingReader(reader) { sourceBindingReader = reader; },
    sourceReferences: () => references?.list() ?? Promise.resolve([]),
    requiresController: id => controllerTools.has(id),
    list() { if (closed) throw new Error(`${displayName} directory is closed.`); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    ...(provider.readSessionTitle ? {sessionTitle: provider.readSessionTitle.bind(provider)} : {}),
    ...(provider.renameSession ? {
      async validateSessionRename(id: string, title: string) {
        if (closed) throw new Error(`${displayName} directory is closed.`);
        provider.validateSessionTitle?.(title);
        if (provider.sessionRenameRequiresOpen) await directory.open(id);
      },
      async renameSession(id: string, title: string) {
        await directory.validateSessionRename!(id, title);
        return provider.renameSession!(id, title);
      },
    } : {}),
    ...(provider.sessionWorkspace ? {sessionWorkspace: provider.sessionWorkspace.bind(provider)} : {}),
    async create(input, evidence) {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error(`Unknown ${displayName} workspace.`);
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      const { sourceNativeSessionId, ...inputConfig } = input;
      if (sourceNativeSessionId && (!references || !provider.readSessionHistory)) throw new Error('Source references are unavailable on this Host.');
      let readerId: string | undefined;
      let readerSession: AgentSession | undefined;
      const extensions = composeExtensions(inputConfig, sourceNativeSessionId ? sourceExtensions(sourceNativeSessionId, () => readerId, () => readerSession) : {});
      const config = { ...inputConfig, ...extensions, sessionId: randomUUID(), ...(cwd ? { cwd } : {}) };
      const identity = sessionExtensionIdentity(config);
      const native = await provider.createSession(config);
      evidence?.completed();
      const id = await remember(native, undefined, identity);
      const entry = opened.get(id)!;
      if (config.tools?.length) controllerTools.add(id);
      if (sourceNativeSessionId) {
        try { await references!.set({ sourceNativeSessionId, systemPrompt: inputConfig.systemPrompt ?? '', systemPromptProvided: inputConfig.systemPrompt !== undefined, instructions: inputConfig.instructions, handle: entry.handle }); }
        catch (error) {
          entry.sourceAvailable = false;
          return disposeAfterSourceGrantFailure(error, async () => {
            await entry.session.dispose(); if (opened.get(id) === entry) opened.delete(id); controllerTools.delete(id);
          });
        }
      }
      if (closed) throw new Error(`${displayName} directory is closed.`);
      if (opened.get(id) !== entry || !entry.sourceAvailable || entry.owner && !entry.owner.active) throw new Error('Source reader control was transferred or closed during creation.');
      readerId = id;
      readerSession = entry.session;
      return id;
    },
    ...(resolveAgentNativePrefixCapability(provider) ? {
      async supportsNativePrefix(target: AgentNativePrefixTarget) {
        const capability = resolveAgentNativePrefixCapability(provider);
        if (closed || !capability || capability.createdSessionIdMaxLength > 512) return false;
        await requireSourceAccess(target.nativeSessionId);
        if (await references?.get(target.nativeSessionId)) return false;
        await capability.validate(target); return true;
      },
      async createNativePrefix(target: AgentNativePrefixTarget, extensions: AgentSessionExtensions, evidence: { completed(): void } | undefined, candidateKnown: (handle: AgentPersistenceHandle) => Promise<void>) {
        const capability = resolveAgentNativePrefixCapability(provider);
        if (closed || !capability || capability.createdSessionIdMaxLength > 512) throw new Error('Native prefix preparation is unavailable.');
        if (typeof candidateKnown !== 'function') throw new Error('Native prefix creation requires a checkpoint.');
        await requireSourceAccess(target.nativeSessionId);
        if (await references?.get(target.nativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
        composeExtensions(extensions);
        let checkpoint: AgentPersistenceHandle | undefined;
        const session = await capability.create(target, extensions, async handle => {
          checkpoint = nativePrefixResumeHandle(providerId, handle.sessionId, handle);
          await candidateKnown(checkpoint);
        });
        if (!checkpoint) { await session.dispose(); throw new Error('Native prefix creation did not checkpoint its handle.'); }
        evidence?.completed();
        const id = await remember(session, undefined, sessionExtensionIdentity(extensions), checkpoint.sessionId);
        const handle = nativePrefixResumeHandle(providerId, id, checkpoint);
        opened.get(id)!.nativePrefix = JSON.stringify(handle);
        if (extensions.tools?.length) controllerTools.add(id);
        return handle;
      },
      async verifyNativePrefix(target: AgentNativePrefixTarget, handle: AgentPersistenceHandle) {
        const capability = resolveAgentNativePrefixCapability(provider);
        if (closed || !capability || capability.createdSessionIdMaxLength > 512) throw new Error('Native prefix verification is unavailable.');
        await requireSourceAccess(target.nativeSessionId);
        await capability.verify(target, nativePrefixResumeHandle(providerId, handle.sessionId, handle));
      },
      async validatePromptEdit(target: AgentNativePrefixTarget) {
        await requireSourceAccess(target.nativeSessionId);
        if (await references?.get(target.nativeSessionId)) throw new Error('Editing previous prompts is unavailable in side or Ask conversations.');
        await resolveAgentNativePrefixCapability(provider)!.validate(target);
      },
    } : {}),
    setSessionHandoffHandler(handler) { onHandoff = handler; },
    setSessionHandoffAdmission(handler) { onHandoffAdmission = handler; },
    async open(nativeSessionId, options) {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      if (options?.nativePrefix && (options.nativeCreation || options.resumeHandle || options.resumeOptions)) throw new Error('Native prefix cannot use empty creation recovery options.');
      const prefixHandle = options?.nativePrefix && nativePrefixResumeHandle(providerId, nativeSessionId, options.nativePrefix);
      const prefixIdentity = prefixHandle ? JSON.stringify(prefixHandle) : undefined;
      const handle = prefixHandle || successionResumeHandle(providerId, nativeSessionId, options?.nativeCreation, options?.resumeHandle);
      if (options?.resumeOptions?.initializeEmpty && !handle) throw new Error('Empty initialization requires original creation evidence.');
      // A prefix branch of a first prompt is still empty until its first message; its handle is the original creation evidence.
      const resumeOptions = prefixHandle ? { initializeEmpty: true } : options?.resumeOptions;
      const creationIdentity = options?.nativeCreation ? serializeAgentEmptyCreationResult(options.nativeCreation) : undefined;
      const assertCreation = () => {
        if (creationIdentity && opened.get(nativeSessionId)?.nativeCreation !== creationIdentity) throw new Error('Existing attachment does not match the original native creation evidence.');
        if (prefixIdentity && opened.get(nativeSessionId)?.nativePrefix !== prefixIdentity) throw new Error('Existing attachment does not match the original native prefix handle.');
      };
      const pending = loading.get(nativeSessionId);
      if (pending) {
        const session = await pending;
        assertCreation();
        requireSessionExtensionIdentity(opened.get(nativeSessionId)?.extensionIdentity, options?.extensions === undefined ? undefined : await resumedExtensions(nativeSessionId, options.extensions, () => nativeSessionId));
        return session;
      }
      const opening = (async () => {
        await releaseRejectedStart(nativeSessionId);
        await releaseFailedStart(nativeSessionId);
        const existing = opened.get(nativeSessionId);
        if (existing && !yielded.has(nativeSessionId) && (await existing.session.runtimeInfo()).status !== 'closed') {
          assertCreation();
          requireSessionExtensionIdentity(existing.extensionIdentity, options?.extensions === undefined ? undefined : await resumedExtensions(nativeSessionId, options.extensions, () => nativeSessionId));
          return existing.session;
        }
        if (existing && yielded.has(nativeSessionId)) {
          await existing.session.dispose();
          // Outside the handoff callback, so release can wait for a failed/in-flight transfer.
          await leases.get(nativeSessionId)?.release();
        }
        let readerReady = false;
        let readerSession: AgentSession | undefined;
        const extensions = await resumedExtensions(nativeSessionId, options?.extensions, () => readerReady ? nativeSessionId : undefined, () => readerSession);
        const owner = await lease(nativeSessionId, options?.takeOver);
        const identity = sessionExtensionIdentity(extensions);
        let session: AgentSession;
        try {
          session = await provider.resumeSession(handle ?? existing?.handle ?? { providerId, sessionId: nativeSessionId, opaque: '{}' }, extensions, resumeOptions);
        } catch (error) {
          if (owner) {
            unconfirmedStarts.add(nativeSessionId);
            await releaseFailedStart(nativeSessionId);
          }
          throw error;
        }
        await remember(session, owner, identity, nativeSessionId);
        if (creationIdentity) opened.get(nativeSessionId)!.nativeCreation = creationIdentity;
        if (prefixIdentity) opened.get(nativeSessionId)!.nativePrefix = prefixIdentity;
        if (extensions?.tools?.length) controllerTools.add(nativeSessionId);
        readerReady = true;
        readerSession = opened.get(nativeSessionId)!.session;
        return opened.get(nativeSessionId)!.session;
      })();
      loading.set(nativeSessionId, opening);
      try { return await opening; } finally { loading.delete(nativeSessionId); }
    },
    close() {
      if (closing) return closing;
      closed = true;
      return closing = (async () => {
        await discovery?.catch(() => undefined);
        const entries = [...opened.entries()];
        const results = await Promise.allSettled(entries.map(([, {session}]) => session.dispose()));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        for (const id of [...unconfirmedStarts]) {
          try { await releaseFailedStart(id); } catch (error) { errors.push(error); }
        }
        for (const id of [...rejectedStarts.keys()]) {
          try { await releaseRejectedStart(id); } catch (error) { errors.push(error); }
        }
        try { await provider.dispose?.(); } catch (error) { errors.push(error); }
        // An unconfirmed native shutdown must keep its lease, even after directory shutdown.
        if (errors.length) throw new AggregateError(errors, `${displayName} shutdown could not be confirmed.`);
        // In-flight opens still own their leases until their own cleanup confirms exit.
        await Promise.all(entries.map(([, entry]) => entry.owner?.release()));
        for (const [id, entry] of entries) {
          if (leases.get(id) === entry.owner) leases.delete(id);
          if (opened.get(id) === entry) opened.delete(id);
        }
      })();
    },
    ...(provider.openChildSession ? { async openChild(parentNativeSessionId: string, nativeSessionId: string) {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      return provider.openChildSession!(parentNativeSessionId, nativeSessionId);
    } } : {}),
  };
  return directory;
}
