import { committed } from './drafts.js';
import { relationChangeKey, isRelationChangeReceipt, type RelationChangeReservation, type RelationChangeReceipt, nativePrefixSegmentAncestors, resolveNativePrefix, isPrimaryRole, nativeSessionRefKey, successionAuthorityKey, type NativeSessionRef, type PrimaryRole, type SuccessionAssociationAuthority } from '@orchardworks/agent-remote-protocol';
import { type RelationChangeReset, type BrokerRelationChange } from './relation-changes.js';
import { isDeepStrictEqual } from 'node:util';
import { type BrokerAssociationState } from './succession-associations.js';
import { SharingError } from './host-sharing.js';
import { BrokerError, type Binding, type Host } from './broker-types.js';
import { type BrokerState } from './broker-state.js';
import { type RelayIds } from './relay-ids.js';
import { type Access } from './access.js';
import { type Succession } from './succession-service.js';

/**
 * Source relationships (Side and Ask sessions linked to the session they were started from) and the edits of them.
 *
 * Contract:
 * - A relation edit is an operation saved in `BrokerState.associations.relationChanges` and moved through four phases: reserved (the
 *   Relay and the Controller both hold it), metadata committed (the binding carries the new relation), overlay applied at the
 *   Controller, then committed after the Controller released it. Each phase is saved before the next effect, and
 *   `continueRelationChange` resumes an operation from whatever phase was saved; one operation runs at most once at a time.
 * - Every access check runs again after each await: the Host connection, the binding and the subject's access must be what the
 *   operation started with, else it fails (403, 409) and leaves the saved phase for a retry.
 * - Only the account owner edits relations. Reading a relation needs access to the reader and to the source.
 * - An operation reset before any effect, repeated exactly, answers `relation_change_reset`.
 *
 * Ports: `access`, the succession service (saved associations and the Controller's enrollment rpc), `BrokerState`, `ids`.
 */
export interface RelationPorts {
  brokerState: BrokerState;
  access: Access;
  succession: Succession;
  enrollment: SuccessionAssociationAuthority | undefined;
  ids: RelayIds;
}

export function createRelations(ports: RelationPorts) {
  const { brokerState, access, succession, enrollment, ids } = ports;
  const { owner, hostAllowed, sessionAllowed, requireOwner, requireHost } = access;
  const { assertCapacity: assertAssociationCapacity, change: associationChange, assertOpen: assertAssociationOpen, source: associationSource, rpc: associationRpc, prefixRecords } = succession;
  function currentRelationTarget(host: Host, binding: Binding, subject: string): NativeSessionRef {
    const anchor = associationSource(host, binding.providerId, binding.nativeSessionId);
    const target = resolveNativePrefix(anchor, prefixRecords(host)).target;
    const actual = brokerState.nativeBindings.get(JSON.stringify([host.id, target.providerId, target.nativeSessionId]));
    if (binding.sourceRelation && nativePrefixSegmentAncestors(target, prefixRecords(host)).filter(ref => brokerState.nativeBindings.get(JSON.stringify([host.id, ref.providerId, ref.nativeSessionId]))?.sourceRelation).length !== 1) throw new SharingError(409, 'relation_conflict', 'Source reader ancestry is ambiguous.');
    if (!sessionAllowed(binding, subject) || actual && !sessionAllowed(actual, subject) || !actual && !owner(subject)) {
      throw new SharingError(403, 'session_forbidden', 'Current relation reader access is unavailable.');
    }
    return target;
  }
  /** Saved grants and creation provenance stay on their original reader binding. */
  function canonicalRelationInput<T extends { hostId: string; providerId: string; nativeSessionId: string }>(subject: string, input: T, importing = false): T {
    const host = brokerState.hosts.get(input.hostId);
    if (!host) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
    const actual = brokerState.nativeBindings.get(JSON.stringify([host.id, input.providerId, input.nativeSessionId]));
    if (actual ? !sessionAllowed(actual, subject) : !owner(subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
    const matches = nativePrefixSegmentAncestors(associationSource(host, input.providerId, input.nativeSessionId), prefixRecords(host))
      .map(ref => brokerState.nativeBindings.get(JSON.stringify([host.id, ref.providerId, ref.nativeSessionId])))
      .filter((binding): binding is Binding => !!binding && (!!binding.sourceRelation || importing && [...brokerState.completedCreations.values()].some(value => value.agentId === binding.agentId)));
    if (matches.length !== 1) throw new SharingError(409, 'relation_conflict', 'Source reader ancestry is missing or ambiguous.');
    const binding = matches[0]!;
    currentRelationTarget(host, binding, subject);
    return { ...input, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId };
  }
  function relationAccess(subject: string, reservation: RelationChangeReservation) {
    requireOwner(subject);
    const host = requireHost(reservation.hostId);
    if (host.installationId !== reservation.controllerId || !enrollment || successionAuthorityKey(enrollment) !== successionAuthorityKey(reservation.authority)) throw new SharingError(403, 'session_forbidden', 'Relation authority is unavailable.');
    const binding = brokerState.nativeBindings.get(JSON.stringify([host.id, reservation.readerRef.providerId, reservation.readerRef.nativeSessionId]));
    const source = brokerState.nativeBindings.get(JSON.stringify([host.id, reservation.sourceRef.providerId, reservation.sourceRef.nativeSessionId]));
    if (!binding || !source || !sessionAllowed(binding, subject) || !sessionAllowed(source, subject) || !hostAllowed(host.id, subject) || !host.providers.some(row => row.providerId === reservation.current.providerId)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
    currentRelationTarget(host, binding, subject);
    const relation = binding.sourceRelation;
    const nativeSource = relation?.nativeSourceRef ?? associationSource(host, binding.providerId, relation?.sourceNativeSessionId ?? '');
    if (!relation || relation.id !== reservation.relationId || relation.kind !== reservation.kind || nativeSessionRefKey(nativeSource) !== nativeSessionRefKey(reservation.sourceRef)) throw new SharingError(409, 'relation_conflict', 'The immutable source relationship changed.');
    return { host, binding, relation };
  }
  function savedRelationOperation(subject: string, selection: { hostId: string; operationId: string }) {
    const saved = brokerState.associations.relationChanges.find(row => row.reservation.hostId === selection.hostId && row.reservation.operationId === selection.operationId);
    if (!saved) throw new SharingError(404, 'relation_change_not_found', 'No pending relationship operation exists.');
    relationAccess(subject, saved.reservation); return saved;
  }
  async function relationHostStatus(host: Host, saved: BrokerRelationChange): Promise<RelationChangeReceipt | undefined> {
    const result = await associationRpc(host, { action: 'relation_status', reservation: saved.reservation });
    if (result.receipt === null) return undefined;
    if (!isRelationChangeReceipt(result.receipt) || relationChangeKey(result.receipt.reservation) !== relationChangeKey(saved.reservation)
      || saved.hostReceipt && ({ reserved: 0, applied: 1, released: 2 })[result.receipt.phase] < ({ reserved: 0, applied: 1, released: 2 })[saved.hostReceipt.phase]) throw new BrokerError(502, 'invalid_host_response', 'Exact relation receipt could not be verified.');
    const expectedRevision = saved.reservation.associationRevision + (result.receipt.phase === 'reserved' ? 0 : Number(saved.reservation.previousMember !== saved.reservation.linked));
    if (result.receipt.associationRevision !== expectedRevision) throw new BrokerError(409, 'relation_receipt_conflict', 'Host relation receipt revision changed.');
    return result.receipt;
  }
  const relationContinuations = new Map<string, Promise<{ operation: BrokerRelationChange }>>();
  function continueRelationChange(subject: string, initial: BrokerRelationChange): Promise<{ operation: BrokerRelationChange }> {
    const key = initial.reservation.operationId, existing = relationContinuations.get(key);
    if (existing) return existing;
    const running = (async () => {
      let saved = savedRelationOperation(subject, initial.reservation), reservation = saved.reservation;
      const { host, binding } = relationAccess(subject, reservation), generation = host.generation;
      const access = () => {
        brokerState.assertHostCurrent(host, generation); assertAssociationCapacity(brokerState.associations);
        const current = relationAccess(subject, reservation);
        if (current.binding !== binding) throw new SharingError(403, 'session_forbidden', 'Session access changed.');
        return current;
      };
      if (saved.phase === 'committed') return { operation: structuredClone(saved) };
      let receipt = await relationHostStatus(access().host, saved);
      if (!receipt) {
        if (saved.phase !== 'reserved') throw new BrokerError(409, 'relation_host_outcome_unknown', 'Committed metadata requires its durable Host reservation.');
        await associationRpc(access().host, { action: 'relation_reserve', reservation });
        receipt = await relationHostStatus(access().host, saved);
        if (!receipt) throw new BrokerError(409, 'relation_host_outcome_unknown', 'Host reservation remains unknown.');
      }
      if (saved.phase === 'reserved') {
        if (receipt.phase !== 'reserved' || receipt.associationRevision !== reservation.associationRevision) throw new BrokerError(409, 'relation_receipt_conflict', 'Host reservation outcome changed.');
        await brokerState.commit(draft => {
          const { binding, relation } = access();
          const next = structuredClone(brokerState.associations), operation = next.relationChanges.find(row => row.reservation.operationId === key)!;
          if (operation.phase !== 'reserved' || relation.revision !== undefined && relation.revision !== reservation.expectedRelationRevision || (relation.linked ?? true) !== reservation.previousLinked) throw new SharingError(409, 'relation_conflict', 'Relationship revision changed.');
          const changed = { ...relation, nativeSourceRef: reservation.sourceRef, linked: reservation.linked, revision: reservation.expectedRelationRevision + 1 };
          operation.phase = 'metadata_committed'; operation.hostReceipt = receipt; next.revision++;
          assertAssociationCapacity(next);
          draft.associations = next; draft.bindings.find(row => row.agentId === binding.agentId)!.sourceRelation = changed;
          return { value: undefined, publish() { brokerState.associations = next; binding.sourceRelation = changed; } };
        });
        saved = savedRelationOperation(subject, reservation);
      }
      if (receipt.phase === 'reserved') {
        await associationRpc(access().host, { action: 'relation_apply', reservation });
        receipt = await relationHostStatus(access().host, saved);
      }
      const expectedAssociationRevision = reservation.associationRevision + Number(reservation.previousMember !== reservation.linked);
      if (!receipt || receipt.phase === 'reserved' || receipt.associationRevision !== expectedAssociationRevision) throw new BrokerError(409, 'relation_host_outcome_unknown', 'Applied relation overlay could not be verified.');
      await associationChange(state => {
        const { relation } = access();
        if ((relation.revision ?? 0) !== reservation.expectedRelationRevision + 1 || (relation.linked ?? true) !== reservation.linked) throw new SharingError(409, 'relation_conflict', 'Committed relationship metadata changed.');
        const operation = state.relationChanges.find(row => row.reservation.operationId === key)!;
        if (operation.phase === 'metadata_committed') { operation.phase = 'overlay_applied'; operation.hostReceipt = receipt; }
      });
      saved = savedRelationOperation(subject, reservation);
      if (receipt.phase !== 'released') {
        await associationRpc(access().host, { action: 'relation_release', reservation, associationRevision: receipt.associationRevision });
        receipt = await relationHostStatus(access().host, saved);
      }
      if (!receipt || receipt.phase !== 'released' || receipt.associationRevision !== expectedAssociationRevision) throw new BrokerError(409, 'relation_host_outcome_unknown', 'Released relation overlay could not be verified.');
      await associationChange(state => { access(); const operation = state.relationChanges.find(row => row.reservation.operationId === key)!; operation.phase = 'committed'; operation.hostReceipt = receipt; });
      return { operation: structuredClone(savedRelationOperation(subject, reservation)) };
    })();
    relationContinuations.set(key, running); void running.finally(() => relationContinuations.delete(key)).catch(() => undefined); return running;
  }
  function relationIntent(subject: string, input: import('@orchardworks/agent-remote-protocol').SessionRelationUpdate): RelationChangeReset['intent'] {
    requireOwner(subject);
    input = canonicalRelationInput(subject, input);
    if (!input.operationId || input.expectedRoleRevision === undefined) throw new SharingError(409, 'relation_operation_required', 'Retain an operation identity and current role revision for this edit.');
    const host = requireHost(input.hostId);
    const binding = brokerState.nativeBindings.get(JSON.stringify([host.id, input.providerId, input.nativeSessionId]));
    const relation = binding?.sourceRelation;
    if (!relation || relation.kind !== 'side' || relation.id !== input.id || relation.sourceNativeSessionId !== input.sourceNativeSessionId) throw new SharingError(409, 'relation_conflict', 'The immutable source relationship changed.');
    const sourceRef = relation.nativeSourceRef ?? associationSource(host, binding!.providerId, relation.sourceNativeSessionId);
    const source = brokerState.nativeBindings.get(JSON.stringify([host.id, sourceRef.providerId, sourceRef.nativeSessionId]));
    if (!enrollment || !binding || !source || !sessionAllowed(binding, subject) || !sessionAllowed(source, subject)
      || !hostAllowed(host.id, subject) || !host.providers.some(row => row.providerId === binding.providerId)) throw new SharingError(403, 'session_forbidden', 'Relation authority is unavailable.');
    return { version: 1, operationId: input.operationId, authority: enrollment, hostId: host.id, controllerId: host.installationId,
      readerRef: associationSource(host,binding.providerId,binding.nativeSessionId), sourceRef, relationId: relation.id, linked: input.linked,
      expectedRelationRevision: input.expectedRevision, expectedRoleRevision: input.expectedRoleRevision };
  }
  function assertExactRelationIntent(intent: RelationChangeReset['intent'], reservation: RelationChangeReservation | RelationChangeReset['intent']) {
    const expected = { version: 1, operationId: reservation.operationId, authority: reservation.authority, hostId: reservation.hostId, controllerId: reservation.controllerId,
      readerRef: reservation.readerRef, sourceRef: reservation.sourceRef, relationId: reservation.relationId, linked: reservation.linked,
      expectedRelationRevision: reservation.expectedRelationRevision, expectedRoleRevision: reservation.expectedRoleRevision };
    if (!isDeepStrictEqual(intent, expected)) throw new SharingError(409, 'relation_identity_conflict', 'Relationship operation identity changed.');
  }
  function assertRelationNotReset(state: BrokerAssociationState, intent: RelationChangeReset['intent']) {
    const reset = state.relationResets.find(row => row.intent.operationId === intent.operationId);
    if (reset) { assertExactRelationIntent(intent, reset.intent); throw new SharingError(409, 'relation_change_reset', 'This exact relationship edit was safely reset before any effect.'); }
  }
  async function reserveRelationUpdate(subject: string, input: import('@orchardworks/agent-remote-protocol').SessionRelationUpdate, host: Host, projection: PrimaryRole) {
    requireOwner(subject);
    const generation = host.generation; brokerState.assertHostCurrent(host);
    if (!input.operationId || input.expectedRoleRevision === undefined) throw new SharingError(409, 'relation_operation_required', 'Retain an operation identity and current role revision for this edit.');
    const intent = relationIntent(subject,input);
    assertRelationNotReset(brokerState.associations,intent);
    const previous = brokerState.associations.relationChanges.find(row => row.reservation.operationId === input.operationId);
    const sameIntent = (saved: BrokerRelationChange) => assertExactRelationIntent(intent,saved.reservation);
    if (previous) { sameIntent(previous); relationAccess(subject, previous.reservation); return continueRelationChange(subject, previous); }
    const catalogGeneration = brokerState.associations.revision;
    const described = await associationRpc(host, { action: 'describe', providerId: projection.current.providerId, nativeSessionId: projection.current.nativeSessionId });
    if (described.relationUpdates !== 1) throw new BrokerError(409, 'succession_relationship_updates_unavailable', 'Trusted relationship updates were not negotiated.');
    if (!isPrimaryRole(described.role) || described.role.id !== projection.id || described.role.revision !== input.expectedRoleRevision || nativeSessionRefKey(described.role.current) !== nativeSessionRefKey(projection.current) || !Number.isSafeInteger(described.associationRevision) || !Array.isArray(described.sourceParticipants)) throw new BrokerError(409, 'invalid_host_response', 'Current relation role could not be verified.');
    const saved = await associationChange(state => {
      brokerState.assertHostCurrent(host, generation);
      const duplicate = state.relationChanges.find(row => row.reservation.operationId === input.operationId); if (duplicate) { sameIntent(duplicate); return duplicate; }
      assertRelationNotReset(state,relationIntent(subject,input));
      if (state.revision !== catalogGeneration) throw new SharingError(409, 'relation_catalog_changed', 'Source relationship catalog changed during Host description. Retry before reserving.');
      if (state.relationChanges.length >= 1024) throw new BrokerError(409, 'association_capacity', 'Relation operation capacity is exhausted.');
      for (const ref of described.lineage as NativeSessionRef[]) assertAssociationOpen(ref);
      if (state.admissions.some(row => described.lineage.some((ref: NativeSessionRef) => nativeSessionRefKey(ref) === nativeSessionRefKey(row.source)))) throw new SharingError(409, 'association_outcome_unknown', 'Settle source creation before editing relationships.');
      const binding = brokerState.nativeBindings.get(JSON.stringify([host.id,input.providerId,input.nativeSessionId])), relation = binding?.sourceRelation;
      if (!relation || relation.id !== input.id || relation.kind !== 'side' || relation.sourceNativeSessionId !== input.sourceNativeSessionId || (relation.revision ?? 0) !== input.expectedRevision) throw new SharingError(409, 'relation_conflict', 'This side relationship changed.');
      const sourceRef = relation.nativeSourceRef ?? associationSource(host, binding!.providerId, relation.sourceNativeSessionId);
      const reservation: RelationChangeReservation = { version:1,operationId:input.operationId!,token:ids.uuid(),authority:enrollment!,hostId:host.id,controllerId:host.installationId,roleId:described.role.id,expectedRoleRevision:described.role.revision,origin:described.role.origin,current:described.role.current,lineage:described.lineage,associationRevision:described.associationRevision,catalogRevision:state.revision,
        relationId:relation.id,kind:relation.kind,readerRef:associationSource(host,binding!.providerId,binding!.nativeSessionId),sourceRef,expectedRelationRevision:input.expectedRevision,previousLinked:relation.linked??true,linked:input.linked,previousMember:described.sourceParticipants.some((row:{readerRef:NativeSessionRef})=>nativeSessionRefKey(row.readerRef)===nativeSessionRefKey(associationSource(host,binding!.providerId,binding!.nativeSessionId))),
        relations:[...brokerState.bindings.values()].filter(row=>row.hostId===host.id&&row.sourceRelation).map(row=>({relationId:row.sourceRelation!.id,kind:row.sourceRelation!.kind,readerRef:associationSource(host,row.providerId,row.nativeSessionId),sourceRef:row.sourceRelation!.nativeSourceRef??associationSource(host,row.providerId,row.sourceRelation!.sourceNativeSessionId),linked:row.sourceRelation!.linked??true,revision:row.sourceRelation!.revision??0})) };
      relationAccess(subject,reservation);
      const operation: BrokerRelationChange={reservation,phase:'reserved'};state.relationChanges.push(operation);return operation;
    }, true);
    return continueRelationChange(subject,saved);
  }

  return { currentRelationTarget, canonicalRelationInput, relationAccess, savedRelationOperation, continueRelationChange, relationIntent, assertExactRelationIntent, assertRelationNotReset, reserveRelationUpdate };
}
