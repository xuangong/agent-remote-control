import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { NativeSessionRef, nativeSessionRefKey } from './session-succession.js';
import { SuccessionAssociationAuthority, SuccessionAssociationRelation, successionAuthorityKey } from './succession-enrollment.js';
const object = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 512 });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Data accepted only through a negotiated authenticated Host connection. */
export const RelationChangeReservation = Type.Object({ version: Type.Literal(1), operationId: id, token: id,
  authority: SuccessionAssociationAuthority, hostId: id, controllerId: id, roleId: id,
  expectedRoleRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), origin: NativeSessionRef, current: NativeSessionRef,
  lineage: Type.Array(NativeSessionRef, { minItems: 1, maxItems: 513 }), associationRevision: counter, catalogRevision: counter,
  relationId: id, kind: Type.Union([Type.Literal('side'), Type.Literal('ask')]), readerRef: NativeSessionRef, sourceRef: NativeSessionRef,
  expectedRelationRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }), previousLinked: Type.Boolean(), linked: Type.Boolean(), previousMember: Type.Boolean(),
  relations: Type.Array(SuccessionAssociationRelation, { maxItems: 4096 }) }, object);
export type RelationChangeReservation = Static<typeof RelationChangeReservation>;
export const RelationChangeReceipt = Type.Object({ reservation: RelationChangeReservation,
  phase: Type.Union([Type.Literal('reserved'), Type.Literal('applied'), Type.Literal('released')]), associationRevision: counter }, object);
export type RelationChangeReceipt = Static<typeof RelationChangeReceipt>;
export function isRelationChangeReservation(value: unknown): value is RelationChangeReservation {
  if (!Value.Check(RelationChangeReservation, value)) return false;
  const item = value as RelationChangeReservation, key = nativeSessionRefKey;
  const refs = [item.origin, item.current, item.readerRef, item.sourceRef, ...item.lineage, ...item.relations.flatMap(row => [row.readerRef, row.sourceRef])];
  const selected = item.relations.filter(row => row.relationId === item.relationId && key(row.readerRef) === key(item.readerRef));
  return refs.every(ref => ref.controllerId === item.controllerId)
    && new Set(item.lineage.map(key)).size === item.lineage.length
    && item.lineage.some(ref => key(ref) === key(item.origin)) && item.lineage.some(ref => key(ref) === key(item.current))
    && item.lineage.some(ref => key(ref) === key(item.sourceRef))
    && new Set(item.relations.map(row => key(row.readerRef))).size === item.relations.length
    && selected.length === 1 && selected[0]!.kind === item.kind && key(selected[0]!.sourceRef) === key(item.sourceRef)
    && selected[0]!.linked === item.previousLinked && selected[0]!.revision === item.expectedRelationRevision;
}
export const isRelationChangeReceipt = (value: unknown): value is RelationChangeReceipt => Value.Check(RelationChangeReceipt, value)
  && isRelationChangeReservation((value as RelationChangeReceipt).reservation);
/** Canonical tuples ignore object property insertion order while retaining exact catalog evidence. */
export const relationChangeKey = (item: RelationChangeReservation): string => JSON.stringify([
  item.version, item.operationId, item.token, successionAuthorityKey(item.authority), item.hostId, item.controllerId,
  item.roleId, item.expectedRoleRevision, nativeSessionRefKey(item.origin), nativeSessionRefKey(item.current), item.lineage.map(nativeSessionRefKey),
  item.associationRevision, item.catalogRevision, item.relationId, item.kind, nativeSessionRefKey(item.readerRef), nativeSessionRefKey(item.sourceRef),
  item.expectedRelationRevision, item.previousLinked, item.linked, item.previousMember,
  item.relations.map(row => [row.relationId, row.kind, nativeSessionRefKey(row.readerRef), nativeSessionRefKey(row.sourceRef), row.linked, row.revision]),
]);
