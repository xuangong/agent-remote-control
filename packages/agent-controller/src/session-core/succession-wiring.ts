import { randomUUID } from 'node:crypto';
import { nativePrefixSegmentAncestors, nativeSessionRefKey, type NativePrefixSelection, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { serializeAgentInputMaterialization, type AgentNativeValidityToken, type AgentProviderAdapter, type AgentSession, type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { type RemoteHostSessionLease } from '@orchardworks/agent-session-runtime';

import { directoryOperationId } from '../directory-mutation.js';
import { admitNativeOwnerTransfer } from '../native-owner-admission.js';
import { allowedWorkspace, HostExecutionPolicyError } from '../execution-policy.js';
import { nativePrefixResumeHandle, SuccessionPreparationRejected, type RetainedSuccessionVerification } from '../local-succession-preparation.js';
import { captureSuccessionTimeline } from '../session-succession-capture.js';
import { sessionHostAccess } from '../session-callers.js';
import type { SessionSuccessionPorts } from '../session-succession-service.js';
import type { AgentHostDirectory, AgentHostProviderRegistration } from './types.js';
import type { SessionCoreContext } from './context.js';
import { boundedSourceIdentity } from './requests.js';

/** A provider's native evidence is current when it is configured at version 2. */
export function hasCurrentNativeEvidence(owner: Pick<AgentProviderAdapter | AgentSession, 'nativeEvidence'>): boolean {
  const evidence = owner.nativeEvidence?.availability(); return evidence?.status === 'configured' && evidence.version === 2;
}

/**
 * Succession wiring: how the Controller answers the succession service and keeps its source and role tools current.
 *
 * Contract.
 * - `ports` is what the succession service asks of the Controller: whether a source can be handed to a target provider (role, evidence and
 *   directory support), prepared (native prefix, idle candidate, native creation), captured and read, and its delivery reconciled. Every read
 *   of a source first passes `authorizeSuccessionRead`: the source is this Controller's, its provider is enabled, and its workspace is allowed by
 *   the execution policy. No port opens a second native attachment while one is held.
 * - `inspectSuccession` reads the readiness of one attachment and refuses it while an operation of the session is unsettled, its quiescence rule is not
 *   met (`family.ts`), or the history boundary is unavailable. `retainVerification` holds the attachments of a prepared succession and says when
 *   their evidence changed; releasing it releases them.
 * - `bindProvider` gives a directory what it needs of the succession: the handoff admission and handler, the source binding reader, the source reference
 *   ancestry and the session-host access. A provider added later is bound the same way.
 * - Worker tools: a session without a role gets the worker namespace when its provider declares tools at creation, or while enabled; `applyWorkerTools`
 *   brings live sessions in line when enablement changes.
 *
 * State is read through the context; the wiring keeps none of its own.
 */
export function createSuccessionWiring(ctx: SessionCoreContext) {
  function ports(): SessionSuccessionPorts {
    return {
      async supports(source, targetProviderId) {
        await authorizeSuccessionRead(source, source);
        const target = ctx.providers.require(targetProviderId);
        if (ctx.options.providerEnabled?.(targetProviderId) === false || !target.adapter.readSessionHistory
          || !target.directory.setSourceBindingReader || !target.directory.sourceReferences) return false;
        // A generic successor takes over the role its source holds, or the handoff is refused.
        const role = await ctx.roles.genericSuccession(source, targetProviderId);
        if (!role.allowed) throw new SuccessionPreparationRejected('succession_role_unavailable', role.reason);
        if (ctx.nativeSuccession) return await ctx.nativeSuccession.supports(source, targetProviderId) === true;
        return target.directory.supportsSourceReferences === true && hasCurrentNativeEvidence(target.adapter) && hasCurrentNativeEvidence(ctx.providers.require(source.providerId).adapter);
      },
      async supportsBoundedProjection(source, targetProviderId) {
        await authorizeSuccessionRead(source, source);
        if (ctx.nativeSuccession) return await ctx.nativeSuccession.supportsBoundedProjection?.(source, targetProviderId) === true;
        return boundedSourceIdentity(ctx.successionConfig!.controllerId) && boundedSourceIdentity(targetProviderId) && hasCurrentNativeEvidence(ctx.providers.require(targetProviderId).adapter) && hasCurrentNativeEvidence(ctx.providers.require(source.providerId).adapter);
      },
      async supportsNativePrefix(source, selection) {
        await authorizeSuccessionRead(source, source);
        await nativePrefixExtensions(source, () => source.nativeSessionId);
        const directory = ctx.providers.require(source.providerId).directory;
        if (!boundedSourceIdentity(source.controllerId) || !boundedSourceIdentity(source.providerId) || !directory.createNativePrefix || !directory.verifyNativePrefix) return false;
        const lease = await acquireNative(source);
        try {
          const session = ctx.ledger.attachmentOf(lease.agent)?.session;
          const handle = (await session?.runtimeInfo())?.persistence;
          if (!session?.promptEditEvidence || session.promptEditEvidence.version !== 1 || !handle) return false;
          nativePrefixResumeHandle(source.providerId, source.nativeSessionId, handle);
          return await directory.supportsNativePrefix?.({ nativeSessionId: source.nativeSessionId, turnId: selection.turnId, messageId: selection.messageId }) === true;
        } finally { lease.release(); }
      },
      async createNativePrefix(request, candidateKnown) {
        const selection = request.preparation;
        if (!selection) throw new Error('Native prefix selection is missing.');
        await authorizeSuccessionRead(request.from, request.from);
        let actual: string | undefined;
        const extensions = await nativePrefixExtensions(request.from, () => actual), directory = ctx.providers.require(request.from.providerId).directory;
        if (!directory.createNativePrefix) throw new Error('Native prefix creation is unavailable.');
        const handle = await directory.createNativePrefix({ nativeSessionId: request.from.nativeSessionId, turnId: selection.turnId, messageId: selection.messageId }, extensions, undefined, async handle => {
          actual = handle.sessionId;
          await candidateKnown({ target: { controllerId: request.from.controllerId, providerId: handle.providerId, nativeSessionId: handle.sessionId }, handle });
        });
        actual = handle.sessionId;
        return { target: { controllerId: request.from.controllerId, providerId: handle.providerId, nativeSessionId: handle.sessionId }, handle };
      },
      async verifyNativePrefix(prepared, handle) {
        const selection = prepared.preparation, directory = ctx.providers.require(prepared.from.providerId).directory;
        if (!selection || !directory.verifyNativePrefix) throw new Error('Native prefix verification is unavailable.');
        await directory.verifyNativePrefix({ nativeSessionId: prepared.from.nativeSessionId, turnId: selection.turnId, messageId: selection.messageId }, handle);
      },
      async inspect(source, preparation) {
        const lease = await acquireNative(source);
        try { return await inspectSuccession(source, lease, preparation); } finally { lease.release(); }
      },
      async selectNativeCreation(source, operationId, targetProviderId) {
        await authorizeSuccessionRead(source, source);
        const evidence = ctx.providers.require(targetProviderId).adapter.nativeEvidence;
        if (!hasCurrentNativeEvidence(ctx.providers.require(targetProviderId).adapter)) return undefined;
        const role = ctx.succession?.store.all().find(state => nativeSessionRefKey(state.role.current) === nativeSessionRefKey(source))?.role;
        if (!role) throw new Error('Native ctx.succession role is unavailable.');
        // The successor carries its source's role from creation; the role's tools run only once it is attached.
        const extensions = await ctx.roles.extensions(source, () => undefined) ?? workerExtensions(targetProviderId, source, () => undefined);
        const config = { sessionId: directoryOperationId(operationId), cwd: role.workspace.canonicalCwd, ...(source.providerId === targetProviderId ? { selectionSourceSessionId: source.nativeSessionId } : {}),
          ...(extensions ? { extensions } : {}) };
        return () => evidence!.createEmpty(config);
      },
      retainVerification,
      async createIdle(source, operationId, targetProviderId) {
        if (!ctx.nativeSuccession) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'Idle candidate creation is unavailable.');
        await authorizeSuccessionRead(source, source);
        return ctx.nativeSuccession.createIdle(source, operationId, targetProviderId);
      },
      async captureTimeline(source) {
        await authorizeSuccessionRead(source, source);
        const lease = await acquireNative(source);
        try { return await captureSuccessionTimeline(lease.agent); } finally { lease.release(); }
      },
      authorizeRead: authorizeSuccessionRead,
      async readHistory(source, query) {
        await authorizeSuccessionRead(source, source);
        const adapter = ctx.providers.require(source.providerId).adapter;
        if (!adapter.readSessionHistory) throw new Error('Routed native history is unavailable.');
        return adapter.readSessionHistory(source.nativeSessionId, query);
      },
      async reconcileDelivery(delivery) {
        if (!delivery.preparedInput) return ctx.nativeSuccession?.reconcileDelivery(delivery);
        const lease = await acquireNative(delivery.target);
        try {
          const evidence = ctx.ledger.attachmentOf(lease.agent)?.session.nativeEvidence;
          if (!evidence || evidence.availability().status !== 'configured' || (evidence.availability() as { version?: number }).version !== 2) return undefined;
          const result = await evidence.inspectInput(delivery.preparedInput.witness);
          return result.status === 'materialized' ? { outcome: 'materialized', nativeEvidence: serializeAgentInputMaterialization(result) } : undefined;
        } finally { lease.release(); }
      },
    };
  }
  function bindHandoff(directory: AgentHostDirectory) {
    const { mutationFamily, sessions, nativeRef, operationCache, relay, successionBoundary, tpm } = ctx;
    if (successionBoundary) directory.setSessionHandoffAdmission?.((nativeSessionId, current, next) =>
      admitNativeOwnerTransfer(operationCache, successionBoundary, mutationFamily([nativeRef({ providerId: directory.providerId, nativeSessionId })]), current, next));
    directory.setSessionHandoffHandler?.(async (nativeSessionId, next) => {
    await tpm?.handoff(directory.providerId, nativeSessionId);
    const family = sessions.family(directory.providerId, nativeSessionId);
    for (const binding of family) relay.sessionControls?.setNativeOwner(binding.agentId, next);
    for (const binding of family.reverse()) await relay.closeAgent(binding.agentId);
  }); }
  function bindSourceReader(directory: AgentHostDirectory) {
    const { successionReady, successionService } = ctx;
    if (!successionService) return;
    directory.setSourceBindingReader?.(async (reader, source, query, legacyRead, canonicalReader) => {
      await successionReady;
      return successionService.bindings(directory.providerId).read(reader, source, query, legacyRead, canonicalReader);
    });
  }
  function bindHostAccess({ adapter, directory }: AgentHostProviderRegistration) {
    const { options } = ctx;
    const callers = options.sessionCallers;
    if (callers && adapter.descriptor.sessionHostAccess) directory.setSessionHostAccess?.(sessionHostAccess(callers.store, directory.providerId, callers.endpoint, callers.skills, callers.sessionBin));
  }
  /** A share recipient's session is hidden from session commands and holds no credential. */
  async function markShared(payload: Record<string, unknown> | undefined, providerId: string, nativeSessionId: string) {
    const { options } = ctx;
    if (payload?.shared === true) await options.sessionCallers?.store.markShared({ providerId, nativeSessionId });
  }
  function bindSourceReferenceAncestry(directory: AgentHostDirectory) {
    const { nativeRef, originalNativePrefix, successionReady, successionService } = ctx;
    if (!successionService) return;
    directory.setSourceReferenceAncestors?.(async (id, preparationHandle) => {
      await successionReady;
      let target = nativeRef({ providerId: directory.providerId, nativeSessionId: id });
      if (preparationHandle) {
        const saved = originalNativePrefix(target);
        if (!saved || JSON.stringify(saved.handle) !== JSON.stringify(preparationHandle)) throw new Error('Source attachment lacks exact saved native prefix evidence.');
        target = saved.source;
      }
      const ancestry = nativePrefixSegmentAncestors(target, successionService.store.all().flatMap(state => state.operations.filter(row => row.phase === 'committed')));
      return [...new Set([...ancestry.map(ref => ref.nativeSessionId), id])];
    });
  }
  /** Rebuild each native attachment from stable role anchors and its own actual recipient. */
  async function nativePrefixExtensions(source: NativeSessionRef, actual: () => string | undefined): Promise<AgentSessionExtensions> {
    const { providers, successionService, team, tpm } = ctx;
    const directory = providers.require(source.providerId).directory;
    const ancestry = nativePrefixSegmentAncestors(source, successionService!.store.all().flatMap(state => state.operations.filter(row => row.phase === 'committed')));
    const grants = (await directory.sourceReferences?.() ?? []).filter(grant => ancestry.some(ref => ref.nativeSessionId === grant.nativeSessionId));
    if (grants.length > 1) throw new Error('Source reference ancestry is ambiguous.');
    const sourceTools = grants.length === 1 && !!directory.setSourceReferenceAncestors && !!directory.setSourceBindingReader;
    const teamTools = await team?.extensions(source, () => { const id = actual(); return id ? { ...source, nativeSessionId: id } : undefined; });
    const tpmTools = await tpm?.extensions(source.providerId, source.nativeSessionId, actual);
    if (teamTools && tpmTools) throw new SuccessionPreparationRejected('succession_prefix_extensions_unavailable', 'Native recipient has conflicting role extensions.');
    if (directory.requiresController?.(source.nativeSessionId) && !sourceTools && !teamTools && !tpmTools) throw new SuccessionPreparationRejected('succession_prefix_extensions_unavailable', 'Native prefix extensions cannot be reconstructed.');
    return teamTools ?? tpmTools ?? workerExtensions(source.providerId, source, () => { const id = actual(); return id ? { ...source, nativeSessionId: id } : undefined; }) ?? {};
  }
  /** Worker tools for a session without a role: declared at creation where providers fix tools then, present only while enabled elsewhere. */
  function workerExtensions(providerId: string, holder: NativeSessionRef | undefined, actual: () => NativeSessionRef | undefined): AgentSessionExtensions | undefined {
    const { providers, workerSupport } = ctx;
    if (!workerSupport) return undefined;
    const capability = providers.require(providerId).adapter.descriptor.sessionExtensions?.toolNamespaces;
    const tools = holder ? workerSupport.tools(holder) : workerSupport.enabledByDefault() ? 'support' : 'none';
    // A bot's main session gets its standing instructions when its runtime opens; a mission changed since then applies at the next open.
    const standing = holder && providers.require(providerId).adapter.descriptor.sessionExtensions?.instructions ? workerSupport.standing(holder) : undefined;
    const instructions = standing ? { instructions: standing } : {};
    // Tools fixed at creation include the task tools, deferred unless the session is a coordinator's, so switching an assistant to coordinator mode reaches it.
    if (capability === 'creation') return { ...instructions, toolNamespaces: [workerSupport.namespace(actual, tools === 'none', true)] };
    // Without tool search, a session gets the namespace while enabled; an 'attachment' adapter receives an enablement change on its next attachment.
    if ((capability === 'live' || capability === 'attachment') && tools !== 'none') return { ...instructions, toolNamespaces: [workerSupport.namespace(actual, false, tools === 'tasks')] };
    return standing ? instructions : undefined;
  }
  /** Applies enablement changes to live sessions whose provider can change tools during a session. */
  async function applyWorkerTools(): Promise<void> {
    const { sessions, liveAgent, ledger, nativeRef, providers, roles, workerSupport } = ctx;
    if (!workerSupport) return;
    for (const binding of sessions.all()) {
      const agent = liveAgent(binding.agentId), session = agent && ledger.attachmentOf(agent)?.session;
      if (!session?.updateToolNamespaces || providers.require(binding.providerId).adapter.descriptor.sessionExtensions?.toolNamespaces !== 'live') continue;
      const ref = nativeRef(binding);
      if (await roles.extensions(ref, () => ref)) continue;
      const tools = workerSupport.tools(ref);
      if (ledger.workerToolsApplied(binding.agentId) === tools) continue;
      try { await session.updateToolNamespaces(tools === 'none' ? [] : [workerSupport.namespace(() => ref, false, tools === 'tasks')]); ledger.recordWorkerTools(binding.agentId, tools); }
      catch { /* The next enablement change or attachment applies it again. */ }
    }
  }
  async function authorizeSuccessionRead(reader: NativeSessionRef, source: NativeSessionRef): Promise<void> {
    const { options, originalCreation, originalNativePrefix, providers, successionConfig } = ctx;
    for (const target of [reader, source]) {
      const creation = originalCreation(target), prefix = originalNativePrefix(target);
      if (target.controllerId !== (successionConfig?.controllerId ?? options.controllerId ?? 'local')) throw new HostExecutionPolicyError('Source is outside this Controller.');
      if (options.providerEnabled?.(target.providerId) === false) throw new HostExecutionPolicyError('Source provider is disabled.');
      const directory = providers.require(target.providerId).directory;
      const cwd = directory.sessionWorkspace ? await directory.sessionWorkspace(target.nativeSessionId, prefix?.handle ?? (creation?.status === 'created' ? creation.handle : undefined))
        : (await directory.list()).find(item => item.nativeSessionId === target.nativeSessionId)?.workspace;
      if (!cwd) throw new HostExecutionPolicyError('Source workspace is unavailable.');
      if (options.executionPolicy) await allowedWorkspace(options.executionPolicy, cwd);
    }
  }
  async function inspectSuccession(source: NativeSessionRef, lease: RemoteHostSessionLease, preparation?: NativePrefixSelection) {
    const { assertHandoffState, sessions, liveAgent, ledger, nativeSuccession, operationCache, succession, successionBoundary, successionService, team, tpm } = ctx;
    const session = ledger.attachmentOf(lease.agent)?.session;
    if (preparation ? !session?.promptEditEvidence || session.promptEditEvidence.version !== 1 : !nativeSuccession && (!session || !hasCurrentNativeEvidence(session))) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'This provider has not certified quiescent succession.');
    const context = succession?.contexts.forTarget(source);
    if (!preparation && context?.deliveries.some(item => item.preparedInput && !['started', 'handled'].includes(item.inputAcceptance?.disposition ?? '') && ['accepted', 'unknown', 'materialized'].includes(item.state))) await successionService?.reconcileFirstInput(context.operationId);
    await successionBoundary?.reconcileCoverage(source);
    const binding = sessions.byNative(source.providerId, source.nativeSessionId);
    const managedPrefix = !!binding && liveAgent(binding.agentId) === lease.agent && !!successionBoundary && succession!.contexts.coverageAvailable(source);
    const state = preparation ? { ...await session!.promptEditEvidence!.inspectReadiness(), managed: managedPrefix } : nativeSuccession ? await nativeSuccession.inspect(source) : { ...await session!.nativeEvidence!.inspectReadiness(), managed: succession!.contexts.coverageAvailable(source) };
    if (operationCache.hasUnsettledMutation(nativeSessionRefKey(source)) || (tpm?.hasUnsettledRecipient(source) || team?.hasUnsettledRecipient(source))) {
      throw new SuccessionPreparationRejected('succession_delivery_unresolved', 'Reconcile unsettled operations before succession.');
    }
    assertHandoffState(source);
    const boundary = lease.agent.timelineCursor?.();
    if (!boundary) throw new SuccessionPreparationRejected('succession_boundary_unavailable', 'The native history boundary is unavailable.');
    return { ...state, boundary, inFlightInputs: successionBoundary?.pending(source) ?? 0 };
  }
  async function retainVerification(prepared: import('@orchardworks/agent-remote-protocol').PreparedSuccession): Promise<RetainedSuccessionVerification> {
    const { sessions, liveAgent, ledger, succession } = ctx;
    const entries: Array<{ target: NativeSessionRef; lease: RemoteHostSessionLease; session: AgentSession; token?: AgentNativeValidityToken; isCurrent?: (token: AgentNativeValidityToken) => boolean }> = [];
    const releases: Array<() => void> = [];
    let released = false;
    const release = () => { if (released) return; released = true; for (const close of releases.reverse()) close(); };
    const assertCurrent = () => {
      if (released) throw new Error('Succession verification attachment was released.');
      for (const entry of entries) {
        const binding = sessions.byNative(entry.target.providerId, entry.target.nativeSessionId);
        if (!binding || liveAgent(binding.agentId) !== entry.lease.agent || ledger.attachmentOf(entry.lease.agent)?.session !== entry.session
          || entry.token && !entry.isCurrent?.(entry.token)) throw new Error('Native succession attachment or evidence changed.');
      }
    };
    try {
      const requireEvidence = !!prepared.preparation || !!succession?.store.progress(prepared.operationId)?.nativeCreation;
      for (const target of [prepared.from, prepared.to]) {
        const lease = await acquireNative(target); releases.push(() => lease.release());
        const session = ledger.attachmentOf(lease.agent)?.session;
        if (!session) throw new Error('Native succession attachment is unavailable.');
        const evidence = prepared.preparation ? session.promptEditEvidence : session.nativeEvidence;
        if (requireEvidence && (prepared.preparation ? !session.promptEditEvidence || session.promptEditEvidence.version !== 1 : !hasCurrentNativeEvidence(session))) throw new Error('Native succession attachment evidence is unavailable.');
        // Establish a settled baseline on this exact retained attachment before capturing its token.
        const baseline = await inspectSuccession(target, lease, prepared.preparation);
        if (!baseline.idle || !baseline.managed || baseline.pendingInputs || baseline.inFlightInputs || baseline.pendingInteractions || baseline.activeChildren) throw new Error('Native succession attachment is not settled.');
        const token = requireEvidence ? evidence!.captureValidity() : undefined;
        entries.push({ target, lease, session, token, ...(evidence ? { isCurrent: value => evidence.isCurrent(value) } : {}) });
        assertCurrent();
      }
      assertCurrent();
      return { assertCurrent, release, inspect: async target => {
        const entry = entries.find(item => nativeSessionRefKey(item.target) === nativeSessionRefKey(target));
        if (!entry) throw new Error('Succession inspection target is outside retained attachments.');
        assertCurrent();
        await authorizeSuccessionRead(target, target);
        assertCurrent();
        const result = await inspectSuccession(target, entry.lease, prepared.preparation);
        assertCurrent();
        return result;
      } };
    } catch (error) { release(); throw error; }
  }
  async function acquireNative(target: NativeSessionRef): Promise<RemoteHostSessionLease> {
    const { acquireSession, options, project, successionConfig, tracked } = ctx;
    if (target.controllerId !== successionConfig?.controllerId || options.providerEnabled?.(target.providerId) === false) throw new Error('Succession target is unavailable.');
    await authorizeSuccessionRead(target, target);
    const binding = await tracked(project(target.providerId, randomUUID(), target.nativeSessionId));
    const lease = await acquireSession(binding.agentId);
    if (!lease) throw new Error('Native succession session is unavailable.');
    return lease;
  }
  function bindProvider(value: AgentHostProviderRegistration): void {
    const { directory } = value;
    bindHandoff(directory); bindSourceReader(directory); bindSourceReferenceAncestry(directory); bindHostAccess(value);
  }
  return { ports, bindProvider, markShared, nativePrefixExtensions, workerExtensions, applyWorkerTools, authorizeSuccessionRead, inspectSuccession, retainVerification, acquireNative };
}
