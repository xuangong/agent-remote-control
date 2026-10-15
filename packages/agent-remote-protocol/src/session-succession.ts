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
export const NativePrefixSelection = Type.Object({ kind: Type.Literal('native_prefix'), turnId: id, messageId: id }, object);
export type NativePrefixSelection = Static<typeof NativePrefixSelection>;
export const isNativePrefixSelection = (value: unknown): value is NativePrefixSelection => Value.Check(NativePrefixSelection, value);
export const nativePrefixSelectionKey = (selection: NativePrefixSelection | undefined): string | undefined => selection && JSON.stringify([selection.kind, selection.turnId, selection.messageId]);
const request = { preparation: Type.Optional(NativePrefixSelection), operationId: id, roleId: id, expectedRevision: revision, from: NativeSessionRef, targetProviderId: Type.Optional(id) };
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
/** A current observation only; preparation must recheck every eligibility fact. */
export const SuccessionDescription = Type.Object({
  role: PrimaryRole,
  targets: Type.Array(Type.Object({ providerId: id, displayName: id }, object), { maxItems: 128 }),
  eligibility: Type.Union([
    Type.Object({ status: Type.Literal('ready') }, object),
    Type.Object({ status: Type.Union([Type.Literal('blocked'), Type.Literal('unavailable')]), code: id,
      reason: Type.String({ minLength: 1, maxLength: 4096 }) }, object),
  ]),
}, object);
export type SuccessionDescription = Static<typeof SuccessionDescription>;
/** A current Host observation. Frozen succession receipts never retain delivery state. */
export const SuccessionContextStatus = Type.Object({ operationId: id, target: NativeSessionRef,
  state: Type.Union((['pending', 'dispatching', 'accepted', 'unknown', 'materialized'] as const).map(value => Type.Literal(value))),
}, object);
export type SuccessionContextStatus = Static<typeof SuccessionContextStatus>;
export const SuccessionActionResult = Type.Object({ record: SuccessionRecord, role: PrimaryRole,
  locator: Type.Optional(Type.Object({ hostId: id, providerId: id, nativeSessionId: id }, object)),
  context: Type.Optional(SuccessionContextStatus),
}, object);
export type SuccessionActionResult = Static<typeof SuccessionActionResult>;
export const isSuccessionDescription = (value: unknown): value is SuccessionDescription => Value.Check(SuccessionDescription, value);
export const isSuccessionActionResult = (value: unknown): value is SuccessionActionResult => {
  if (!Value.Check(SuccessionActionResult, value)) return false;
  const { record, context } = value as SuccessionActionResult;
  return isSuccessionRecord(record) && (!context || !record.preparation && record.phase === 'committed' && !!record.to && context.operationId === record.operationId && nativeSessionRefKey(context.target) === nativeSessionRefKey(record.to));
};
export const isNativeSessionRef = (value: unknown): value is NativeSessionRef => Value.Check(NativeSessionRef, value);
export const isPrimaryRole = (value: unknown): value is PrimaryRole => Value.Check(PrimaryRole, value);
export const isSourceBinding = (value: unknown): value is SourceBinding => Value.Check(SourceBinding, value);
const validPreparation = (value: SuccessionRequest): boolean => !value.preparation || value.targetProviderId === undefined || value.targetProviderId === value.from.providerId;
export const isSuccessionRequest = (value: unknown): value is SuccessionRequest => Value.Check(SuccessionRequest, value) && validPreparation(value as SuccessionRequest);
export const isPreparedSuccession = (value: unknown): value is PreparedSuccession => Value.Check(PreparedSuccession, value) && validPreparation(value as PreparedSuccession) && (!(value as PreparedSuccession).preparation || (value as PreparedSuccession).to.providerId === (value as PreparedSuccession).from.providerId);
export const isSuccessionParticipant = (value: unknown): value is SuccessionParticipant => Value.Check(SuccessionParticipant, value);
export const isSuccessionRecord = (value: unknown): value is SuccessionRecord => Value.Check(SuccessionRecord, value) && validPreparation(value as SuccessionRecord)
  && (!(value as SuccessionRecord).prepared || isPreparedSuccession((value as SuccessionRecord).prepared) && nativePrefixSelectionKey((value as SuccessionRecord).preparation) === nativePrefixSelectionKey((value as SuccessionRecord).prepared!.preparation))
  && (!(value as SuccessionRecord).preparation || !(value as SuccessionRecord).to || (value as SuccessionRecord).to!.providerId === (value as SuccessionRecord).from.providerId);
export const nativeSessionRefKey = (ref: NativeSessionRef): string => JSON.stringify([ref.controllerId, ref.providerId, ref.nativeSessionId]);

export const CommittedSuccessionProjection = Type.Object({ version: Type.Literal(1), role: PrimaryRole, receipt: SuccessionRecord }, object);
export type CommittedSuccessionProjection = Static<typeof CommittedSuccessionProjection>;
/** Structural schemas alone cannot certify the role/receipt relationship. */
export const isCommittedSuccessionProjection = (value: unknown): value is CommittedSuccessionProjection => {
  if (!Value.Check(CommittedSuccessionProjection, value)) return false;
  const { role, receipt } = value as CommittedSuccessionProjection;
  if (!isSuccessionRecord(receipt) || !receipt.to || !receipt.prepared) return false;
  return nativeSessionRefKey(receipt.from) !== nativeSessionRefKey(receipt.to)
    && receipt.prepared!.targetProviderId === receipt.targetProviderId
    && receipt.to!.providerId === (receipt.targetProviderId ?? receipt.from.providerId)
    && receipt.phase === 'committed' && !!receipt.to && !!receipt.prepared && receipt.resumePhase === undefined
    && role.id === receipt.roleId && role.revision === receipt.committedRevision && role.revision === receipt.expectedRevision + 1
    && nativeSessionRefKey(role.current) === nativeSessionRefKey(receipt.to)
    && nativeSessionRefKey(receipt.prepared.from) === nativeSessionRefKey(receipt.from)
    && nativeSessionRefKey(receipt.prepared.to) === nativeSessionRefKey(receipt.to)
    && receipt.prepared.operationId === receipt.operationId && receipt.prepared.roleId === receipt.roleId && receipt.prepared.expectedRevision === receipt.expectedRevision
    && role.workspace.controllerId === role.current.controllerId && receipt.from.controllerId === role.current.controllerId
    && receipt.prepared.workspace.controllerId === role.workspace.controllerId && receipt.prepared.workspace.canonicalCwd === role.workspace.canonicalCwd;
};


export interface NativePrefixResolution {
  anchor: NativeSessionRef;
  target: NativeSessionRef;
  operationIds: readonly string[];
}
/** Validate complete committed role histories before deriving execution authority. */
function nativePrefixEdges(committed: readonly SuccessionRecord[]) {
  const groups = new Map<string, SuccessionRecord[]>(), owners = new Map<string, string>(), operations = new Set<string>();
  const forward = new Map<string, SuccessionRecord>(), reverse = new Map<string, SuccessionRecord>();
  const unavailable = () => { throw new Error('Native prefix execution routing is unavailable: invalid committed lineage.'); };
  for (const receipt of committed) {
    if (!isSuccessionRecord(receipt) || receipt.phase !== 'committed' || operations.has(receipt.operationId)) unavailable();
    operations.add(receipt.operationId);
    const rows = groups.get(receipt.roleId) ?? []; rows.push(receipt); groups.set(receipt.roleId, rows);
  }
  for (const [roleId, rows] of groups) {
    rows.sort((a, b) => a.expectedRevision - b.expectedRevision);
    const origin = rows[0]!.from, workspace = rows[0]!.prepared?.workspace;
    if (!workspace || rows.length > 512) unavailable();
    const visited = new Set<string>([nativeSessionRefKey(origin)]);
    let current = origin;
    for (let index = 0; index < rows.length; index++) {
      const receipt = rows[index]!;
      if (!receipt.to || !isCommittedSuccessionProjection({ version: 1, role: { id: roleId, origin, current: receipt.to, workspace, revision: index + 2 }, receipt })
        || receipt.expectedRevision !== index + 1 || nativeSessionRefKey(receipt.from) !== nativeSessionRefKey(current)
        || visited.has(nativeSessionRefKey(receipt.to))) unavailable();
      const target = receipt.to!;
      for (const ref of [receipt.from, target]) {
        const key = nativeSessionRefKey(ref), owner = owners.get(key);
        if (owner !== undefined && owner !== roleId) unavailable();
        owners.set(key, roleId);
      }
      forward.set(nativeSessionRefKey(receipt.from), receipt); reverse.set(nativeSessionRefKey(target), receipt);
      visited.add(nativeSessionRefKey(target)); current = target;
    }
  }
  return { forward, reverse };
}
export function resolveNativePrefix(anchor: NativeSessionRef, committed: readonly SuccessionRecord[]): NativePrefixResolution {
  if (!isNativeSessionRef(anchor)) throw new Error('Native prefix execution routing is unavailable: invalid anchor.');
  const { forward } = nativePrefixEdges(committed), operationIds: string[] = [];
  let target = anchor;
  for (let edge = forward.get(nativeSessionRefKey(target)); edge; edge = forward.get(nativeSessionRefKey(target))) {
    if (!edge.preparation) throw new Error('Native prefix execution routing is unavailable across generic succession.');
    operationIds.push(edge.operationId); target = edge.to!;
  }
  return { anchor: { ...anchor }, target: { ...target }, operationIds };
}
/** Inclusive ancestry, ordered from the oldest verified anchor to the target. */
export function nativePrefixAncestors(target: NativeSessionRef, committed: readonly SuccessionRecord[]): readonly NativeSessionRef[] {
  if (!isNativeSessionRef(target)) throw new Error('Native prefix execution routing is unavailable: invalid target.');
  const { reverse } = nativePrefixEdges(committed), ancestors = [target];
  let current = target;
  for (let edge = reverse.get(nativeSessionRefKey(current)); edge; edge = reverse.get(nativeSessionRefKey(current))) {
    if (!edge.preparation) throw new Error('Native prefix execution routing is unavailable across generic succession.');
    current = edge.from; ancestors.unshift(current);
  }
  return ancestors.map(ref => ({ ...ref }));
}
