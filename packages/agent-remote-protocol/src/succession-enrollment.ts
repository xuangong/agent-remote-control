import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { NativeSessionRef, SuccessionRequest, nativeSessionRefKey, nativePrefixSelectionKey, isSuccessionRequest } from './session-succession.js';
const object = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 512 });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Opt-in handshake authority; supplied only by the authenticated Relay connection. */
export const SuccessionAssociationAuthority = Type.Object({ version: Type.Literal(1), origin: id, issuer: id, namespace: id, ownerSubject: id }, object);
export type SuccessionAssociationAuthority = Static<typeof SuccessionAssociationAuthority>;
export const SuccessionAssociationRelation = Type.Object({ relationId: id, kind: Type.Union([Type.Literal('side'), Type.Literal('ask')]),
  readerRef: NativeSessionRef, sourceRef: NativeSessionRef, linked: Type.Boolean(), revision: counter }, object);
export type SuccessionAssociationRelation = Static<typeof SuccessionAssociationRelation>;
const freeze = { token: id, authority: SuccessionAssociationAuthority,
  controllerId: id, request: SuccessionRequest, associationRevision: counter,
  lineage: Type.Array(NativeSessionRef, { minItems: 1, maxItems: 513 }),
  relations: Type.Array(SuccessionAssociationRelation, { maxItems: 4096 }) };
export const LegacySuccessionAssociationFreeze = Type.Object({ version: Type.Literal(1), ...freeze }, object);
export type LegacySuccessionAssociationFreeze = Static<typeof LegacySuccessionAssociationFreeze>;
/** Exact UTF-8 bytes of JSON.stringify({version:1,role,receipt}); immutable per operation. */
export const BoundedSuccessionAssociationFreeze = Type.Object({ version: Type.Literal(2), ...freeze,
  maxProjectionBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, object);
export type BoundedSuccessionAssociationFreeze = Static<typeof BoundedSuccessionAssociationFreeze>;
export const SuccessionAssociationFreeze = Type.Union([LegacySuccessionAssociationFreeze, BoundedSuccessionAssociationFreeze]);
export type SuccessionAssociationFreeze = Static<typeof SuccessionAssociationFreeze>;
export const isSuccessionAssociationAuthority = (value: unknown): value is SuccessionAssociationAuthority => Value.Check(SuccessionAssociationAuthority, value);
export const isSuccessionAssociationFreeze = (value: unknown): value is SuccessionAssociationFreeze => {
  if (!Value.Check(SuccessionAssociationFreeze, value)) return false;
  const item = value as SuccessionAssociationFreeze;
  const refs = [item.request.from, ...item.lineage, ...item.relations.flatMap(relation => [relation.readerRef, relation.sourceRef])];
  return isSuccessionRequest(item.request) && !item.request.preparation && refs.every(ref => ref.controllerId === item.controllerId)
    && item.lineage.some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(item.request.from))
    && new Set(item.lineage.map(nativeSessionRefKey)).size === item.lineage.length
    && new Set(item.relations.map(relation => nativeSessionRefKey(relation.readerRef))).size === item.relations.length;
};
export interface TrustedSuccessionContext { authority: SuccessionAssociationAuthority; installationId: string; successionEnrollmentVersion: 1 | 2 }
export const successionAuthorityKey = (authority: SuccessionAssociationAuthority): string => JSON.stringify([
  authority.version, authority.origin, authority.issuer, authority.namespace, authority.ownerSubject,
]);
export const successionFreezeKey = (freeze: SuccessionAssociationFreeze): string => {
  const identity: unknown[] = [
    freeze.version, freeze.token, successionAuthorityKey(freeze.authority), freeze.controllerId,
    freeze.request.operationId, freeze.request.roleId, freeze.request.expectedRevision, nativeSessionRefKey(freeze.request.from),
    freeze.request.targetProviderId ?? freeze.request.from.providerId, freeze.associationRevision,
    freeze.lineage.map(nativeSessionRefKey), freeze.relations.map(relation => [relation.relationId, relation.kind,
      nativeSessionRefKey(relation.readerRef), nativeSessionRefKey(relation.sourceRef), relation.linked, relation.revision]),
  ];
  // Preserve the historical v1 array exactly; only v2 adds allowance identity.
  if (freeze.version === 2) identity.push(freeze.maxProjectionBytes);
  if (freeze.request.preparation) identity.push(nativePrefixSelectionKey(freeze.request.preparation));
  return JSON.stringify(identity);
};
