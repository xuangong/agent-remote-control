import { isCommittedSuccessionProjection, isNativeSessionRef, isSuccessionAssociationFreeze, type CommittedSuccessionProjection, type NativeSessionRef, type SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
export interface BrokerAssociationState {
  version: 1;
  revision: number;
  admissions: Array<{ id: string; fingerprint: string; source: NativeSessionRef }>;
  freezes: Array<{ hostId: string; receipt: SuccessionAssociationFreeze; released?: 'committed' | 'rejected' | 'cancelled'; projection?: CommittedSuccessionProjection }>;
}
export function validBrokerAssociations(value: unknown): value is BrokerAssociationState {
  const state = value as BrokerAssociationState;
  return !!state && state.version === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.admissions) && state.admissions.length <= 4096
    && state.admissions.every(item => typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 512 && typeof item.fingerprint === 'string' && item.fingerprint.length <= 512 && isNativeSessionRef(item.source))
    && new Set(state.admissions.map(item => item.id)).size === state.admissions.length
    && Array.isArray(state.freezes) && state.freezes.length <= 1024
    && state.freezes.every(item => typeof item.hostId === 'string' && item.hostId.length > 0 && isSuccessionAssociationFreeze(item.receipt)
      && (item.released === undefined || ['committed', 'rejected', 'cancelled'].includes(item.released))
      && (item.released === 'committed' ? isCommittedSuccessionProjection(item.projection) && item.projection!.receipt.operationId === item.receipt.request.operationId : item.projection === undefined))
    && new Set(state.freezes.map(item => item.receipt.token)).size === state.freezes.length;
}
