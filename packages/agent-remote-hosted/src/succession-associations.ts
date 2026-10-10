import { validRelationChangeReset, validBrokerRelationChange, type RelationChangeReset, type BrokerRelationChange } from './relation-changes.js';
import { isCommittedSuccessionProjection, isNativeSessionRef, isSuccessionAssociationFreeze, type CommittedSuccessionProjection, type NativeSessionRef, type SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
export interface BrokerAssociationState {
  version: 3;
  relationResets: RelationChangeReset[];
  relationChanges: BrokerRelationChange[];
  revision: number;
  admissions: Array<{ id: string; fingerprint: string; source: NativeSessionRef }>;
  freezes: Array<{ hostId: string; receipt: SuccessionAssociationFreeze; released?: 'committed' | 'rejected' | 'cancelled'; projection?: CommittedSuccessionProjection }>;
}
export function validBrokerAssociations(value: unknown): value is BrokerAssociationState {
  const state = value as BrokerAssociationState;
  return !!state && state.version === 3 && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.relationResets) && state.relationResets.length <= 1024 && state.relationResets.every(validRelationChangeReset)
    && new Set(state.relationResets.map(item => item.intent.operationId)).size === state.relationResets.length
    && Array.isArray(state.relationChanges) && state.relationChanges.length <= 1024 && state.relationChanges.every(validBrokerRelationChange)
    && state.relationResets.every(reset => !state.relationChanges.some(item => item.reservation.operationId === reset.intent.operationId))
    && new Set(state.relationChanges.map(item => item.reservation.operationId)).size === state.relationChanges.length
    && new Set(state.relationChanges.filter(item => item.phase !== 'committed').map(item => item.reservation.roleId)).size === state.relationChanges.filter(item => item.phase !== 'committed').length
    && Array.isArray(state.admissions) && state.admissions.length <= 4096
    && state.admissions.every(item => typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 512 && typeof item.fingerprint === 'string' && item.fingerprint.length <= 512 && isNativeSessionRef(item.source))
    && new Set(state.admissions.map(item => item.id)).size === state.admissions.length
    && Array.isArray(state.freezes) && state.freezes.length <= 1024
    && state.freezes.every(item => typeof item.hostId === 'string' && item.hostId.length > 0 && isSuccessionAssociationFreeze(item.receipt)
      && (item.released === undefined || ['committed', 'rejected', 'cancelled'].includes(item.released))
      && (item.released === 'committed' ? isCommittedSuccessionProjection(item.projection) && item.projection!.receipt.operationId === item.receipt.request.operationId : item.projection === undefined))
    && new Set(state.freezes.map(item => item.receipt.token)).size === state.freezes.length;
}

/** Explicit additive migration; old writers must reject the resulting version. */
export function migrateBrokerAssociations(value: unknown): BrokerAssociationState {
  const legacy = value as { version: number; relationChanges?: unknown; relationResets?: unknown };
  let candidate = structuredClone(legacy);
  if (legacy?.version === 1 && !Object.hasOwn(legacy, 'relationChanges') && !Object.hasOwn(legacy, 'relationResets')) {
    candidate = { ...candidate, version: 2, relationChanges: [] };
  }
  if (candidate?.version === 2 && !Object.hasOwn(candidate, 'relationResets')) {
    candidate = { ...candidate, version: 3, relationResets: [] };
  }
  if (!validBrokerAssociations(candidate)) throw new Error('Invalid durable association state.');
  return candidate;
}
