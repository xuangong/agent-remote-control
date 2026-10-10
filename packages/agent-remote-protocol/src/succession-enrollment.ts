import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { NativeSessionRef, SuccessionRequest, nativeSessionRefKey } from './session-succession.js';
const object = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 512 });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Opt-in handshake authority; supplied only by the authenticated Relay connection. */
export const SuccessionAssociationAuthority = Type.Object({ version: Type.Literal(1), origin: id, issuer: id, namespace: id, ownerSubject: id }, object);
export type SuccessionAssociationAuthority = Static<typeof SuccessionAssociationAuthority>;
export const SuccessionAssociationRelation = Type.Object({ relationId: id, kind: Type.Union([Type.Literal('side'), Type.Literal('ask')]),
  readerRef: NativeSessionRef, sourceRef: NativeSessionRef, linked: Type.Boolean(), revision: counter }, object);
export type SuccessionAssociationRelation = Static<typeof SuccessionAssociationRelation>;
export const SuccessionAssociationFreeze = Type.Object({ version: Type.Literal(1), token: id, authority: SuccessionAssociationAuthority,
  controllerId: id, request: SuccessionRequest, associationRevision: counter,
  lineage: Type.Array(NativeSessionRef, { minItems: 1, maxItems: 513 }),
  relations: Type.Array(SuccessionAssociationRelation, { maxItems: 4096 }) }, object);
export type SuccessionAssociationFreeze = Static<typeof SuccessionAssociationFreeze>;
export const isSuccessionAssociationAuthority = (value: unknown): value is SuccessionAssociationAuthority => Value.Check(SuccessionAssociationAuthority, value);
export const isSuccessionAssociationFreeze = (value: unknown): value is SuccessionAssociationFreeze => {
  if (!Value.Check(SuccessionAssociationFreeze, value)) return false;
  const item = value as SuccessionAssociationFreeze;
  const refs = [item.request.from, ...item.lineage, ...item.relations.flatMap(relation => [relation.readerRef, relation.sourceRef])];
  return refs.every(ref => ref.controllerId === item.controllerId)
    && item.lineage.some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(item.request.from))
    && new Set(item.lineage.map(nativeSessionRefKey)).size === item.lineage.length
    && new Set(item.relations.map(relation => nativeSessionRefKey(relation.readerRef))).size === item.relations.length;
};
export interface TrustedSuccessionContext { authority: SuccessionAssociationAuthority; installationId: string }
export const successionAuthorityKey = (authority: SuccessionAssociationAuthority): string => JSON.stringify([
  authority.version, authority.origin, authority.issuer, authority.namespace, authority.ownerSubject,
]);
export const successionFreezeKey = (freeze: SuccessionAssociationFreeze): string => JSON.stringify([
  freeze.version, freeze.token, successionAuthorityKey(freeze.authority), freeze.controllerId,
  freeze.request.operationId, freeze.request.roleId, freeze.request.expectedRevision, nativeSessionRefKey(freeze.request.from),
  freeze.request.targetProviderId ?? freeze.request.from.providerId, freeze.associationRevision,
  freeze.lineage.map(nativeSessionRefKey), freeze.relations.map(relation => [relation.relationId, relation.kind,
    nativeSessionRefKey(relation.readerRef), nativeSessionRefKey(relation.sourceRef), relation.linked, relation.revision]),
]);
