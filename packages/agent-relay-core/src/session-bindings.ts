import { sessionIdentityMessage } from './session-identity.js';
import { isCreationSource, type CreationSource, isNativeSessionRef, nativeSessionRefKey, type NativeRefusal } from '@orchardworks/agent-remote-protocol';
import { isDeepStrictEqual } from 'node:util';
import { type BrokerAssociationState } from './succession-associations.js';
import { createHash } from 'node:crypto';
import { sessionAttachFailure } from '@orchardworks/agent-remote-protocol/model';
import { HostSharing, SharingError } from './host-sharing.js';
import { required, requiredHostIdentity, creationFingerprintSettings, optionalSettings, sameBinding } from './request-input.js';
import { BrokerError, type Binding, type Host, type RemoteHostBrokerState, type RpcResponse, type SharedCreation } from './broker-types.js';
import { type BrokerState } from './broker-state.js';
import { type Access } from './access.js';
import { type Succession } from './succession-service.js';
import { type RelayIds } from './relay-ids.js';
import { type BrokerScheduler } from './transport.js';

/**
 * Session bindings: which public session id stands for which native session on which Host, how a session is attached or created
 * through the Host's Controller, and how a binding is re-attached when the Host reconnects.
 *
 * Contract:
 * - A binding is `[hostId, providerId, nativeSessionId]` under one public `agentId`, saved in `BrokerState.bindings`. It is created
 *   only after the Controller confirmed the native identity, and in one commit with the creation record, the sharing reservation
 *   and the source admission that belong to it; nothing is saved for a request the Controller refused or answered with another
 *   identity (409 `native_identity_conflict`).
 * - Requests are idempotent: the same attach in flight joins the one that runs; the same creation operation id with the same
 *   settings answers the same binding, with other settings it is refused (409 `request_conflict`). Both ledgers hold at most 4096.
 * - A binding is attached to a connection once per Host `generation`: `recoverBinding` asks the Controller to attach it again when the
 *   Host reconnected, and refuses (409) when the Controller answers another identity or a parent binding is missing.
 * - A caller's deadline does not cancel a creation: `waitForCreation` answers 504 and the creation continues, so a retry finds it.
 * - A subject other than the owner may attach and create only on a shared Host, only its own sessions, within its session quota.
 * - Session reads go to the Controller under the runtime's own identity and come back under the public one.
 * - Native refusal (O48): when the CLI refuses the Controller as a client of a session for its own reason (`session_in_use` with a
 *   reason, such as another process writing it), the refusal is kept for the binding and told (`nativeRefusalChanged`); an attach or
 *   a recovery that succeeds clears it. An attach of a bound session that the Relay can read without the Controller (its journal) is
 *   answered with the binding despite such a refusal, so the page reads it, read-only, and is told why.
 *
 * Owns the runtime ledgers (the runtime identity of a binding, in-flight attachments and creations, reserved slots). The saved
 * records are `BrokerState`'s. Ports: `rpc` of the host session, `Access`, the succession guards, `RelayIds`, the scheduler.
 */
export interface SessionBindingPorts {
  brokerState: BrokerState;
  access: Access;
  succession: Succession;
  rpc(host: Host, method: 'GET' | 'POST', path: string, sessionId?: string, body?: string, diagnosticRequest?: boolean): Promise<RpcResponse>;
  ids: RelayIds;
  now(): number;
  scheduler: BrokerScheduler;
  /** Succession enrollment is on, so creations from a source are admitted through the associations. */
  enrollmentEnabled: boolean;
  /** The saved state already holds associations. */
  savedAssociations: RemoteHostBrokerState['associations'];
  ownerSubject: string | undefined;
  rpcTimeoutMs: number | undefined;
  /** Whether a page can read the session without its Controller: the Relay serves it from its journal. */
  readableWithoutController?(binding: Binding): Promise<boolean>;
  /** Told when the CLI starts or stops refusing the Controller as a client of a bound session. */
  nativeRefusalChanged?(binding: Binding, refusal: NativeRefusal | undefined): void;
}
export type SessionBindings = ReturnType<typeof createSessionBindings>;

export function createSessionBindings(ports: SessionBindingPorts) {
  const { brokerState, access, succession, rpc, ids, now, scheduler, enrollmentEnabled, savedAssociations, ownerSubject, rpcTimeoutMs, readableWithoutController, nativeRefusalChanged } = ports;
  const { owner, requireAccess, sessionAllowed } = access;
  const { assertCapacity: assertAssociationCapacity, assertCreationOpen: assertAssociationCreationOpen, source: associationSource, rpc: associationRpc } = succession;
  const setTimeout = scheduler.setTimeout.bind(scheduler);
  const clearTimeout = scheduler.clearTimeout.bind(scheduler);
  /** The identity the Controller's runtime uses for a binding on this connection, when it differs from the public id. */
  const runtimeBindings = new Map<string, { generation: number; agentId: string }>();
  const pendingBindingSlots = new Map<string, { admissionId?: string; nativeKey?: string; creationKey?: string }>();
  const attached = new Map<string, Promise<Binding>>();
  const attachmentRequests = new Map<string, Promise<Binding>>();
  const creations = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  const sharedCreates = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  /** The refusal of the CLI for each binding it refuses now, by public agent id. */
  const nativeRefusals = new Map<string, NativeRefusal>();
  function refused(binding: Binding, refusal: NativeRefusal | undefined): void {
    const previous = nativeRefusals.get(binding.agentId);
    if (previous?.reason === refusal?.reason && previous?.retryAfterMs === refusal?.retryAfterMs) return;
    if (refusal) nativeRefusals.set(binding.agentId, refusal); else nativeRefusals.delete(binding.agentId);
    try { nativeRefusalChanged?.(binding, refusal); } catch { /* Telling the streams never changes the binding. */ }
  }
  for (const binding of brokerState.bindings.values()) attached.set(JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]), Promise.resolve(binding));
  for (const [key, value] of brokerState.completedCreations) creations.set(key, { fingerprint: value.fingerprint, result: Promise.resolve(brokerState.bindings.get(value.agentId)!) });
  function runtimeAgentId(host: Host, binding: Binding): string {
    const runtime = runtimeBindings.get(binding.agentId);
    return runtime?.generation === host.generation ? runtime.agentId : binding.agentId;
  }
  function assertRuntimeIdentity(host: Host, binding: Pick<Binding, 'agentId' | 'providerId' | 'nativeSessionId'>, agentId: string): void {
    const occupied = brokerState.bindings.get(agentId);
    if (occupied && !sameBinding(occupied, host.id, binding.providerId, binding.nativeSessionId)) {
      throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host session identity belongs to another binding.');
    }
    for (const [publicId, runtime] of runtimeBindings) {
      const other = brokerState.bindings.get(publicId);
      if (other?.hostId === host.id && runtime.generation === host.generation && runtime.agentId === agentId
        && !sameBinding(other, host.id, binding.providerId, binding.nativeSessionId)) {
        throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host runtime identity belongs to another session.');
      }
    }
    const previous = runtimeBindings.get(binding.agentId);
    if (previous?.generation === host.generation && previous.agentId !== agentId) {
      throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host changed session identity within one connection.');
    }
  }
  async function sessionRead(host: Host, binding: Binding, path: string): Promise<RpcResponse> {
    const agentId = runtimeAgentId(host, binding);
    const result = await rpc(host, 'GET', path.replace(/^\/v1\/sessions\/[^/]+\//, `/v1/sessions/${encodeURIComponent(agentId)}/`), agentId);
    if (result.status >= 300) return result;
    try { return { ...result, body: sessionIdentityMessage(result.body, agentId, binding.agentId, 'server') }; }
    catch { throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned an invalid session response.'); }
  }
  async function recoverBinding(host: Host, binding: Binding, again = false): Promise<void> {
    brokerState.assertHostCurrent(host);
    if (brokerState.bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
    if (host.ready && !host.control) throw new BrokerError(409, 'controller_upgrade_required', 'Update required: this Host\'s Controller must be updated before it can send or open sessions.');
    if (binding.generation === host.generation && !again) return;
    if (!binding.recovery) {
      const generation = host.generation;
      binding.recovery = (async () => {
        if (binding.parentNativeSessionId) {
          const parent = brokerState.nativeBindings.get(JSON.stringify([host.id, binding.providerId, binding.parentNativeSessionId]));
          if (!parent) throw new BrokerError(409, 'parent_binding_missing', 'The native parent session must be attached before its child.');
          await recoverBinding(host, parent);
        }
        const path = binding.parentNativeSessionId ? '/remote/child/attach' : '/remote/attach';
        const body = host.legacyDsh ? { nativeSessionId: binding.nativeSessionId } : {
          providerId: binding.providerId, nativeSessionId: binding.nativeSessionId,
          ...(binding.parentNativeSessionId ? { parentNativeSessionId: binding.parentNativeSessionId } : {}),
          ...(binding.creatorSubject !== undefined && !owner(binding.creatorSubject) ? { shared: true } : {}),
        };
        const result = await rpc(host, 'POST', path, binding.agentId, JSON.stringify(body));
        brokerState.assertHostCurrent(host, generation);
        if (brokerState.bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
        if (result.status >= 300) {
          const failure = sessionAttachFailure(result.body);
          if (failure.nativeRefusal) refused(binding, failure.nativeRefusal);
          throw new BrokerError(result.status, failure.code, failure.error, false, result.requestId, failure.nativeOwner, failure.nativeRefusal);
        }
        if (host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session was reattaching.');
        let agentId = binding.agentId;
        if (!host.legacyDsh) {
          let returned: Record<string, unknown>;
          try { returned = JSON.parse(result.body); } catch { throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned invalid session identity.'); }
          if (returned.nativeSessionId !== binding.nativeSessionId) {
            throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host returned a different binding during recovery.');
          }
          agentId = requiredHostIdentity(returned.agentId, 'agentId');
        }
        await brokerState.commit(() => {
          brokerState.assertHostCurrent(host, generation);
          if (brokerState.bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
          assertRuntimeIdentity(host, binding, agentId);
          runtimeBindings.set(binding.agentId, { generation, agentId });
          binding.generation = generation;
          return { value: undefined, unchanged: true, publish() {} };
        });
        refused(binding, undefined);
      })();
      void binding.recovery.finally(() => { binding.recovery = undefined; }).catch(() => undefined);
    }
    await binding.recovery;
  }
  function assertSessionSlots() {
    const durable = new Set(brokerState.associations.admissions.map(row => row.id));
    let bindingClaims = durable.size, creationClaims = durable.size;
    for (const claim of pendingBindingSlots.values()) {
      if (claim.admissionId && durable.has(claim.admissionId)) continue;
      if (!claim.nativeKey || !brokerState.nativeBindings.has(claim.nativeKey)) bindingClaims++;
      if (claim.creationKey && !brokerState.completedCreations.has(claim.creationKey)) creationClaims++;
    }
    if (brokerState.bindings.size + bindingClaims > 4096 || brokerState.completedCreations.size + creationClaims > 4096) throw new BrokerError(429, 'capacity_exceeded', 'Session completion capacity is reserved by pending operations.', true);
    assertAssociationCapacity(brokerState.associations);
  }
  async function mutate(host: Host, action: string, body: Record<string, unknown>, creatorSubject?: string, shared?: SharedCreation): Promise<Binding> {
    brokerState.assertHostCurrent(host); const admittedGeneration = host.generation;
    const callerSubject = creatorSubject ?? ownerSubject;
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (!host.providers.some((provider) => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && action === 'create' && ['cwd', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId'].some((key) => body[key] !== undefined)) {
      throw new BrokerError(400, 'unsupported_configuration', 'This Host uses native model settings and a registered workspace.');
    }
    if (host.legacyDsh && action === 'child/attach') throw new BrokerError(400, 'unsupported_operation', 'This Host does not support native child attachment.');
    const attaching = action !== 'create';
    const nativeSessionId = attaching ? required(body.nativeSessionId, 'nativeSessionId') : ids.uuid();
    const parentNativeSessionId = action === 'child/attach' ? required(body.parentNativeSessionId, 'parentNativeSessionId') : undefined;
    if (parentNativeSessionId) creatorSubject ??= brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, parentNativeSessionId]))?.creatorSubject;
    const key = JSON.stringify([host.id, providerId, action === 'create' ? required(body.operationId, 'operationId') : nativeSessionId]);
    const source = action === 'create' && typeof body.sourceNativeSessionId === 'string' ? associationSource(host, providerId, body.sourceNativeSessionId) : undefined;
    const sourceBindingKey = action === 'create' && isCreationSource(body.creationSource) ? JSON.stringify([host.id, body.creationSource.providerId, body.creationSource.nativeSessionId]) : undefined;
    const sourceBinding = sourceBindingKey ? brokerState.nativeBindings.get(sourceBindingKey) : undefined;
    const assertMutationAccess = () => {
      brokerState.assertHostCurrent(host, admittedGeneration); requireAccess(host.id, callerSubject);
      if (action === 'create' && brokerState.associations.freezes.some(row => row.hostId === host.id && row.receipt.request.operationId === body.operationId && row.receipt.request.preparation)) throw new BrokerError(409, 'succession_identity_conflict', 'Operation identity belongs to native prefix succession.');
      if (sourceBindingKey && (!sourceBinding || brokerState.nativeBindings.get(sourceBindingKey) !== sourceBinding || !sessionAllowed(sourceBinding, callerSubject))) throw new SharingError(403, 'session_forbidden', 'Source session access changed.');
    };
    const admissionId = createHash('sha256').update(key).digest('hex');
    const admissionFingerprint = createHash('sha256').update(JSON.stringify([providerId, Object.entries(body).filter(([name]) => name !== 'creationSource').sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
    const trackAssociation = !!source && (!!enrollmentEnabled || !!savedAssociations);
    const fingerprint = JSON.stringify({ providerId, cwd: body.cwd ?? null, workspaceId: body.workspaceId ?? null,
      model: body.model ?? null, reasoningEffort: body.reasoningEffort ?? null, planning: body.planning ?? null, ...creationFingerprintSettings(body, ['conversationKind', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId']) });
    const exactAdmission = (state: BrokerAssociationState) => {
      const admission = state.admissions.find(row => row.id === admissionId);
      if (admission && (admission.fingerprint !== admissionFingerprint || !isDeepStrictEqual(admission.source, source))) throw new BrokerError(409, 'association_outcome_unknown', 'Source creation identity changed.');
      return admission;
    };
    const exactSharedReceipt = (state: RemoteHostBrokerState) => {
      const receipt = state.sharing?.reservations.find(row => row.key === shared!.reservation.key);
      const { fresh: _fresh, agentId: _agent, ...expected } = shared!.reservation;
      const { agentId: _actual, ...actual } = receipt ?? {};
      if (!receipt || !isDeepStrictEqual(actual, expected)) throw new BrokerError(409, 'creation_outcome_unknown', 'The complete shared creation reservation requires reconciliation.');
      return receipt;
    };
    let safeHostRejection = false;
    const operation = () => {
      const existingBinding = attaching ? brokerState.nativeBindings.get(key) : undefined;
      if (existingBinding && existingBinding.parentNativeSessionId !== parentNativeSessionId) {
        throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
      }
      const slot = JSON.stringify([attaching ? 'attach' : 'create', key]);
      const claim = { ...(trackAssociation ? { admissionId } : {}), ...(attaching ? { nativeKey: key } : { creationKey: key }) };
      return (async () => {
        await brokerState.commit(() => {
          assertMutationAccess();
          if (pendingBindingSlots.has(slot)) throw new BrokerError(409, 'request_conflict', 'This session has a different in-flight request.');
          pendingBindingSlots.set(slot, claim);
          try { assertSessionSlots(); } catch (error) { pendingBindingSlots.delete(slot); throw error; }
          return { value: undefined, unchanged: true, publish() {} };
        });
        const proposedAgentId = existingBinding?.agentId ?? ids.uuid();
        const generation = host.generation;
        // A share recipient's session is marked, so the Controller hides it from the owner's session commands.
        const recipient = creatorSubject !== undefined && !owner(creatorSubject) ? { shared: true } : {};
        const request = host.legacyDsh
          ? { nativeSessionId, ...(body.workspaceId === undefined ? {} : { workspaceId: required(body.workspaceId, 'workspaceId') }) }
          : action === 'create'
            ? { providerId, operationId: required(body.operationId, 'operationId'),
                ...optionalSettings(body, ['cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId']), ...recipient }
            : { providerId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}), ...(body.takeOver === undefined ? {} : {takeOver: required(body.takeOver, 'takeOver')}), ...recipient };
        if (source) assertAssociationCreationOpen(source);
        let recoverSource = false;
        if (trackAssociation || shared) await brokerState.commit(draft => {
          assertMutationAccess();
          let nextSharing: HostSharing | undefined;
          if (shared) {
            if (trackAssociation && exactAdmission(brokerState.associations) && shared.reservation.fresh) throw new BrokerError(409, 'creation_outcome_unknown', 'The saved source admission is missing its shared quota receipt.');
            nextSharing = new HostSharing(draft.sharing, () => {});
            const reservation = nextSharing.reserve(host.id, shared.subject, providerId, shared.operationId, shared.fingerprint);
            draft.sharing = nextSharing.snapshot(); exactSharedReceipt(draft);
            if (reservation.agentId !== undefined) throw new BrokerError(409, 'creation_outcome_unknown', 'A completed shared reservation requires its exact creation result.');
          }
          let next = brokerState.associations;
          if (trackAssociation) {
            assertAssociationCreationOpen(source!);
            const previous = exactAdmission(brokerState.associations);
            if (previous) recoverSource = true;
            else {
              if (shared && !shared.reservation.fresh) throw new BrokerError(409, 'creation_outcome_unknown', 'A previous shared creation has no source admission; reconcile its exact outcome.');
              next = structuredClone(brokerState.associations);
              next.admissions.push({ id: admissionId, fingerprint: admissionFingerprint, source: source! });
              if (next.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
              next.revision++;
              assertAssociationCapacity(next);
              draft.associations = next;
            }
          }
          const unchanged = isDeepStrictEqual(draft, brokerState.snapshot());
          return { value: undefined, ...(unchanged ? { unchanged: true as const } : {}), publish() { brokerState.associations = next; if (nextSharing) brokerState.sharing = nextSharing; } };
        }, !brokerState.associations.admissions.some(row => row.id === admissionId) && (!shared || shared.reservation.fresh));
        await brokerState.commit(() => {
          assertMutationAccess(); assertSessionSlots();
          if (trackAssociation && !exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Source dispatch requires its durable admission.');
          return { value: undefined, unchanged: true, publish() {} };
        });
        let result: RpcResponse;
        let recoveredReaderId: string | undefined;
        assertMutationAccess();
        if (recoverSource) {
          const recovered = await associationRpc(host, {action:'source-result',providerId,operationId:body.operationId,sourceNativeSessionId:body.sourceNativeSessionId,parameters:optionalSettings(body,['sourceNativeSessionId','cwd','workspaceId','model','reasoningEffort','planning'])});
          if (!isNativeSessionRef(recovered.source) || !isNativeSessionRef(recovered.reader) || nativeSessionRefKey(recovered.source) !== nativeSessionRefKey(source!) || recovered.reader.controllerId !== host.installationId || recovered.reader.providerId !== providerId || recovered.operationId !== body.operationId) throw new BrokerError(409,'association_outcome_unknown','Source creation result evidence does not match.');
          recoveredReaderId = recovered.reader.nativeSessionId;
          assertMutationAccess();
          result = await rpc(host,'POST','/remote/attach',proposedAgentId,JSON.stringify({providerId,nativeSessionId:recoveredReaderId}));
        } else result = await rpc(host, 'POST', `/remote/${action}`, proposedAgentId, JSON.stringify(request));
        brokerState.assertHostCurrent(host, generation);
        if (result.status >= 300) {
          if (attaching) {
            const failure = sessionAttachFailure(result.body);
            throw new BrokerError(result.status, failure.code, failure.error, false, result.requestId, failure.nativeOwner, failure.nativeRefusal);
          }
          let detail: Record<string, unknown> = {};
          try { detail = JSON.parse(result.body); } catch { /* Preserve the status if the host did not return JSON. */ }
          safeHostRejection = !recoverSource && result.status < 500 && [
            'invalid_request', 'invalid_provider', 'unsupported_configuration', 'invalid_operation_id',
            'operation_capacity_exceeded', 'operation_result_too_large', 'operation_rejected', 'succession_admission_closed',
          ].includes(String(detail.code));
          throw new BrokerError(result.status, typeof detail.code === 'string' ? detail.code : 'host_rejected', typeof detail.error === 'string' ? detail.error : 'The Remote Host rejected the operation.', safeHostRejection, result.requestId);
        }
        let returned: Record<string, unknown> = {};
        try { returned = JSON.parse(result.body); } catch {
          if (!host.legacyDsh) throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned invalid session identity.');
        }
        if (host.legacyDsh && returned.nativeSessionId !== undefined && returned.nativeSessionId !== nativeSessionId) {
          throw new BrokerError(409, 'native_identity_conflict', 'The Remote Host returned a different native session identity.');
        }
        const actualNativeSessionId = host.legacyDsh ? nativeSessionId : requiredHostIdentity(returned.nativeSessionId, 'nativeSessionId');
        const returnedAgentId = host.legacyDsh ? proposedAgentId : requiredHostIdentity(returned.agentId, 'agentId');
        if (recoveredReaderId && actualNativeSessionId !== recoveredReaderId) throw new BrokerError(409, 'native_identity_conflict', 'The recovered session attachment returned a different native identity.');
        if (attaching && actualNativeSessionId !== nativeSessionId) throw new BrokerError(409, 'native_identity_conflict', 'The Remote Host returned a different native session identity.');
        if (body.conversationKind && actualNativeSessionId === body.sourceNativeSessionId) throw new BrokerError(409, 'native_identity_conflict', 'The new conversation cannot be its own source.');
        const nativeKey = JSON.stringify([host.id, providerId, actualNativeSessionId]);
        return brokerState.commit(draft => {
          if (source) assertAssociationCreationOpen(source);
          if (brokerState.hosts.get(host.id) !== host || host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session operation was completing.');
          const byNative = brokerState.nativeBindings.get(nativeKey);
          const agentId = byNative?.agentId ?? returnedAgentId;
          const byAgent = brokerState.bindings.get(agentId);
          assertRuntimeIdentity(host, { agentId, providerId, nativeSessionId: actualNativeSessionId }, returnedAgentId);
          if (!byAgent && !byNative && brokerState.bindings.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local session binding registry is full.');
          const binding = byAgent ?? byNative ?? { hostId: host.id, providerId, nativeSessionId: actualNativeSessionId, agentId,
            generation: host.generation, ...(creatorSubject ? { creatorSubject } : {}), ...(parentNativeSessionId ? { parentNativeSessionId } : {}),
            ...(action === 'create' && body.conversationKind ? { sourceRelation: { id: String(body.conversationId), kind: body.conversationKind as 'side' | 'ask', sourceNativeSessionId: String(body.sourceNativeSessionId), nativeSourceRef: associationSource(host, providerId, String(body.sourceNativeSessionId)), createdAt: new Date(now()).toISOString() } } : {}) };
          if (binding.parentNativeSessionId !== parentNativeSessionId) throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
          if (creatorSubject && binding.creatorSubject !== creatorSubject) throw new BrokerError(409, 'session_binding_conflict', 'The native session belongs to another user.');
          if (action === 'create' && body.conversationKind) {
            const relation = binding.sourceRelation;
            if (!relation || relation.id !== body.conversationId || relation.kind !== body.conversationKind || relation.sourceNativeSessionId !== body.sourceNativeSessionId
              || relation.nativeSourceRef && nativeSessionRefKey(relation.nativeSourceRef) !== nativeSessionRefKey(source!)) throw new BrokerError(409, 'session_binding_conflict', 'The returned session has a different source relationship.');
          }
          const { generation: _generation, recovery: _recovery, ...saved } = binding;
          const savedIndex = draft.bindings.findIndex(value => value.agentId === agentId);
          if (savedIndex < 0) draft.bindings.push(saved); else draft.bindings[savedIndex] = saved;
          let nextSharing: HostSharing | undefined;
          let creation: { fingerprint: string; agentId: string } | undefined;
          if (!attaching) {
            const previous = draft.creations.find(([id]) => id === key);
            if (previous && (previous[1].fingerprint !== fingerprint || previous[1].agentId !== agentId)) throw new BrokerError(409, 'request_conflict', 'The saved creation result changed.');
            creation = previous?.[1] ?? { fingerprint, agentId };
            if (!previous) draft.creations.push([key, creation]);
            if (shared) {
              const receipt = exactSharedReceipt(draft);
              if (receipt.agentId !== undefined && receipt.agentId !== agentId) throw new BrokerError(409, 'creation_outcome_unknown', 'Shared creation result changed.');
              nextSharing = new HostSharing(draft.sharing, () => {}); nextSharing.complete(receipt.key, agentId); draft.sharing = nextSharing.snapshot();
            }
            if (trackAssociation) {
              if (!exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Source completion requires its exact durable admission.');
              draft.associations = structuredClone(brokerState.associations);
              draft.associations.admissions = draft.associations.admissions.filter(row => row.id !== admissionId);
              if (draft.associations.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
              draft.associations.revision++;
              assertAssociationCapacity(draft.associations);
            }
          }
          const unchanged = isDeepStrictEqual(draft, brokerState.snapshot());
          if (unchanged) {
            binding.generation = generation;
            runtimeBindings.set(agentId, { generation, agentId: returnedAgentId });
            attached.set(nativeKey, Promise.resolve(binding));
          }
          return { value: binding, ...(unchanged ? { unchanged: true as const } : {}), publish() {
            brokerState.assertHostCurrent(host, generation);
            if (draft.associations) brokerState.associations = draft.associations;
            if (creation) brokerState.completedCreations.set(key, creation);
            if (nextSharing) brokerState.sharing = nextSharing;
            binding.generation = host.generation;
            runtimeBindings.set(agentId, { generation, agentId: returnedAgentId });
            brokerState.bindings.set(agentId, binding); brokerState.nativeBindings.set(nativeKey, binding); pendingBindingSlots.delete(slot);
            attached.set(nativeKey, Promise.resolve(binding));
          } };
        });
      })().finally(() => { if (pendingBindingSlots.get(slot) === claim) pendingBindingSlots.delete(slot); });
    };
    if (attaching) {
      const requestKey = JSON.stringify([key, body.takeOver ?? null]);
      let result = attachmentRequests.get(requestKey);
      if (!result) {
        result = operation(); attachmentRequests.set(requestKey, result);
        void result.finally(() => { if (attachmentRequests.get(requestKey) === result) attachmentRequests.delete(requestKey); }).catch(() => undefined);
      }
      let binding: Binding;
      try { binding = await result; }
      catch (error) {
        // A CLI that refuses the Controller for its own reason leaves a session the Relay can read without it readable: the page
        // opens it from its journal, read-only, and is told why (O48).
        const bound = brokerState.nativeBindings.get(key);
        if (!(error instanceof BrokerError) || !error.nativeRefusal || !bound || bound.parentNativeSessionId !== parentNativeSessionId || !await readableWithoutController?.(bound)) throw error;
        assertMutationAccess();
        refused(bound, error.nativeRefusal);
        return bound;
      }
      if (binding.parentNativeSessionId !== parentNativeSessionId) {
        throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
      }
      assertMutationAccess(); await recoverBinding(host, binding); refused(binding, undefined); return binding;
    }
    let existing = creations.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw new BrokerError(409, 'request_conflict', 'This request identity was already used with different settings.');
    if (!existing) {
      if (creations.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local creation ledger is full.', true);
      const pending = { fingerprint, result: undefined as unknown as Promise<Binding> };
      pending.result = operation().catch(async error => {
        // Unknown source retries may read a durable result witness; they never repeat native creation.
        if (trackAssociation && creations.get(key) === pending) creations.delete(key);
        if (error instanceof BrokerError && error.creationRejected) {
          if (safeHostRejection && (trackAssociation && exactAdmission(brokerState.associations) || shared && brokerState.sharing.snapshot().reservations.some(row => row.key === shared.reservation.key))) await brokerState.commit(draft => {
            brokerState.assertHostCurrent(host, admittedGeneration);
            if (trackAssociation) {
              if (!exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Safe source rejection requires its exact admission.');
              draft.associations = structuredClone(brokerState.associations);
              draft.associations.admissions = draft.associations.admissions.filter(row => row.id !== admissionId); draft.associations.revision++;
              assertAssociationCapacity(draft.associations);
            }
            let nextSharing: HostSharing | undefined;
            if (shared) { exactSharedReceipt(draft); nextSharing = new HostSharing(draft.sharing, () => {}); nextSharing.release(shared.reservation.key); draft.sharing = nextSharing.snapshot(); }
            return { value: undefined, publish() { if (draft.associations) brokerState.associations = draft.associations; if (nextSharing) brokerState.sharing = nextSharing; } };
          });
          if (creations.get(key) === pending) creations.delete(key);
        }
        throw error;
      });
      creations.set(key, pending); existing = pending;
    }
    const binding = await existing.result;
    brokerState.assertHostCurrent(host, admittedGeneration);
    const completed = brokerState.completedCreations.get(key);
    if (trackAssociation && exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'A partially saved source completion requires exact reconciliation before activation.');
    if (!completed || completed.fingerprint !== fingerprint || completed.agentId !== binding.agentId || brokerState.bindings.get(binding.agentId) !== binding
      || binding.hostId !== host.id || binding.providerId !== providerId || creatorSubject && binding.creatorSubject !== creatorSubject) throw new BrokerError(409, 'creation_outcome_unknown', 'The complete creation result requires reconciliation.');
    if (shared && exactSharedReceipt(brokerState.snapshot()).agentId !== binding.agentId) throw new BrokerError(409, 'creation_outcome_unknown', 'The shared completion requires reconciliation.');
    assertMutationAccess(); await recoverBinding(host, binding); return binding;
  }
  /** The caller's deadline does not cancel or replace the shared creation promise. */
  async function waitForCreation(result: Promise<Binding>): Promise<Binding> {
    let timer: unknown;
    try {
      return await Promise.race([result, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrokerError(504, 'session_create_pending',
          'The Host is still opening this session. Retry checks the same pending creation without creating another session.')),
        rpcTimeoutMs ?? 30_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function userMutation(host: Host, action: string, body: Record<string, unknown>, subject?: string): Promise<Binding> {
    brokerState.assertHostCurrent(host);
    if (action === 'create' && body.conversationKind !== undefined && (!['side', 'ask'].includes(String(body.conversationKind)) || typeof body.sourceNativeSessionId !== 'string' || body.editNativeSessionId !== undefined)) {
      throw new BrokerError(400, 'invalid_request', 'A Side or Ask requires a source session.');
    }
    if (action === 'create') body = { ...body, conversationId: body.operationId };
    if (action === 'create' && brokerState.associations.freezes.some(row => row.hostId === host.id && row.receipt.request.operationId === body.operationId && row.receipt.request.preparation)) throw new BrokerError(409, 'succession_identity_conflict', 'Operation identity belongs to native prefix succession.');
    if (action === 'create' && ['editNativeSessionId', 'editTurnId', 'editMessageId'].some(key => body[key] !== undefined)) {
      if (body.sourceNativeSessionId !== undefined || ['editNativeSessionId', 'editTurnId', 'editMessageId'].some(key => typeof body[key] !== 'string' || !(body[key] as string).trim())) throw new BrokerError(400, 'invalid_request', 'A complete native prompt identity is required.');
      if (!host.providers.some(provider => provider.providerId === body.providerId && provider.promptEditing)) throw new BrokerError(400, 'unsupported_configuration', 'Prompt editing is unavailable on this Host. Update the Controller.');
    }
    if (action === 'create') {
      if (body.creationSource !== undefined && !isCreationSource(body.creationSource)) throw new BrokerError(400, 'invalid_request', 'A strict creation source is required.');
      const legacy = body.editNativeSessionId ?? body.sourceNativeSessionId;
      const provenance: CreationSource | undefined = body.creationSource === undefined
        ? legacy === undefined ? undefined : { providerId: required(body.providerId, 'providerId'), nativeSessionId: required(legacy, 'sourceNativeSessionId') }
        : body.creationSource;
      if (provenance && legacy !== undefined && (provenance.providerId !== body.providerId || provenance.nativeSessionId !== legacy)) throw new BrokerError(400, 'invalid_request', 'Creation source contradicts the native source identity.');
      if (provenance) {
        if (!host.providers.some(provider => provider.providerId === provenance.providerId)) throw new BrokerError(400, 'invalid_provider', 'The source provider is unavailable on this Host.');
        requireAccess(host.id, subject);
        const source = brokerState.nativeBindings.get(JSON.stringify([host.id, provenance.providerId, provenance.nativeSessionId]));
        if (!source || !sessionAllowed(source, subject)) throw new SharingError(403, 'session_forbidden', 'Source session access is unavailable. Open an accessible source session first.');
        // Canonicalize before both create ledgers; inferred legacy source is semantically identical.
        body = { ...body, creationSource: { providerId: provenance.providerId, nativeSessionId: provenance.nativeSessionId } };
      }
    }
    if (owner(subject)) return mutate(host, action, body);
    requireAccess(host.id, subject);
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (action !== 'create') {
      const nativeSessionId = required(body.nativeSessionId, 'nativeSessionId');
      const existing = brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
      if (existing && sessionAllowed(existing, subject)) {
        await recoverBinding(host, existing); return existing;
      }
      if (action === 'child/attach') {
        const parentId = required(body.parentNativeSessionId, 'parentNativeSessionId');
        const parent = brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, parentId]));
        if (parent && sessionAllowed(parent, subject)) {
          await recoverBinding(host, parent);
          const result = await sessionRead(host, parent, `/v1/sessions/${encodeURIComponent(parent.agentId)}/snapshot`);
          const data = JSON.parse(result.body);
          const children: unknown = data?.payload?.runtimeInfo?.childSessions;
          if (result.status === 200 && Array.isArray(children) && children.some(child => child?.nativeSessionId === nativeSessionId)) {
            requireAccess(host.id, subject);
            if (existing && existing.creatorSubject !== subject) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
            return mutate(host, action, body, subject);
          }
        }
      }
      throw new SharingError(403, 'session_forbidden', 'Only your own sessions can be attached.');
    }
    if (!host.providers.some(provider => provider.providerId === providerId)) throw new SharingError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && ['cwd', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId'].some(key => body[key] !== undefined)) throw new SharingError(400, 'unsupported_configuration', 'This Host uses native settings.');
    const operationId = required(body.operationId, 'operationId');
    const fingerprint = JSON.stringify({ providerId, ...creationFingerprintSettings(body, ['conversationKind', 'cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId']) });
    const reservation = new HostSharing(brokerState.sharing.snapshot(), () => {}).reserve(host.id, subject!, providerId, operationId, fingerprint);
    const creationKey = JSON.stringify([host.id, providerId, reservation.nativeRequestId]);
    const pending = sharedCreates.get(reservation.key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new SharingError(409, 'operation_conflict', 'This creation operation has different settings.');
      return pending.result;
    }
    if (reservation.agentId && !enrollmentEnabled && !savedAssociations) {
      const binding = brokerState.bindings.get(reservation.agentId);
      if (!binding || binding.hostId !== host.id || binding.providerId !== providerId || !sessionAllowed(binding, subject)) throw new SharingError(409, 'creation_outcome_unknown', 'The saved shared result requires reconciliation.');
      await recoverBinding(host, binding); return binding;
    }
    if (!reservation.fresh && !reservation.agentId && !brokerState.completedCreations.has(creationKey)) {
      const admissionId = createHash('sha256').update(creationKey).digest('hex');
      if (!body.sourceNativeSessionId || !brokerState.associations.admissions.some(row => row.id === admissionId)) throw new SharingError(409, 'creation_outcome_unknown', 'A previous creation is unresolved. Its quota reservation is retained; ask the Host owner to reconcile it.');
    }
    const operation = mutate(host, action, { ...body, operationId: reservation.nativeRequestId }, subject, { subject: subject!, operationId, fingerprint, reservation });
    const sharedOperation = { fingerprint, result: operation }; sharedCreates.set(reservation.key, sharedOperation);
    try { return await operation; } finally { if (sharedCreates.get(reservation.key) === sharedOperation) sharedCreates.delete(reservation.key); }
  }
  async function sharedCatalog(host: Host, action: string, query: URLSearchParams, subject: string): Promise<RpcResponse> {
    const providerId = host.legacyDsh ? 'dsh' : query.get('providerId');
    const owned = [...brokerState.bindings.values()].filter(binding => binding.hostId === host.id && binding.providerId === providerId && binding.creatorSubject === subject && !binding.parentNativeSessionId);
    const revisionResult = await rpc(host, 'GET', `/remote/catalog/revision${query.size ? '?' + query : ''}`);
    requireAccess(host.id, subject);
    if (revisionResult.status !== 200) return revisionResult;
    const revision = createHash('sha256').update(JSON.stringify([JSON.parse(revisionResult.body).revision, owned.map(value => value.nativeSessionId)])).digest('hex');
    if (action === 'catalog/revision') return { status: 200, body: JSON.stringify({ revision }) };
    if (host.legacyDsh) {
      const result = await rpc(host, 'GET', `/remote/catalog${query.size ? '?' + query : ''}`);
      requireAccess(host.id, subject);
      if (result.status !== 200) return result;
      const page = JSON.parse(result.body);
      return { status: 200, body: JSON.stringify({ ...page, revision, items: Array.isArray(page.items) ? page.items.filter((item: { nativeSessionId?: string }) => owned.some(value => value.nativeSessionId === item.nativeSessionId)) : [] }) };
    }
    const offset = Number(query.get('cursor') ?? 0); const limit = Number(query.get('limit') ?? 30);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SharingError(400, 'invalid_cursor', 'Invalid session page.');
    const items = [];
    for (const binding of owned.slice(offset, offset + limit)) {
      const parameters = new URLSearchParams({ providerId: binding.providerId, nativeSessionId: binding.nativeSessionId });
      const result = await rpc(host, 'GET', `/remote/catalog/session?${parameters}`);
      requireAccess(host.id, subject);
      if (result.status === 404) continue;
      if (result.status !== 200) return result;
      const summary = JSON.parse(result.body);
      if (summary.nativeSessionId !== binding.nativeSessionId || summary.providerId !== binding.providerId) throw new SharingError(502, 'invalid_host_response', 'Host returned a different session summary.');
      items.push(summary);
    }
    requireAccess(host.id, subject);
    const next = offset + limit;
    return { status: 200, body: JSON.stringify({ items, hasMore: next < owned.length, ...(next < owned.length ? { nextCursor: String(next) } : {}), revision }) };
  }

  /** The Host's bindings and creation records leave with the Host; called inside the publish of the revoke commit. */
  function forgetHost(hostId: string) {
    for (const [id, binding] of brokerState.bindings) if (binding.hostId === hostId) {
      brokerState.bindings.delete(id); runtimeBindings.delete(id); const key = JSON.stringify([hostId, binding.providerId, binding.nativeSessionId]);
      brokerState.nativeBindings.delete(key); attached.delete(key);
    }
    for (const [key, value] of brokerState.completedCreations) if (!brokerState.bindings.has(value.agentId)) { brokerState.completedCreations.delete(key); creations.delete(key); }
    for (const key of creations.keys()) if (key.startsWith(`[${JSON.stringify(hostId)},`)) creations.delete(key);
    for (const key of attachmentRequests.keys()) if (JSON.parse(JSON.parse(key)[0])[0] === hostId) attachmentRequests.delete(key);
  }
  /** The Relay shuts down: its saved records and the runtime ledgers are dropped. */
  function clear() { runtimeBindings.clear(); attached.clear(); creations.clear(); }
  return { runtimeAgentId, sessionRead, recoverBinding, mutate, waitForCreation, userMutation, sharedCatalog, hasCreation: (key: string) => creations.has(key), forgetHost, clear,
    /** The CLI's refusal of the Controller for a bound session, while it lasts. */
    nativeRefusal: (agentId: string): NativeRefusal | undefined => nativeRefusals.get(agentId) };
}
