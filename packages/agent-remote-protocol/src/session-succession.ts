import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const object = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 512, pattern: '^[^\\u0000-\\u001f]+$' });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const NativeSessionRef = Type.Object({ controllerId: id, providerId: id, nativeSessionId: id }, object);
export type NativeSessionRef = Static<typeof NativeSessionRef>;
export const SuccessionWorkspace = Type.Object({ controllerId: id, canonicalCwd: Type.String({ minLength: 1, maxLength: 4096 }) }, object);
export const PrimaryRole = Type.Object({ id, revision, origin: NativeSessionRef, current: NativeSessionRef, workspace: SuccessionWorkspace }, object);
export type PrimaryRole = Static<typeof PrimaryRole>;
export const SourceBinding = Type.Union([
  Type.Object({ kind: Type.Literal('fixed'), source: NativeSessionRef }, object),
  Type.Object({ kind: Type.Literal('primary_role'), roleId: id, origin: NativeSessionRef }, object),
]);
export type SourceBinding = Static<typeof SourceBinding>;
const request = { operationId: id, roleId: id, expectedRevision: revision, from: NativeSessionRef };
export const SuccessionRequest = Type.Object(request, object);
export type SuccessionRequest = Static<typeof SuccessionRequest>;
export const SuccessionParticipant = Type.Object({ relationId: id,
  kind: Type.Union([Type.Literal('side'), Type.Literal('ask'), Type.Literal('tpm')]), before: NativeSessionRef, after: NativeSessionRef }, object);
export type SuccessionParticipant = Static<typeof SuccessionParticipant>;
export const PreparedSuccession = Type.Object({ ...request, associationRevision: counter,
  to: NativeSessionRef, workspace: SuccessionWorkspace,
  participants: Type.Array(SuccessionParticipant, { maxItems: 1024 }),
  capture: Type.Object({ epoch: id, seq: counter, capturedAt: id }, object),
}, object);
export type PreparedSuccession = Static<typeof PreparedSuccession>;
export const SuccessionPhase = Type.Union((['preparing', 'quiescing', 'transferring', 'ready', 'committed', 'unknown', 'rejected', 'cancelled'] as const).map(value => Type.Literal(value)));
export type SuccessionPhase = Static<typeof SuccessionPhase>;
export const SuccessionRecord = Type.Object({ ...request, phase: SuccessionPhase,
  startedAt: id, updatedAt: id, to: Type.Optional(NativeSessionRef), prepared: Type.Optional(PreparedSuccession),
  resumePhase: Type.Optional(Type.Union((['preparing', 'quiescing', 'transferring', 'ready'] as const).map(value => Type.Literal(value)))),
  failureCode: Type.Optional(id), committedRevision: Type.Optional(revision),
}, object);
export type SuccessionRecord = Static<typeof SuccessionRecord>;
export const isPrimaryRole = (value: unknown): value is PrimaryRole => Value.Check(PrimaryRole, value);
export const isSourceBinding = (value: unknown): value is SourceBinding => Value.Check(SourceBinding, value);
export const isSuccessionRequest = (value: unknown): value is SuccessionRequest => Value.Check(SuccessionRequest, value);
export const isPreparedSuccession = (value: unknown): value is PreparedSuccession => Value.Check(PreparedSuccession, value);
export const isSuccessionRecord = (value: unknown): value is SuccessionRecord => Value.Check(SuccessionRecord, value);
export const nativeSessionRefKey = (ref: NativeSessionRef): string => JSON.stringify([ref.controllerId, ref.providerId, ref.nativeSessionId]);
