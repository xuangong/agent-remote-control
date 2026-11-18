import { TeamBroker } from './teams.js';
import { committed } from './drafts.js';
import { freeze } from 'immer';
import { isDeepStrictEqual } from 'node:util';
import { validBrokerAssociations, type BrokerAssociationState } from './succession-associations.js';
import { isNativeSessionRef, isNativePrefixSelection, nativePrefixSelectionKey, isPrimaryRole, isSuccessionRecord, isSuccessionDescription, isSuccessionActionResult, nativeSessionRefKey, successionFreezeKey, successionAuthorityKey, type NativeSessionRef, type SuccessionAssociationFreeze, type BoundedSuccessionAssociationFreeze, type NativePrefixSuccessionAssociationFreeze, type PrimaryRole, type SuccessionRecord, type SuccessionActionResult, type SuccessionAssociationAuthority } from '@orchardworks/agent-remote-protocol';
import { isSuccessionCapacityError, remainingAssociationRevisions, SUCCESSION_FEATURE_BYTES } from './succession-capacity.js';
import { required } from './request-input.js';
import { BrokerError, type Host, type HostBrokerOptions, type RpcResponse } from './broker-types.js';
import { type BrokerState } from './broker-state.js';
import { type RelayIds } from './relay-ids.js';

/**
 * Succession associations: the Relay's record of which native sessions replace which, the freezes that hold a source while a
 * Controller prepares and commits a succession, and the guards the other concerns call before they touch a source session.
 *
 * Contract:
 * - The records live in `BrokerState.associations` and change only through `change`, which clones them, applies the update,
 *   bumps `revision` and commits; a change that leaves them equal commits nothing. A revision or storage limit throws
 *   `association_capacity` before anything is saved.
 * - `assertOpen`, `assertMutable` and `assertCreationOpen` refuse (409) a source that a pending relation change or an unreleased
 *   freeze holds, a source whose primary role forbids relation updates, or one that was superseded.
 * - `action` (`describe`, `prepare`, `commit`, `cancel`, `status`, `reconcile`) drives one succession through the Controller's
 *   enrollment rpc. It saves a freeze before the first effect, verifies every Controller answer against that freeze, and releases the
 *   freeze only after reading back the durable decision. Without negotiated enrollment on both sides it refuses (409).
 * - It keeps no state of its own: a restart finds every operation in the saved associations.
 *
 * Ports: `rpc` (a request to a Host's Controller), `teams` (are Team recipients settled), `creations` (is a creation operation id
 * already used by the legacy ledger), `ids`, the enrollment authority and the projection allowance.
 */
export interface SuccessionPorts {
  brokerState: BrokerState;
  /** Trusted enrollment authority; absent when the Relay does not enroll successions. */
  enrollment: SuccessionAssociationAuthority | undefined;
  projectionAllowance: HostBrokerOptions['successionProjectionAllowance'];
  ids: RelayIds;
  rpc(host: Host, method: 'GET' | 'POST', path: string, sessionId?: string, body?: string, diagnosticRequest?: boolean): Promise<RpcResponse>;
  teams: Pick<TeamBroker, 'assertReplacementSupported' | 'hasUnsettledRecipient'>;
  creations: { has(key: string): boolean };
}
export type Succession = ReturnType<typeof createSuccession>;

export function createSuccession(ports: SuccessionPorts) {
  const { brokerState, enrollment, projectionAllowance, ids, rpc, teams, creations } = ports;
  function assertAssociationCapacity(state: BrokerAssociationState) {
    if (!validBrokerAssociations(state) || state.revision > Number.MAX_SAFE_INTEGER - remainingAssociationRevisions(state)) throw new BrokerError(409, 'association_capacity', 'Association storage or revision headroom is exhausted.');
    brokerState.retainedIdentities(state);
  }
  function associationChange<T>(change: (state: BrokerAssociationState) => T, preEffect = false): Promise<T> {
    return brokerState.commit(draft => {
      const next = structuredClone(brokerState.associations), value = change(next);
      if (isDeepStrictEqual(next, brokerState.associations)) return { value, unchanged: true, publish() {} };
      if (next.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
      next.revision++;
      assertAssociationCapacity(next);
      draft.associations = next;
      return { value, publish() { brokerState.associations = next; } };
    }, preEffect);
  }
  function assertAssociationOpen(source: NativeSessionRef) {
    if (brokerState.associations.relationChanges.some(item => item.phase !== 'committed' && item.reservation.lineage.some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)))) throw new BrokerError(409, 'relation_change_pending', 'Source relationships are reserved by a pending edit.', true);
    if (brokerState.associations.freezes.some(item => !item.released && item.receipt.lineage.some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)))) throw new BrokerError(409, 'succession_associations_frozen', 'Source relationships are reserved by succession.', true);
  }
  function assertAssociationMutable(source: NativeSessionRef): void {
    assertAssociationOpen(source);
    if (brokerState.associations.freezes.some(item => item.projection && [...item.receipt.lineage, item.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)))) {
      throw new BrokerError(409, 'succession_relationship_updates_unavailable', 'Trusted relationship updates are not enabled for this primary role.');
    }
  }
  function assertAssociationCreationOpen(source: NativeSessionRef) {
    assertAssociationOpen(source);
    const current = brokerState.associations.freezes.filter(row => row.projection && [...row.receipt.lineage, row.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source))).at(-1)?.projection?.role.current;
    if (current && nativeSessionRefKey(current) !== nativeSessionRefKey(source)) throw new BrokerError(409, 'session_superseded', 'Source session has been superseded.', true);
  }
  const associationSource = (host: Host, providerId: string, nativeSessionId: string): NativeSessionRef => ({ controllerId: host.installationId, providerId, nativeSessionId });
  async function associationRpc(host: Host, input: unknown): Promise<Record<string, any>> {
    const generation = host.generation; brokerState.assertHostCurrent(host);
    if (!enrollment || !host.successionEnrollmentVersion) throw new BrokerError(409, 'succession_enrollment_unavailable', 'Trusted succession enrollment was not negotiated.');
    const response = await rpc(host, 'POST', '/remote/succession/enrollment', undefined, JSON.stringify(input));
    brokerState.assertHostCurrent(host, generation);
    let payload: Record<string, any>;
    try { payload = JSON.parse(response.body); } catch { throw new BrokerError(502, 'invalid_host_response', 'Invalid succession response.'); }
    if (response.status !== 200) throw new BrokerError(response.status, String(payload.code ?? 'succession_enrollment_failed'), String(payload.error ?? 'Succession enrollment failed.'));
    return payload;
  }
  async function successionAction(host: Host, action: string, input: Record<string, unknown>) {
    const generation = host.generation; brokerState.assertHostCurrent(host);
    if (!enrollment || !host.successionEnrollmentVersion) throw new BrokerError(409, 'succession_enrollment_unavailable', 'Trusted succession enrollment was not negotiated.');
    if (input.preparation !== undefined && !isNativePrefixSelection(input.preparation)) throw new BrokerError(400, 'invalid_succession_request', 'An exact native prefix selection is required.');
    if (input.preparation !== undefined && host.successionEnrollmentVersion !== 3) throw new BrokerError(409, 'succession_preparation_unavailable', 'Native prefix requires acknowledged v3.');
    const preparation = isNativePrefixSelection(input.preparation) ? input.preparation : undefined;
    if (action === 'describe') {
      if (Object.keys(input).some(name => !['providerId', 'nativeSessionId', 'preparation'].includes(name))) throw new BrokerError(400, 'invalid_succession_request', 'Only the source selection may be supplied.');
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      const described = await associationRpc(host, { action, providerId, nativeSessionId, ...(preparation ? { preparation } : {}) });
      const result = { role: described.role, targets: described.targets, eligibility: described.eligibility };
      if (!isSuccessionDescription(result) || result.role.current.controllerId !== host.installationId) throw new BrokerError(502, 'invalid_host_response', 'Invalid handoff description.');
      if (host.successionEnrollmentVersion < 2 || !projectionAllowance) result.eligibility = { status: 'unavailable', code: 'succession_preparation_unavailable', reason: 'New handoff requires the current Host and Relay capability.' };
      return result;
    }
    const selectionKeys = ['providerId', 'nativeSessionId', 'expectedRevision', 'targetProviderId', 'preparation'];
    const allowed = action === 'prepare' || action === 'cancel' ? ['operationId', ...selectionKeys] : action === 'status' ? ['operationId', 'includeContext'] : ['operationId'];
    if (Object.keys(input).some(name => !allowed.includes(name))) throw new BrokerError(400, 'invalid_succession_request', 'Only source selection and operation identity may be supplied.');
    if (input.includeContext !== undefined && input.includeContext !== true) throw new BrokerError(400, 'invalid_succession_request', 'Context status must be explicitly requested.');
    const operationId = required(input.operationId, 'operationId');
    let frozen = brokerState.associations.freezes.find(item => item.hostId === host.id && item.receipt.request.operationId === operationId);
    if (action === 'prepare' || action === 'cancel' && selectionKeys.some(name => Object.hasOwn(input, name))) {
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      const source = associationSource(host, providerId, nativeSessionId);
      const targetProviderId = input.targetProviderId === undefined ? undefined : required(input.targetProviderId, 'targetProviderId');
      if (preparation && targetProviderId !== undefined && targetProviderId !== providerId) throw new BrokerError(400, 'invalid_succession_request', 'Native prefix must stay on the same provider.');
      const assertNoLegacyCreation = () => {
        if (preparation && (creations.has(JSON.stringify([host.id, providerId, operationId])) || brokerState.completedCreations.has(JSON.stringify([host.id, providerId, operationId])))) throw new BrokerError(409, 'succession_identity_conflict', 'Operation identity belongs to legacy creation.');
      };
      assertNoLegacyCreation();
      if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) throw new BrokerError(400, 'invalid_succession_request', 'A current role revision is required.');
      const assertSameRequest = (receipt: SuccessionAssociationFreeze) => {
        const prior = receipt.request;
        if (nativePrefixSelectionKey(prior.preparation) !== nativePrefixSelectionKey(preparation) || nativeSessionRefKey(prior.from) !== nativeSessionRefKey(source) || prior.expectedRevision !== input.expectedRevision || (prior.targetProviderId ?? prior.from.providerId) !== (targetProviderId ?? providerId)) throw new BrokerError(409, 'succession_identity_conflict', 'Succession operation identity changed.');
      };
      if (frozen) {
        assertSameRequest(frozen.receipt);
      } else {
        if (action === 'prepare' && (host.successionEnrollmentVersion < 2 || !projectionAllowance)) throw new BrokerError(409, 'succession_preparation_unavailable', 'New succession preparation requires negotiated v2 and projection admission.');
        const described = await associationRpc(host, { action: 'describe', providerId, nativeSessionId, ...(preparation ? { preparation } : {}) });
        if (!isPrimaryRole(described.role) || !Array.isArray(described.lineage) || described.role.current.controllerId !== host.installationId
          || described.lineage.length !== described.role.revision || !described.lineage.every(isNativeSessionRef)
          || nativeSessionRefKey(described.lineage[0]!) !== nativeSessionRefKey(described.role.origin)
          || nativeSessionRefKey(described.lineage.at(-1)!) !== nativeSessionRefKey(described.role.current)
          || !described.lineage[(input.expectedRevision as number) - 1]
          || nativeSessionRefKey(described.lineage[(input.expectedRevision as number) - 1]!) !== nativeSessionRefKey(source)
          || action === 'prepare' && described.role.revision !== input.expectedRevision) throw new BrokerError(409, 'invalid_host_response', 'The selected primary role revision could not be verified.');
        frozen = await brokerState.commit(draft => {
          const state = structuredClone(brokerState.associations);
          brokerState.assertHostCurrent(host, generation);
          assertNoLegacyCreation();
          const duplicate = state.freezes.find(item => item.hostId === host.id && item.receipt.request.operationId === operationId);
          if (duplicate) { assertSameRequest(duplicate.receipt); return { value: duplicate, unchanged: true, publish() {} }; }
          if (state.freezes.filter(item => item.receipt.request.roleId === described.role.id).length >= 512) throw new BrokerError(409, 'succession_role_capacity', 'Succession role history is full; reconcile existing operations.');
          for (const ref of described.lineage as NativeSessionRef[]) assertAssociationOpen(ref);
          if (action === 'cancel') {
            // A new v1 receipt cannot prepare a native candidate; retain it before asking the Host to cancel.
            const receipt: SuccessionAssociationFreeze = { ...(preparation ? { version: 3 as const, maxProjectionBytes: 1 } : { version: 1 as const }), token: ids.uuid(), authority: enrollment!, controllerId: host.installationId,
              request: { operationId, roleId: described.role.id, expectedRevision: input.expectedRevision as number, from: source, ...(targetProviderId ? { targetProviderId } : {}), ...(preparation ? { preparation } : {}) },
              associationRevision: state.revision, lineage: described.lineage, relations: [] };
            if (state.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
            state.revision++;
            const result = { hostId: host.id, receipt, cancelOnly: true as const }; state.freezes.push(result);
            assertAssociationCapacity(state); draft.associations = state;
            return { value: result, publish() { brokerState.associations = state; } };
          }
          if (state.admissions.some(admission => described.lineage.some((ref: NativeSessionRef) => nativeSessionRefKey(ref) === nativeSessionRefKey(admission.source)))) throw new BrokerError(409, 'association_outcome_unknown', 'Settle source creation before succession.');
          teams.assertReplacementSupported(source, host.id, !preparation);
          if (teams.hasUnsettledRecipient(source)) throw new BrokerError(409, 'team_delivery_unsettled', 'Settle Team delivery before succession.');
          const proposal: Omit<BoundedSuccessionAssociationFreeze | NativePrefixSuccessionAssociationFreeze, 'maxProjectionBytes'> = { version: preparation ? 3 : 2, token: ids.uuid(), authority: enrollment!, controllerId: host.installationId,
            request: { operationId, roleId: described.role.id, expectedRevision: input.expectedRevision as number, from: source, ...(targetProviderId ? { targetProviderId } : {}), ...(preparation ? { preparation } : {}) },
            associationRevision: state.revision, lineage: described.lineage,
            relations: [...brokerState.bindings.values()].filter(binding => binding.hostId === host.id && binding.sourceRelation).map(binding => ({
              relationId: binding.sourceRelation!.id, kind: binding.sourceRelation!.kind, readerRef: associationSource(host, binding.providerId, binding.nativeSessionId),
              sourceRef: binding.sourceRelation!.nativeSourceRef ?? associationSource(host, binding.providerId, binding.sourceRelation!.sourceNativeSessionId), linked: binding.sourceRelation!.linked ?? true, revision: binding.sourceRelation!.revision ?? 0,
            })) };
          if (state.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
          state.revision++;
          draft.associations = state;
          let maxProjectionBytes: number;
          try { maxProjectionBytes = projectionAllowance!({ hostId: host.id, broker: structuredClone(draft), freeze: structuredClone(proposal) }); }
          catch (error) { if (isSuccessionCapacityError(error)) throw new BrokerError(error.status, error.code, error.message); brokerState.failClosed(); throw error; }
          if (!Number.isSafeInteger(maxProjectionBytes) || maxProjectionBytes < 1 || maxProjectionBytes > SUCCESSION_FEATURE_BYTES) throw new BrokerError(409, 'succession_projection_capacity_exceeded', 'No valid committed projection allowance is available.');
          const receipt: SuccessionAssociationFreeze = { ...proposal, maxProjectionBytes };
          const result = { hostId: host.id, receipt }; state.freezes.push(result);
          if (!validBrokerAssociations(state)) throw new BrokerError(409, 'association_capacity', 'Association storage is full or invalid.');
          brokerState.retainedIdentities(state);
          return { value: result, publish() { brokerState.associations = state; } };
        }, true);
      }
    }
    if (frozen && frozen.receipt.version > host.successionEnrollmentVersion) throw new BrokerError(409, 'succession_enrollment_unavailable', 'Saved succession requires its acknowledged enrollment version.');
    if (!frozen) throw new BrokerError(404, 'succession_not_found', 'No frozen succession operation exists.');
    if (frozen.cancelOnly && frozen.receipt.request.preparation && !['cancel', 'status'].includes(action)) throw new BrokerError(409, 'succession_cancelled', 'This original request was cancelled before preparation.');
    if (successionAuthorityKey(frozen.receipt.authority) !== successionAuthorityKey(enrollment!)) throw new BrokerError(409, 'succession_authority_changed', 'The frozen authority requires reconciliation.');
    const receipt = frozen.receipt;
    async function withContextStatus(result: SuccessionActionResult): Promise<SuccessionActionResult> {
      if (!input.includeContext || result.record.preparation || result.record.phase !== 'committed') return result;
      const current = await associationRpc(host, { action: 'status', freeze: receipt, includeContext: true });
      const observed = { ...result, ...(current.context === undefined ? {} : { context: current.context }) };
      if (!current.freeze || successionFreezeKey(current.freeze) !== successionFreezeKey(receipt)
        || !isDeepStrictEqual(current.record, result.record) || !isSuccessionActionResult(observed)) throw new BrokerError(502, 'invalid_host_response', 'The handoff context status could not be verified.');
      return observed;
    }
    if (frozen.released === 'committed' && frozen.projection && ['status', 'reconcile', 'commit'].includes(action)) {
      if (action !== 'status' || frozen.receipt.request.preparation) await associationRpc(host, { action: 'release', freeze: frozen.receipt });
      const result = { record: structuredClone(frozen.projection.receipt), role: structuredClone(frozen.projection.role), locator: { hostId: host.id, providerId: frozen.projection.role.current.providerId, nativeSessionId: frozen.projection.role.current.nativeSessionId } };
      return withContextStatus(result);
    }
    if (action === 'commit') teams.assertReplacementSupported(frozen.receipt.request.from, host.id, !frozen.receipt.request.preparation);
    if (action === 'commit' && teams.hasUnsettledRecipient(frozen.receipt.request.from)) throw new BrokerError(409, 'team_delivery_unsettled', 'Settle Team delivery before succession.');
    const result = await associationRpc(host, { action, freeze: frozen.receipt });
    if (!isSuccessionRecord(result.record) || !isPrimaryRole(result.role) || !result.freeze || successionFreezeKey(result.freeze) !== successionFreezeKey(frozen.receipt)
      || result.record.operationId !== operationId || result.record.roleId !== frozen.receipt.request.roleId) throw new BrokerError(502, 'invalid_host_response', 'The saved succession receipt could not be verified.');
    if (['committed', 'rejected', 'cancelled'].includes(result.record.phase)) {
      const confirmed = await associationRpc(host, { action: 'status', freeze: frozen.receipt });
      if (!isDeepStrictEqual(confirmed, result)) throw new BrokerError(409, 'succession_decision_changed', 'Read back the durable succession decision before releasing associations.');
      await associationChange(state => {
        brokerState.assertHostCurrent(host, generation);
        const item = state.freezes.find(item => item.receipt.token === frozen!.receipt.token)!;
        if (item.released) {
          if (item.released !== result.record.phase || item.projection && !isDeepStrictEqual(item.projection, { version: 1, role: result.role, receipt: result.record })) throw new BrokerError(409, 'succession_decision_changed', 'The released succession decision changed.');
          return;
        }
        item.released = result.record.phase;
        if (result.record.phase === 'committed') item.projection = { version: 1, role: result.role as PrimaryRole, receipt: result.record as SuccessionRecord };
      });
    }
    if (['committed', 'rejected', 'cancelled'].includes(result.record.phase)) await associationRpc(host, { action: 'release', freeze: frozen.receipt });
    return withContextStatus({ record: result.record, role: result.role, locator: { hostId: host.id, providerId: result.role.current.providerId, nativeSessionId: result.role.current.nativeSessionId } });
  }
  function prefixRecords(host: Host): SuccessionRecord[] {
    return brokerState.associations.freezes.filter(row => row.hostId === host.id && row.projection).map(row => row.projection!.receipt);
  }
  return { assertCapacity: assertAssociationCapacity, change: associationChange, assertOpen: assertAssociationOpen, assertMutable: assertAssociationMutable, assertCreationOpen: assertAssociationCreationOpen, source: associationSource, rpc: associationRpc, action: successionAction, prefixRecords };
}
