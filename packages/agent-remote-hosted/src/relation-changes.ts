import { isNativeSessionRef, isSuccessionAssociationAuthority, isRelationChangeReceipt, isRelationChangeReservation, relationChangeKey, type RelationChangeReceipt, type RelationChangeReservation } from '@orchardworks/agent-remote-protocol';
export interface BrokerRelationChange {
  reservation: RelationChangeReservation;
  phase: 'reserved' | 'metadata_committed' | 'overlay_applied' | 'committed';
  hostReceipt?: RelationChangeReceipt;
}
export function validBrokerRelationChange(value: unknown): value is BrokerRelationChange {
  const item = value as BrokerRelationChange;
  if (!item || Object.keys(item).some(key => !['reservation','phase','hostReceipt'].includes(key)) || !isRelationChangeReservation(item.reservation)
    || !['reserved','metadata_committed','overlay_applied','committed'].includes(item.phase)) return false;
  if (!item.hostReceipt) return item.phase === 'reserved';
  if (!isRelationChangeReceipt(item.hostReceipt) || relationChangeKey(item.hostReceipt.reservation) !== relationChangeKey(item.reservation)) return false;
  const receipt = item.hostReceipt;
  return item.phase === 'metadata_committed' ? receipt.phase === 'reserved' && receipt.associationRevision === item.reservation.associationRevision
    : ['overlay_applied','committed'].includes(item.phase) && receipt.phase !== 'reserved'
      && (item.phase !== 'committed' || receipt.phase === 'released')
      && receipt.associationRevision === item.reservation.associationRevision + Number(item.reservation.previousMember !== item.reservation.linked);
}


/** Durable denial of one exact intent before any reservation or metadata effect. */
export interface RelationChangeReset {
  version: 1;
  phase: 'pre_effect';
  intent: {
    version: 1;
    operationId: string;
    authority: import('@orchardworks/agent-remote-protocol').SuccessionAssociationAuthority;
    hostId: string;
    controllerId: string;
    readerRef: import('@orchardworks/agent-remote-protocol').NativeSessionRef;
    sourceRef: import('@orchardworks/agent-remote-protocol').NativeSessionRef;
    relationId: string;
    linked: boolean;
    expectedRelationRevision: number;
    expectedRoleRevision: number;
  };
}
export function validRelationChangeReset(value: unknown): value is RelationChangeReset {
  const reset = value as RelationChangeReset, intent = reset?.intent;
  const text = (value: unknown, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max;
  return !!reset && Object.keys(reset).length === 3 && reset.version === 1 && reset.phase === 'pre_effect'
    && !!intent && Object.keys(intent).length === 11 && intent.version === 1
    && text(intent.operationId) && isSuccessionAssociationAuthority(intent.authority)
    && text(intent.hostId,4096) && text(intent.controllerId,4096)
    && isNativeSessionRef(intent.readerRef) && isNativeSessionRef(intent.sourceRef)
    && intent.readerRef.controllerId === intent.controllerId && intent.sourceRef.controllerId === intent.controllerId
    && text(intent.relationId) && typeof intent.linked === 'boolean'
    && Number.isSafeInteger(intent.expectedRelationRevision) && intent.expectedRelationRevision >= 0 && intent.expectedRelationRevision < Number.MAX_SAFE_INTEGER
    && Number.isSafeInteger(intent.expectedRoleRevision) && intent.expectedRoleRevision > 0;
}
