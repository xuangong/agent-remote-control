import { isNativeSessionRef, isSessionSuccessionReplay, type NativeSessionRef, type SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { conversationSessionStorage } from './conversation-storage.js';
import { recoveryGeneration } from './conversation-recovery.js';
import { flushRecoveryWrites, queueRecoveryWrite, type RecoveryWriteHandle } from './recovery-writes.js';

export const COMPOSITION_CAPACITY = { slots: 1024, askOwners: 1024, roles: 128, bytes: 1048576, tracks: 8 } as const;
export interface StoreOwner { scope: string; key: string }
export interface CompositionLocator { hostId: string; native: NativeSessionRef }
export type CompositionIntent =
  | { kind: 'fixed' | 'history'; target: CompositionLocator }
  | { kind: 'legacy_fixed'; target: { hostId?: string; providerId: string; nativeSessionId: string } }
  | { kind: 'role'; roleKey: string; revision: number; target: CompositionLocator };
export interface CompositionSlot { id: string; intent: CompositionIntent; owners: { text: StoreOwner; image: StoreOwner; display: StoreOwner } }
export type CompositionParticipant = 'composition' | 'track' | 'ask' | 'draftViews';
export interface CompositionProgress { revision: number; status: 'pending' | 'applied' | 'failed' | 'conflict'; retention?: 'page' | 'session' | 'local'; code?: string }
export interface RoleCheckpoint {
  scope: string; hostId: string; controllerId: string; roleId: string;
  desired: { operationId: string; expectedRevision: number; committedRevision: number; from: NativeSessionRef; to: NativeSessionRef;
    projectionDigest: { version: 1; algorithm: 'sha256'; hex: string } };
  appliedRevision: number;
  documents: Record<CompositionParticipant, CompositionProgress>;
}
export interface CompositionDocument {
  version: 1; scope: string; editRevision: number; slots: CompositionSlot[]; roles: RoleCheckpoint[];
  edges: Array<{ source: string; target: string; selected: boolean }>;
  collapsed: string[]; address?: string; focus?: string; anchor?: string;
  retained: Array<{ slot: string; against: string }>;
}
export interface TrackCompanionDocument {
  version: 1; scope: string; editRevision: number; selected?: string;
  entries: Array<{ entryId: string; slotId: string }>;
  views: Array<{ entryId: string; primarySlot: string; selections: Record<string, string | null>; focus?: string; anchor?: string }>;
}
/** Existing suffixes are references, never renamed or inferred from an effective source. */
export interface AskAssociationOwner {
  id: string; sourceSlot: string; stateScope: string; legacySourceKey: string; geometryScope: string;
  text: StoreOwner; image?: StoreOwner; display?: StoreOwner;
  records?: Array<{ id: string; target?: string }>;
}
export interface AskOwnerIndexDocument { version: 1; scope: string; editRevision: number; owners: AskAssociationOwner[] }
export type CompositionRead<T> = { status: 'missing' } | { status: 'ready'; document: T } | { status: 'unsupported' } | { status: 'failed'; error: unknown };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const requireValue = (ok: unknown): void => { if (!ok) throw new Error('Invalid composition metadata.'); };
const native = (value: unknown): NativeSessionRef => { requireValue(isNativeSessionRef(value)); const ref = value as NativeSessionRef; return { controllerId: ref.controllerId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }; };
function owner(value: unknown): StoreOwner { requireValue(record(value) && text(value.scope) && text(value.key)); const item = value as StoreOwner; return { scope: item.scope, key: item.key }; }
function locator(value: unknown): CompositionLocator { requireValue(record(value) && text(value.hostId)); const item = value as CompositionLocator; return { hostId: item.hostId, native: native(item.native) }; }
function intent(value: unknown): CompositionIntent {
  requireValue(record(value)); const item = value as Record<string, unknown>;
  if (item.kind === 'legacy_fixed') {
    requireValue(record(item.target) && text(item.target.providerId) && text(item.target.nativeSessionId) && (item.target.hostId === undefined || text(item.target.hostId)));
    const target = item.target as { hostId?: string; providerId: string; nativeSessionId: string };
    return { kind: 'legacy_fixed', target: { providerId: target.providerId, nativeSessionId: target.nativeSessionId, ...(target.hostId === undefined ? {} : { hostId: target.hostId }) } };
  }
  const target = locator(item.target);
  if (item.kind === 'role') { requireValue(text(item.roleKey) && counter(item.revision) && Number(item.revision) > 0); return { kind: 'role', target, roleKey: item.roleKey as string, revision: item.revision as number }; }
  requireValue(item.kind === 'fixed' || item.kind === 'history'); return { kind: item.kind as 'fixed' | 'history', target };
}
function slot(value: unknown): CompositionSlot {
  requireValue(record(value) && text(value.id) && record(value.owners)); const item = value as CompositionSlot;
  return { id: item.id, intent: intent(item.intent), owners: { text: owner(item.owners.text), image: owner(item.owners.image), display: owner(item.owners.display) } };
}
function progress(value: unknown, revision: number): CompositionProgress {
  requireValue(record(value)); const item = value as CompositionProgress;
  requireValue(item.revision === revision && ['pending', 'applied', 'failed', 'conflict'].includes(item.status));
  requireValue(item.retention === undefined || ['page', 'session', 'local'].includes(item.retention));
  requireValue(item.status !== 'applied' || item.retention !== undefined);
  requireValue(item.code === undefined || (text(item.code) && item.code.length <= 128));
  return { revision, status: item.status, ...(item.retention ? { retention: item.retention } : {}), ...(item.code ? { code: item.code } : {}) };
}
function checkpoint(value: unknown, scope: string): RoleCheckpoint {
  requireValue(record(value)); const item = value as RoleCheckpoint;
  requireValue(item.scope === scope && text(item.hostId) && text(item.controllerId) && text(item.roleId) && record(item.desired) && record(item.documents));
  const desired = item.desired;
  requireValue(text(desired.operationId) && counter(desired.expectedRevision) && desired.expectedRevision > 0 && desired.committedRevision === desired.expectedRevision + 1);
  const from = native(desired.from), to = native(desired.to);
  requireValue(from.controllerId === item.controllerId && to.controllerId === item.controllerId && canonicalJson(from) !== canonicalJson(to));
  requireValue(record(desired.projectionDigest) && desired.projectionDigest.version === 1 && desired.projectionDigest.algorithm === 'sha256' && /^[a-f0-9]{64}$/.test(desired.projectionDigest.hex));
  requireValue(counter(item.appliedRevision) && item.appliedRevision <= desired.committedRevision);
  const documents = { composition: progress(item.documents.composition, desired.committedRevision), track: progress(item.documents.track, desired.committedRevision),
    ask: progress(item.documents.ask, desired.committedRevision), draftViews: progress(item.documents.draftViews, desired.committedRevision) };
  requireValue(item.appliedRevision !== desired.committedRevision || Object.values(documents).every(result => result.status === 'applied'));
  return { scope, hostId: item.hostId, controllerId: item.controllerId, roleId: item.roleId,
    desired: { operationId: desired.operationId, expectedRevision: desired.expectedRevision, committedRevision: desired.committedRevision, from, to,
      projectionDigest: { version: 1, algorithm: 'sha256', hex: desired.projectionDigest.hex } }, appliedRevision: item.appliedRevision, documents };
}
function unique(values: string[]): void { requireValue(values.every(text) && new Set(values).size === values.length); }
function optionalKeys(item: Record<string, unknown>, allowed: Set<string>, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) if (item[key] !== undefined) { requireValue(text(item[key]) && allowed.has(item[key] as string)); result[key] = item[key] as string; }
  return result;
}
function parseComposition(value: unknown, scope: string): CompositionDocument {
  requireValue(record(value)); const item = value as CompositionDocument;
  requireValue(item.version === 1 && item.scope === scope && counter(item.editRevision));
  requireValue(Array.isArray(item.slots) && item.slots.length <= COMPOSITION_CAPACITY.slots && Array.isArray(item.roles) && item.roles.length <= COMPOSITION_CAPACITY.roles);
  const slots = item.slots.map(slot), roles = item.roles.map(value => checkpoint(value, scope));
  requireValue(slots.every(slot => Object.values(slot.owners).every(owner => owner.scope === scope || owner.scope === `${scope}:ask`)));
  unique(slots.map(slot => slot.id)); unique(roles.map(compositionRoleKey)); const ids = new Set(slots.map(slot => slot.id));
  requireValue(Array.isArray(item.edges) && Array.isArray(item.collapsed) && Array.isArray(item.retained));
  const edges = item.edges.map(edge => { requireValue(record(edge) && ids.has(edge.source) && ids.has(edge.target) && typeof edge.selected === 'boolean'); return { source: edge.source, target: edge.target, selected: edge.selected }; });
  unique(item.collapsed); requireValue(item.collapsed.every(id => ids.has(id)));
  const retained = item.retained.map(entry => { requireValue(record(entry) && ids.has(entry.slot) && ids.has(entry.against) && entry.slot !== entry.against); return { slot: entry.slot, against: entry.against }; });
  unique(retained.map(entry => JSON.stringify([entry.slot, entry.against])));
  return { version: 1, scope, editRevision: item.editRevision, slots, roles, edges, collapsed: [...item.collapsed], retained,
    ...optionalKeys(item as unknown as Record<string, unknown>, ids, ['address', 'focus', 'anchor']) };
}

export function createCompositionDocument(scope: string, slots: CompositionSlot[] = []): CompositionDocument {
  return { version: 1, scope, editRevision: 0, slots: slots.map(slot), roles: [], edges: [], collapsed: [], retained: [], ...(slots[0] ? { address: slots[0].id } : {}) };
}
export function compositionRoleKey(value: Pick<RoleCheckpoint, 'scope' | 'hostId' | 'controllerId' | 'roleId'>): string { return JSON.stringify([value.scope, value.hostId, value.controllerId, value.roleId]); }
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid canonical value.');
  return JSON.stringify(value);
}
export async function createRoleCheckpoint(scope: string, replay: SessionSuccessionReplay): Promise<RoleCheckpoint> {
  if (!isSessionSuccessionReplay(replay)) throw new Error('Invalid succession replay.');
  const bytes = new TextEncoder().encode(canonicalJson(replay.projection));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const { receipt, role } = replay.projection;
  const revision = role.revision;
  return { scope, hostId: replay.to.hostId, controllerId: role.current.controllerId, roleId: role.id,
    desired: { operationId: receipt.operationId, expectedRevision: receipt.expectedRevision, committedRevision: revision,
      from: native(receipt.from), to: native(role.current), projectionDigest: { version: 1, algorithm: 'sha256', hex: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') } },
    appliedRevision: 0, documents: { composition: { revision, status: 'pending' }, track: { revision, status: 'pending' }, ask: { revision, status: 'pending' }, draftViews: { revision, status: 'pending' } } };
}

function parseTrackCompanion(value: unknown, scope: string): TrackCompanionDocument {
  requireValue(record(value)); const item = value as TrackCompanionDocument;
  requireValue(item.version === 1 && item.scope === scope && counter(item.editRevision) && Array.isArray(item.entries) && item.entries.length <= COMPOSITION_CAPACITY.tracks && Array.isArray(item.views) && item.views.length <= COMPOSITION_CAPACITY.slots);
  const entries = item.entries.map(entry => { requireValue(record(entry) && text(entry.entryId) && text(entry.slotId)); return { entryId: entry.entryId, slotId: entry.slotId }; });
  unique(entries.map(entry => entry.entryId));
  const ids = new Set(entries.map(entry => entry.entryId));
  const views = item.views.map(view => {
    requireValue(record(view) && text(view.entryId) && text(view.primarySlot) && record(view.selections));
    const selections: Record<string, string | null> = {};
    for (const [source, target] of Object.entries(view.selections)) { requireValue(text(source) && (target === null || text(target))); Object.defineProperty(selections, source, { value: target, enumerable: true, writable: true, configurable: true }); }
    requireValue((view.focus === undefined || text(view.focus)) && (view.anchor === undefined || text(view.anchor)));
    return { entryId: view.entryId, primarySlot: view.primarySlot, selections, ...(view.focus === undefined ? {} : { focus: view.focus }), ...(view.anchor === undefined ? {} : { anchor: view.anchor }) };
  });
  unique(views.map(view => view.entryId));
  return { version: 1, scope, editRevision: item.editRevision, entries, views, ...optionalKeys(item as unknown as Record<string, unknown>, ids, ['selected']) };
}
function askOwner(value: unknown): AskAssociationOwner {
  requireValue(record(value)); const item = value as AskAssociationOwner;
  requireValue([item.id, item.sourceSlot, item.stateScope, item.legacySourceKey, item.geometryScope].every(text));
  requireValue(item.records === undefined || Array.isArray(item.records) && item.records.every(value => record(value) && text(value.id) && (value.target === undefined || text(value.target))));
  return { id: item.id, sourceSlot: item.sourceSlot, stateScope: item.stateScope, legacySourceKey: item.legacySourceKey, geometryScope: item.geometryScope,
    text: owner(item.text), ...(item.image === undefined ? {} : { image: owner(item.image) }), ...(item.display === undefined ? {} : { display: owner(item.display) }),
    ...(item.records === undefined ? {} : { records: item.records.map(value => ({ id: value.id, ...(value.target === undefined ? {} : { target: value.target }) })) }) };
}
function parseAskOwnerIndex(value: unknown, scope: string): AskOwnerIndexDocument {
  requireValue(record(value)); const item = value as AskOwnerIndexDocument;
  requireValue(item.version === 1 && item.scope === scope && counter(item.editRevision) && Array.isArray(item.owners) && item.owners.length <= COMPOSITION_CAPACITY.askOwners);
  const owners = item.owners.map(askOwner); unique(owners.map(owner => owner.id));
  requireValue(owners.every(owner => owner.stateScope === scope && owner.text.scope === `${scope}:ask`
    && [owner.image, owner.display].every(value => !value || value.scope === scope || value.scope === `${scope}:ask`)));
  return { version: 1, scope, editRevision: item.editRevision, owners };
}
type MetadataName = 'composition-v1' | 'track-views-v1' | 'ask-owners-v1';
export const compositionMetadataKey = (scope: string, name: MetadataName): string => `agent-remote:recovery:${scope}:${name}`;
function readMetadata<T>(scope: string, name: MetadataName, parse: (value: unknown, scope: string) => T): CompositionRead<T> {
  const key = compositionMetadataKey(scope, name);
  try {
    flushRecoveryWrites(key);
    const raw = conversationSessionStorage.getItem(key);
    if (raw === null) return { status: 'missing' };
    requireValue(new TextEncoder().encode(raw).byteLength <= COMPOSITION_CAPACITY.bytes);
    const value: unknown = JSON.parse(raw);
    if (record(value) && value.version !== 1) return { status: 'unsupported' };
    return { status: 'ready', document: parse(value, scope) };
  } catch (error) { return { status: 'failed', error }; }
}
function saveMetadata<T extends { scope: string; editRevision: number }>(name: MetadataName, document: T, parse: (value: unknown, scope: string) => T, isCurrent: () => boolean): RecoveryWriteHandle {
  const { scope, editRevision } = document, generation = recoveryGeneration(scope);
  const key = compositionMetadataKey(scope, name);
  return queueRecoveryWrite(key, () => {
    // Refuse an unsupported or damaged document at the final storage boundary.
    const existing = conversationSessionStorage.getItem(key);
    if (existing !== null) {
      requireValue(new TextEncoder().encode(existing).byteLength <= COMPOSITION_CAPACITY.bytes);
      const previous = parse(JSON.parse(existing), scope);
      requireValue(previous.editRevision <= editRevision);
    }
    const encoded = JSON.stringify(parse(document, scope));
    requireValue(new TextEncoder().encode(encoded).byteLength <= COMPOSITION_CAPACITY.bytes);
    return encoded;
  }, { isCurrent: () => isCurrent() && generation === recoveryGeneration(scope) && document.editRevision === editRevision });
}
export const readCompositionDocument = (scope: string): CompositionRead<CompositionDocument> => readMetadata(scope, 'composition-v1', parseComposition);
export const saveCompositionDocument = (document: CompositionDocument, isCurrent: () => boolean): RecoveryWriteHandle => saveMetadata('composition-v1', document, parseComposition, isCurrent);
export const readTrackCompanion = (scope: string): CompositionRead<TrackCompanionDocument> => readMetadata(scope, 'track-views-v1', parseTrackCompanion);
export const saveTrackCompanion = (document: TrackCompanionDocument, isCurrent: () => boolean): RecoveryWriteHandle => saveMetadata('track-views-v1', document, parseTrackCompanion, isCurrent);
export const readAskOwnerIndex = (scope: string): CompositionRead<AskOwnerIndexDocument> => readMetadata(scope, 'ask-owners-v1', parseAskOwnerIndex);
export const saveAskOwnerIndex = (document: AskOwnerIndexDocument, isCurrent: () => boolean): RecoveryWriteHandle => saveMetadata('ask-owners-v1', document, parseAskOwnerIndex, isCurrent);

/** Capture each existing concrete storage key independently at first enrollment. */
export function adoptLegacySlot(id: string, session: { hostId?: string; providerId: string; nativeSessionId: string; agentId: string }, scope: string, concreteSessionKey: string): CompositionSlot {
  return { id, intent: { kind: 'legacy_fixed', target: { ...(session.hostId === undefined ? {} : { hostId: session.hostId }), providerId: session.providerId, nativeSessionId: session.nativeSessionId } },
    owners: { text: { scope, key: session.agentId }, image: { scope, key: JSON.stringify([scope, concreteSessionKey]) }, display: { scope, key: concreteSessionKey } } };
}
/** Explicit history is an independent visit, including its initially empty owners. */
export function createHistorySlot(id: string, target: CompositionLocator, scope: string): CompositionSlot {
  const key = `history:${id}`;
  return { id, intent: { kind: 'history', target: locator(target) }, owners: { text: { scope, key }, image: { scope, key: JSON.stringify([scope, key]) }, display: { scope, key } } };
}
