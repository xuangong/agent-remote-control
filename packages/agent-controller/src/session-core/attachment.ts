import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { AgentOperationRejectedError, resolveAgentProviderBehaviour, serializeAgentEmptyCreationResult } from '@orchardworks/agent-provider-sdk';
import type { RemoteHostSessionLease, SessionWireAgent } from '@orchardworks/agent-session-runtime';

import { directoryNativeEffect } from '../directory-mutation.js';
import { NativeSessionOwnerError } from '../native-session-owner.js';
import { pendingReferenceNote } from '../session-refs.js';
import { hasHeldChild, mayReconcileIdle, mayReleaseIdle } from './idle-release.js';
import { releaseGraceMs } from './residency.js';
import { withinResumeDeadline } from './resume-deadline.js';
import { TURN_SILENCE_MS, watchTurns } from './turn-watchdog.js';
import { watchExit } from './native-exit.js';
import { withReferenceNotes } from '../session-reference-notes.js';
import type { SessionCoreContext } from './context.js';
import { boundedSourceIdentity, HostRequestError } from './requests.js';
import type { SessionBinding as Binding } from './types.js';

/**
 * Attachment: how a native session gets a runtime on this Controller, keeps it, and gives it up.
 *
 * Contract.
 * - `project` binds a native session to a proposed agent identity and attaches it once: it waits for the binding, reuses a live runtime whose
 *   creation evidence matches, otherwise opens the native session (with a child's parent held, role or worker tools, the saved creation or prefix
 *   evidence, and a takeover only inside its admitted operation), annotates it, and registers it with the Relay's runtime. A provider that returns
 *   another native identity is closed and refused; a Controller that closed meanwhile disposes what it opened. An open the CLI does not answer
 *   within its declared resume deadline fails `native_unresponsive` and frees the binding (`resume-deadline.ts`); a takeover is not timed.
 *   The turns of a CLI that declares no heartbeat are watched (`turn-watchdog.ts`): a turn silent for `TURN_SILENCE_MS` ends
 *   `native_unresponsive` and the runtime is released. A CLI that exits under the session (`native-exit.ts`: a turn failed `native_exited`, or
 *   a stream that ended unasked) has its runtime released too, so the next send or open attaches the session again; nothing is sent again.
 * - `acquireSession` holds a runtime for its caller: it holds the parent of a child first, waits for a release in progress, and releases a diverged, quiet
 *   session so it is read again before a send continues from it. The returned lease releases the runtime and its parent once.
 * - `watch` gives an idle session its release rule (`idle-release.ts`): released when it may be, journal first, then the runtime, then the directory; and
 *   reconciled first when its state is uncertain. Its release grace is the provider's (`residency.ts`), and it is kept while a page shows it
 *   (`shown-sessions.ts`).
 * - `lifecycle` reports a release, a restoration or a reconciliation to the diagnostic sink, which can never change a session's lifetime.
 *
 * The attachment owns no state of its own; the bindings and idle sessions are read through the context, and the prepared sessions belong to the attachment ledger.
 */
export function createAttachment(ctx: SessionCoreContext) {
  function lifecycle(event: 'session_idle_released' | 'session_idle_restored' | 'session_idle_reconciled', binding: Binding) {
    const { options } = ctx;
    try { options.onSessionLifecycleDiagnostic?.({ event, agentId: binding.agentId, providerId: binding.providerId }); }
    catch { /* Diagnostics cannot change session lifetime. */ }
  }
  function watch(binding: Binding) {
    const { admission, sessions, idle, liveAgent, ledger, providers, shown, options } = ctx;
    // The release grace follows what the provider declares of its CLI (`residency.ts`, R4); a configured grace replaces it for every provider.
    const graceMs = options.idleGraceMs ?? releaseGraceMs(resolveAgentProviderBehaviour(providers.require(binding.providerId).adapter.descriptor));
    const childHeld = () => hasHeldChild(sessions.all(), binding, child => !!liveAgent(child.agentId) || idle.hasDemand(child.agentId));
    idle.watch(binding.agentId, () => mayReleaseIdle({
      closed: admission.closed, uncertain: ledger.isUncertain(binding.agentId), pending: sessions.isPending(binding.providerId, binding.nativeSessionId),
      directoryCanRelease: !!providers.require(binding.providerId).directory.canReleaseSession?.(binding.nativeSessionId), runtimeCanReleaseIdle: !!liveAgent(binding.agentId)?.canReleaseIdle(),
      childHeld: childHeld(),
    }), async () => {
      await releaseRuntime(binding);
      lifecycle('session_idle_released', binding);
    }, async isCurrent => {
      const source = providers.require(binding.providerId).directory;
      const agent = liveAgent(binding.agentId);
      if (!source.reconcileIdleSession || !mayReconcileIdle({ directoryCanReconcile: true, runtimeCanReleaseIdle: !!agent?.canReleaseIdle(), childHeld: childHeld() }) || !agent) return false;
      // Discovery can resolve a child before the complete family check finishes.
      // Keep that partial progress protected if the check fails or becomes stale.
      ledger.markUncertain(binding.agentId);
      if (!await source.reconcileIdleSession(binding.nativeSessionId) || !isCurrent()
        || liveAgent(binding.agentId) !== agent || !agent.canReleaseIdle()
        || !source.canReleaseSession?.(binding.nativeSessionId)) return false;
      // Native quiescence permits detachment, but does not settle or replay an unknown operation.
      ledger.clearUncertain(binding.agentId);
      lifecycle('session_idle_reconciled', binding);
      return true;
    }, graceMs);
    shown.apply(binding);
  }
  /** Releases a session's runtime in the order of C20: what its journal holds is published, then the runtime closes, then the directory's hold. */
  async function releaseRuntime(binding: Binding): Promise<void> {
    const { providers, relay, terminalRefresh } = ctx;
    await terminalRefresh.releaseJournal(binding);
    await relay.closeAgent(binding.agentId);
    await providers.require(binding.providerId).directory.sessionReleased?.(binding.nativeSessionId);
  }
  async function releaseIfDiverged(binding: Binding): Promise<void> {
    const { liveAgent, providers } = ctx;
    const directory = providers.require(binding.providerId).directory;
    if (!directory.checkDivergence || binding.parentNativeSessionId || !liveAgent(binding.agentId) || !await directory.checkDivergence(binding.nativeSessionId)) return;
    const agent = liveAgent(binding.agentId);
    if (!agent?.canReleaseIdle()) return;
    await releaseRuntime(binding);
  }
  async function acquireSession(agentId: string): Promise<RemoteHostSessionLease | undefined> {
    const { admission, sessions, idle, liveAgent, tracked } = ctx;
    const binding = sessions.byAgent(agentId);
    if (admission.closed || !binding) return undefined;
    const release = idle.retain(agentId);
    let parent: RemoteHostSessionLease | undefined;
    try {
      if (binding.parentNativeSessionId) {
        const parentBinding = sessions.byNative(binding.providerId, binding.parentNativeSessionId);
        if (parentBinding) {
          parent = await acquireSession(parentBinding.agentId);
          if (!parent) throw new Error('Native parent session is unavailable.');
        }
      }
      await idle.wait(agentId);
      // A send must not continue from a conversation a terminal has moved on: a diverged, quiet session is released and read again first.
      await releaseIfDiverged(binding);
      await tracked(project(binding.providerId, agentId, binding.nativeSessionId, binding.parentNativeSessionId));
      const agent = admission.closed ? undefined : liveAgent(agentId);
      if (!agent) { release(); parent?.release(); return undefined; }
      let released = false;
      return { agent, release() { if (released) return; released = true; release(); parent?.release(); } };
    } catch (error) { release(); parent?.release(); throw error; }
  }
  async function project(providerId: string, proposedAgentId: string, nativeSessionId: string, parentNativeSessionId?: string, takeOver?: string, takeoverAdmitted = false, takeoverScope = 'host:takeover', qualifiedResult = false): Promise<Binding> {
    const { admission, sessions, directoryOperation, genericSuccessionSource, nativePrefixExtensions, workerExtensions, idle, journals, liveAgent, ledger, nativeRef, originalCreation, originalNativePrefix, providers, relay, roles, sessionRefs, succession, successionBoundary, successionReady, tpm } = ctx;
    await successionReady;
    const nativeCreation = originalCreation(nativeRef({ providerId, nativeSessionId }));
    const creationIdentity = nativeCreation ? serializeAgentEmptyCreationResult(nativeCreation) : undefined;
    const nativePrefix = originalNativePrefix(nativeRef({ providerId, nativeSessionId }));
    const prefixIdentity = nativePrefix ? JSON.stringify(nativePrefix.handle) : undefined;
    const assertAttachment = (agent: SessionWireAgent | undefined) => {
      if (prefixIdentity && (!agent || ledger.attachmentOf(agent)?.nativePrefix !== prefixIdentity)) throw new Error('Existing Host attachment does not match the original native prefix handle.');
      if (creationIdentity && (!agent || ledger.attachmentOf(agent)?.nativeCreation !== creationIdentity)) throw new Error('Existing Host attachment does not match the original native creation evidence.');
    };
    const existing = sessions.byNative(providerId, nativeSessionId);
    if (takeOver && !takeoverAdmitted) {
      const target = nativeRef({ providerId, nativeSessionId });
      return directoryOperation(takeoverScope, JSON.stringify([proposedAgentId, takeOver]), 'native_owner_takeover', [target], { takeOver },
        () => project(providerId, proposedAgentId, nativeSessionId, parentNativeSessionId, takeOver, true, takeoverScope));
    }
    const bound = await sessions.bind({ providerId, agentId: proposedAgentId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) }, {
      ...(qualifiedResult ? { validateResult(binding: Binding) {
        if (![binding.agentId, binding.nativeSessionId].every(boundedSourceIdentity)) throw new Error('Qualified source projection selected an unbounded canonical identity after native creation; the full Host witness remains available for reconciliation.');
      } } : {}),
      discard: binding => relay.closeAgent(binding.agentId),
      attach: async binding => {
      proposedAgentId = binding.agentId;
      if (existing) {
        await idle.wait(proposedAgentId);
        const agent = liveAgent(proposedAgentId);
        if (agent) { assertAttachment(agent); idle.touch(proposedAgentId); return; }
      }
      const source = providers.require(providerId).directory;
      let parent: RemoteHostSessionLease | undefined;
      try {
        if (parentNativeSessionId) {
          const parentBinding = sessions.byNative(providerId, parentNativeSessionId);
          if (parentBinding?.agentId === proposedAgentId) throw new Error('Native parent binding is invalid.');
          if (parentBinding) {
            parent = await acquireSession(parentBinding.agentId);
            if (!parent) throw new Error('Native parent session is unavailable.');
          }
        }
        const attached = nativeRef({ providerId, nativeSessionId });
        // A generic successor holds the role of its source, so every attachment of it gets the same extensions.
        const extensions = nativePrefix ? await nativePrefixExtensions(nativePrefix.source, () => nativeSessionId)
          : await roles.extensions(genericSuccessionSource(attached) ?? attached, () => attached) ?? workerExtensions(providerId, attached, () => attached);
        ledger.recordWorkerTools(proposedAgentId, !!extensions?.toolNamespaces?.some(namespace => namespace.name === 'agent_remote' && !namespace.deferred));
        const open = () => source.open(nativeSessionId, { ...(takeOver ? { takeOver } : {}), ...(extensions ? { extensions } : {}), ...(nativePrefix ? { nativePrefix: nativePrefix.handle } : {}), ...(nativeCreation ? { nativeCreation, resumeHandle: succession?.contexts.forTarget(nativeRef({ providerId, nativeSessionId }))?.resumeHandle, resumeOptions: { initializeEmpty: succession?.contexts.canInitializeEmpty(nativeRef({ providerId, nativeSessionId })) === true } } : {}) });
        // A resume the CLI does not answer within its declared deadline frees the binding instead of holding it (gap 4).
        const behaviour = resolveAgentProviderBehaviour(providers.require(providerId).adapter.descriptor);
        const resumeDeadlineMs = behaviour.resume.deadlineMs;
        const nativeSession = parentNativeSessionId === undefined ? await (takeOver
          ? directoryNativeEffect(successionBoundary?.currentEntry(), successionBoundary?.currentEntry()?.targets ?? [], async () => {
            try { return await open(); } catch (error) {
              if (error instanceof NativeSessionOwnerError && ['native_owner_changed', 'native_session_owned', 'succession_admission_closed'].includes(error.code)) throw new AgentOperationRejectedError(error.code, error.message);
              throw error;
            }
          }) : withinResumeDeadline(open(), resumeDeadlineMs))
          : source.openChild ? await withinResumeDeadline(source.openChild(parentNativeSessionId, nativeSessionId), resumeDeadlineMs)
          : (() => { throw new HostRequestError(400, 'child_attachment_unavailable', 'This provider does not support native child attachment.'); })();
        // A CLI that exits under the session leaves its runtime unusable: it is released, and the next send or open attaches it again.
        const exiting = watchExit(nativeSession, { exited: () => { void releaseRuntime(binding).catch(() => undefined); } });
        // A turn of a CLI that declares no heartbeat is watched: a silent one ends native_unresponsive and the runtime is released (gap 4).
        const watched = behaviour.turn?.heartbeatMs === undefined
          ? watchTurns(exiting, { silenceMs: TURN_SILENCE_MS, unresponsive: () => { void releaseRuntime(binding).catch(() => undefined); } }) : exiting;
        const noted = sessionRefs && parentNativeSessionId === undefined ? withReferenceNotes(watched, {
          pending: () => pendingReferenceNote({ providerId, nativeSessionId }, sessionRefs),
          delivered: revision => sessionRefs.store.markDelivered({ providerId, nativeSessionId }, revision),
        }) : watched;
        const annotated = tpm ? await tpm.annotateSession(providerId, nativeSessionId, noted) : noted;
        const session = successionBoundary ? successionBoundary.wrap(nativeRef(binding), annotated) : annotated;
        if (admission.closed) {
          await session.dispose().catch(() => undefined);
          throw new HostRequestError(503, 'host_closed', 'Agent Host is closed.');
        }
        ledger.stageProjection(proposedAgentId, session);
        const response = await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: {
          requestId: `host:${proposedAgentId}`, operationId: randomUUID(), agentId: proposedAgentId, providerId, config: { sessionId: proposedAgentId },
        } }).catch(async (error: unknown) => {
          if (ledger.discardProjection(proposedAgentId, session)) await session.dispose().catch(() => undefined);
          throw error;
        });
        if (response.payload.sessionId !== nativeSessionId) { await relay.closeAgent(proposedAgentId); throw new Error('Provider returned a different native session identity.'); }
        ledger.recordAttachment(relay.requireAgent(proposedAgentId), { session: nativeSession, ...(creationIdentity ? { nativeCreation: creationIdentity } : {}), ...(prefixIdentity ? { nativePrefix: prefixIdentity } : {}) });
        for (const relative of sessions.family(providerId, nativeSessionId)) relay.sessionControls?.setNativeOwner(relative.agentId, undefined);
        watch(binding);
        journals.attach({ agentId: proposedAgentId, providerId, nativeSessionId, source: relay.requireAgent(proposedAgentId) });
        if (existing) lifecycle('session_idle_restored', binding);
      } catch (error) { ledger.discardProjection(proposedAgentId); throw error; }
      finally { parent?.release(); }
      },
    });
    assertAttachment(liveAgent(bound.agentId));
    return bound;
  }
  return { project, acquireSession };
}
