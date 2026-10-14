import { isNativeSessionRef, isSessionSuccessionReplay, type NativeSessionRef, type SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage, conversationSessionStorage } from './conversation-storage.js';
import { recoveryGeneration } from './conversation-recovery.js';
import { flushRecoveryWrites, queueRecoveryWrite, type RecoveryWriteHandle } from './recovery-writes.js';
import type { OpenedSession } from './directory-client.js';
import { sessionKey, type SessionEntry } from './session-tree.js';
import { parseCompositionWindows, type CompositionWindow } from './composition-views.js';

export const COMPOSITION_CAPACITY = { slots: 1024, askOwners: 1024, roles: 128, bytes: 1048576, tracks: 8 } as const;
export interface StoreOwner { scope: string; key: string }
/** A concrete native address can be selected before its Controller is observed. */
export interface CompositionLocator { hostId: string; native: Omit<NativeSessionRef, 'controllerId'> & { controllerId?: string } }
export type CompositionIntent =
  | { kind: 'fixed' | 'history'; target: CompositionLocator }
  | { kind: 'role'; roleKey: string; revision: number; target: { hostId: string; native: NativeSessionRef } };
export interface CompositionSlot {
  id: string; origin: { kind: 'fixed' | 'history'; target: CompositionLocator }; intent: CompositionIntent;
  metadata?: Pick<OpenedSession, 'title' | 'parentAgentId' | 'parentNativeSessionId' | 'createdAt'> & { agentId?: string };
  owners: { text: StoreOwner; image: StoreOwner; display: StoreOwner };
}
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
  version: 2; scope: string; editRevision: number; slots: CompositionSlot[]; roles: RoleCheckpoint[];
  edges: Array<{ source: string; target: string; selected: boolean }>;
  collapsed: string[]; primary?: string; address?: string; focus?: string; anchor?: string;
  retained: Array<{ slot: string; against: string }>;
  tracks: CompositionTrack[]; selectedTrack?: string; asks: AskAssociationOwner[];
  windows?: CompositionWindow[]; activeWindow?: string;
}
export interface CompositionTrack {
  entryId: string; slotId: string;
  view?: { primarySlot: string; selections: Record<string, string | null>; focus?: string; anchor?: string };
}
/** Payloads remain in their existing stores; these are explicit storage pointers. */
export interface AskAssociationOwner {
  id: string; sourceSlot: string; input: StoreOwner; geometryScope: string;
  text: StoreOwner; image?: StoreOwner; display?: StoreOwner; open: boolean; enabled?: boolean;
  records?: Array<{ id: string; target?: string }>;
}
export type CompositionRead<T> = { status: 'missing' } | { status: 'ready'; document: T } | { status: 'unsupported' } | { status: 'failed'; error: unknown };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const requireValue = (ok: unknown): void => { if (!ok) throw new Error('Invalid composition metadata.'); };
const native = (value: unknown): NativeSessionRef => { requireValue(isNativeSessionRef(value)); const ref = value as NativeSessionRef; return { controllerId: ref.controllerId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }; };
function owner(value: unknown): StoreOwner { requireValue(record(value) && text(value.scope) && text(value.key)); const item = value as StoreOwner; return { scope: item.scope, key: item.key }; }
function locator(value: unknown): CompositionLocator {
  requireValue(record(value) && text(value.hostId)); const item = value as CompositionLocator;
  requireValue(record(item.native) && text(item.native.providerId) && text(item.native.nativeSessionId) && (item.native.controllerId === undefined || text(item.native.controllerId)));
  return { hostId: item.hostId, native: { providerId: item.native.providerId, nativeSessionId: item.native.nativeSessionId, ...(item.native.controllerId ? { controllerId: item.native.controllerId } : {}) } };
}
function intent(value: unknown): CompositionIntent {
  requireValue(record(value)); const item = value as Record<string, unknown>;
  const target = locator(item.target);
  if (item.kind === 'role') { requireValue(text(item.roleKey) && counter(item.revision) && Number(item.revision) > 0); return { kind: 'role', target: { hostId: target.hostId, native: native(target.native) }, roleKey: item.roleKey as string, revision: item.revision as number }; }
  requireValue(item.kind === 'fixed' || item.kind === 'history'); return { kind: item.kind as 'fixed' | 'history', target };
}
function slot(value: unknown): CompositionSlot {
  requireValue(record(value) && text(value.id) && record(value.owners)); const item = value as CompositionSlot;
  const metadata = item.metadata;
  if (metadata) requireValue(record(metadata) && (metadata.agentId === undefined || text(metadata.agentId)) && typeof metadata.title === 'string'
    && ['parentAgentId', 'parentNativeSessionId', 'createdAt'].every(key => metadata[key as keyof typeof metadata] === undefined || typeof metadata[key as keyof typeof metadata] === 'string'));
  const origin = intent(item.origin), current = intent(item.intent);
  requireValue(origin.kind !== 'role' && (origin.kind === 'history') === (current.kind === 'history'));
  return { id: item.id, origin: origin as CompositionSlot['origin'], intent: current, owners: { text: owner(item.owners.text), image: owner(item.owners.image), display: owner(item.owners.display) },
    ...(metadata ? { metadata: { ...(metadata.agentId ? { agentId: metadata.agentId } : {}), title: metadata.title, ...Object.fromEntries(['parentAgentId', 'parentNativeSessionId', 'createdAt'].filter(key => metadata[key as keyof typeof metadata] !== undefined).map(key => [key, metadata[key as keyof typeof metadata]])) } } : {}) };
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
export function parseComposition(value: unknown, scope: string): CompositionDocument {
  requireValue(record(value)); const item = value as CompositionDocument;
  requireValue(item.version === 2 && item.scope === scope && counter(item.editRevision));
  requireValue(Array.isArray(item.slots) && item.slots.length <= COMPOSITION_CAPACITY.slots && Array.isArray(item.roles) && item.roles.length <= COMPOSITION_CAPACITY.roles);
  const slots = item.slots.map(slot), roles = item.roles.map(value => checkpoint(value, scope));
  requireValue(slots.every(slot => Object.values(slot.owners).every(owner => owner.scope === scope || owner.scope === `${scope}:ask`)));
  unique(slots.map(slot => slot.id)); unique(roles.map(compositionRoleKey)); const ids = new Set(slots.map(slot => slot.id));
  requireValue(Array.isArray(item.edges) && Array.isArray(item.collapsed) && Array.isArray(item.retained));
  const edges = item.edges.map(edge => { requireValue(record(edge) && ids.has(edge.source) && ids.has(edge.target) && typeof edge.selected === 'boolean'); return { source: edge.source, target: edge.target, selected: edge.selected }; });
  unique(item.collapsed); requireValue(item.collapsed.every(id => ids.has(id)));
  const retained = item.retained.map(entry => { requireValue(record(entry) && ids.has(entry.slot) && ids.has(entry.against) && entry.slot !== entry.against); return { slot: entry.slot, against: entry.against }; });
  unique(retained.map(entry => JSON.stringify([entry.slot, entry.against])));
  requireValue(Array.isArray(item.asks) && item.asks.length <= COMPOSITION_CAPACITY.askOwners && Array.isArray(item.tracks) && item.tracks.length <= COMPOSITION_CAPACITY.slots);
  const asks = item.asks.map(askOwner); unique(asks.map(value => value.id)); unique(asks.map(value => value.sourceSlot));
  requireValue(asks.every(value => ids.has(value.sourceSlot) && [value.input, value.text, value.image, value.display].every(value => !value || value.scope === scope || value.scope === `${scope}:ask`)));
  const tracks = item.tracks.map(value => {
    requireValue(record(value) && text(value.entryId) && ids.has(value.slotId));
    return { entryId: value.entryId, slotId: value.slotId, ...(value.view ? { view: parseTrackedView(value.view, ids) } : {}) };
  });
  unique(tracks.map(value => value.entryId));
  const windows = item.windows === undefined ? undefined : parseCompositionWindows(item.windows, ids);
  const activeWindow = windows?.find(view => view.id === item.activeWindow && !view.managed)?.id;
  return { version: 2, scope, editRevision: item.editRevision, slots, roles, edges, collapsed: [...item.collapsed], retained, asks, tracks,
    ...(windows ? { windows } : {}), ...(activeWindow ? { activeWindow } : {}),
    ...optionalKeys(item as unknown as Record<string, unknown>, ids, ['primary', 'address', 'focus', 'anchor']),
    ...optionalKeys(item as unknown as Record<string, unknown>, new Set(tracks.map(value => value.entryId)), ['selectedTrack']) };
}

export function createCompositionDocument(scope: string, slots: CompositionSlot[] = []): CompositionDocument {
  return { version: 2, scope, editRevision: 0, slots: slots.map(slot), roles: [], edges: [], collapsed: [], retained: [], asks: [], tracks: [], ...(slots[0] ? { primary: slots[0].id, address: slots[0].id } : {}) };
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

function parseTrackedView(value: NonNullable<CompositionTrack['view']>, ids: Set<string>): NonNullable<CompositionTrack['view']> {
  requireValue(record(value) && ids.has(value.primarySlot) && record(value.selections));
  const selections: Record<string, string | null> = {};
  for (const [source, target] of Object.entries(value.selections)) {
    requireValue(ids.has(source) && (target === null || ids.has(target)));
    Object.defineProperty(selections, source, { value: target, enumerable: true, writable: true, configurable: true });
  }
  return { primarySlot: value.primarySlot, selections, ...optionalKeys(value as unknown as Record<string, unknown>, ids, ['focus', 'anchor']) };
}
function askOwner(value: unknown): AskAssociationOwner {
  requireValue(record(value)); const item = value as AskAssociationOwner;
  requireValue([item.id, item.sourceSlot, item.geometryScope].every(text) && typeof item.open === 'boolean'
    && (item.enabled === undefined || typeof item.enabled === 'boolean'));
  requireValue(item.records === undefined || Array.isArray(item.records) && item.records.every(value => record(value) && text(value.id) && (value.target === undefined || text(value.target))));
  return { id: item.id, sourceSlot: item.sourceSlot, input: owner(item.input), geometryScope: item.geometryScope, open: item.open,
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }), text: owner(item.text),
    ...(item.image === undefined ? {} : { image: owner(item.image) }), ...(item.display === undefined ? {} : { display: owner(item.display) }),
    ...(item.records === undefined ? {} : { records: item.records.map(value => ({ id: value.id, ...(value.target === undefined ? {} : { target: value.target }) })) }) };
}
export const compositionMetadataKey = (scope: string): string => `agent-remote:recovery:${scope}:composition-v2`;
export function readCompositionDocument(scope: string): CompositionRead<CompositionDocument> {
  try {
    const key = compositionMetadataKey(scope); flushRecoveryWrites(key);
    const raw = conversationSessionStorage.getItem(key);
    if (raw === null) return { status: 'missing' };
    requireValue(new TextEncoder().encode(raw).byteLength <= COMPOSITION_CAPACITY.bytes);
    const value: unknown = JSON.parse(raw);
    if (record(value) && value.version !== 2) return { status: 'unsupported' };
    return { status: 'ready', document: parseComposition(value, scope) };
  } catch (error) { return { status: 'failed', error }; }
}
export function saveCompositionDocument(document: CompositionDocument, isCurrent: () => boolean): RecoveryWriteHandle {
  const { scope, editRevision } = document, generation = recoveryGeneration(scope), key = compositionMetadataKey(scope);
  return queueRecoveryWrite(key, () => {
    const existing = conversationSessionStorage.getItem(key);
    if (existing !== null) {
      requireValue(new TextEncoder().encode(existing).byteLength <= COMPOSITION_CAPACITY.bytes);
      requireValue(parseComposition(JSON.parse(existing), scope).editRevision <= editRevision);
    }
    const encoded = JSON.stringify(parseComposition(document, scope));
    requireValue(new TextEncoder().encode(encoded).byteLength <= COMPOSITION_CAPACITY.bytes);
    retainCompositionOwners(document, () => isCurrent() && generation === recoveryGeneration(scope) && document.editRevision === editRevision);
    return encoded;
  }, { isCurrent: () => isCurrent() && generation === recoveryGeneration(scope) && document.editRevision === editRevision });
}

export function compositionSelection(slot: CompositionSlot): SessionEntry {
  return { hostId: slot.intent.target.hostId, providerId: slot.intent.target.native.providerId, nativeSessionId: slot.intent.target.native.nativeSessionId,
    title: slot.metadata?.title ?? 'Session', ...(slot.metadata ?? {}) };
}
export function compositionSession(slot: CompositionSlot): (OpenedSession & { viewId: string }) | undefined {
  if (!slot.metadata?.agentId) return;
  return { ...compositionSelection(slot), ...slot.metadata, agentId: slot.metadata.agentId, viewId: slot.id };
}
export function compositionSessionMetadata(session: SessionEntry): NonNullable<CompositionSlot['metadata']> {
  return { title: session.title, ...(session.agentId ? { agentId: session.agentId } : {}),
    ...(session.parentAgentId ? { parentAgentId: session.parentAgentId } : {}),
    ...(session.parentNativeSessionId ? { parentNativeSessionId: session.parentNativeSessionId } : {}),
    ...(session.createdAt ? { createdAt: session.createdAt } : {}) };
}
export function createCompositionSlot(id: string, session: SessionEntry, scope: string, owners?: CompositionSlot['owners']): CompositionSlot {
  const key = `view:${id}`;
  const origin = { kind: 'fixed' as const, target: { hostId: session.hostId ?? 'local', native: { providerId: session.providerId, nativeSessionId: session.nativeSessionId } } };
  return { id, origin, intent: structuredClone(origin),
    metadata: compositionSessionMetadata(session),
    owners: owners ?? { text: { scope, key }, image: { scope, key: JSON.stringify([scope, key]) }, display: { scope, key } } };
}
export function createAskOwner(slot: CompositionSlot, scope: string): AskAssociationOwner {
  const key = `ask:${slot.id}`;
  return { id: key, sourceSlot: slot.id, input: { scope, key: `agent-remote-ask:${scope}:inputs:${key}` }, geometryScope: JSON.stringify([scope, key]),
    text: { scope: `${scope}:ask`, key }, image: { scope, key: JSON.stringify([scope, key]) }, display: { scope, key }, open: false, records: [] };
}
export function createHistorySlot(id: string, target: CompositionLocator, scope: string): CompositionSlot {
  const result = createCompositionSlot(id, { hostId: target.hostId, ...target.native, title: 'Session' }, scope);
  result.intent = { kind: 'history', target: locator(target) };
  result.origin = structuredClone(result.intent);
  return result;
}

/** Ordinary views have one durable origin; explicitly named slots remain independent. */
export function compositionOriginId(source: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>, history = false): string {
  return JSON.stringify(['view', history ? 'history' : 'fixed', source.hostId ?? 'local', source.providerId, source.nativeSessionId]);
}

interface CompositionOwnerRecord { version: 1; scope: string; slot: CompositionSlot; ask: AskAssociationOwner }
const ownerPrefix = (scope: string) => `agent-remote:recovery:${scope}:composition-owner:`;
const ownerKey = (scope: string, id: string) => `${ownerPrefix(scope)}${encodeURIComponent(id)}`;
const askEnabledKey = (scope: string, id: string) => `agent-remote:recovery:${scope}:composition-ask-enabled:${encodeURIComponent(id)}`;
const importKey = (scope: string) => `agent-remote:recovery:${scope}:composition-import-v2`;
function staticAskOwner(value: AskAssociationOwner): AskAssociationOwner {
  const { open: _open, enabled: _enabled, records: _records, ...pointers } = value;
  return { ...pointers, open: false };
}
function ownerRecord(document: CompositionDocument, value: CompositionSlot): CompositionOwnerRecord {
  return { version: 1, scope: document.scope, slot: { ...value, intent: structuredClone(value.origin) },
    ask: staticAskOwner(document.asks.find(owner => owner.sourceSlot === value.id) ?? createAskOwner(value, document.scope)) };
}
function parseOwnerRecord(raw: string, scope: string): CompositionOwnerRecord {
  requireValue(new TextEncoder().encode(raw).byteLength <= COMPOSITION_CAPACITY.bytes);
  const value: unknown = JSON.parse(raw);
  requireValue(record(value) && value.version === 1 && value.scope === scope);
  const item = value as unknown as CompositionOwnerRecord;
  const document = parseComposition({ ...createCompositionDocument(scope), slots: [item.slot], asks: [item.ask] }, scope);
  requireValue(canonicalJson(document.slots[0]!.origin) === canonicalJson(document.slots[0]!.intent));
  requireValue(canonicalJson(document.asks[0]) === canonicalJson(staticAskOwner(document.asks[0]!)));
  return { version: 1, scope, slot: document.slots[0]!, ask: document.asks[0]! };
}
function immutableOwners(value: CompositionOwnerRecord): string {
  const { metadata: _metadata, ...identity } = value.slot;
  return canonicalJson({ slot: identity, ask: value.ask });
}
function readAskEnabled(scope: string, id: string): boolean | undefined {
  const raw = conversationLocalStorage.getItem(askEnabledKey(scope, id));
  requireValue(raw === null || raw === 'true' || raw === 'false');
  return raw === null ? undefined : raw === 'true';
}

/** Persist only stable payload ownership. A tab never publishes its layout to another tab. */
export function retainCompositionOwners(document: CompositionDocument, isCurrent: () => boolean): void {
  const prefix = ownerPrefix(document.scope);
  let count = 0, bytes = 0;
  for (let index = 0; index < conversationLocalStorage.length; index++) {
    const key = conversationLocalStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = conversationLocalStorage.getItem(key); requireValue(raw !== null);
    count++; bytes += new TextEncoder().encode(raw!).byteLength;
  }
  const additions = document.slots.map(value => {
    requireValue(isCurrent());
    const next = ownerRecord(document, value), key = ownerKey(document.scope, value.id);
    const existing = conversationLocalStorage.getItem(key);
    if (existing !== null) requireValue(immutableOwners(parseOwnerRecord(existing, document.scope)) === immutableOwners(next));
    const encoded = existing ?? JSON.stringify(next);
    if (existing === null) { count++; bytes += new TextEncoder().encode(encoded).byteLength; }
    return { next, key, encoded, enabled: document.asks.find(owner => owner.sourceSlot === value.id)?.enabled };
  });
  requireValue(count <= COMPOSITION_CAPACITY.slots && bytes <= COMPOSITION_CAPACITY.bytes);
  for (const { next, key, encoded, enabled } of additions) {
    requireValue(isCurrent());
    conversationLocalStorage.setItem(key, encoded);
    requireValue(conversationLocalStorage.getItem(key) === encoded);
    // Reapply the current storage policy while preserving a newer user preference.
    const currentEnabled = readAskEnabled(document.scope, next.ask.id) ?? enabled;
    if (currentEnabled !== undefined) {
      const key = askEnabledKey(document.scope, next.ask.id), encoded = String(currentEnabled);
      requireValue(isCurrent()); conversationLocalStorage.setItem(key, encoded);
      requireValue(conversationLocalStorage.getItem(key) === encoded);
    }
  }
  requireValue(isCurrent());
}

export function restoreCompositionOwners(scope: string): CompositionDocument {
  const prefix = ownerPrefix(scope), records: CompositionOwnerRecord[] = [];
  let bytes = 0;
  for (let index = 0; index < conversationLocalStorage.length; index++) {
    const key = conversationLocalStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = conversationLocalStorage.getItem(key); requireValue(raw !== null);
    bytes += new TextEncoder().encode(raw!).byteLength;
    requireValue(bytes <= COMPOSITION_CAPACITY.bytes && records.length < COMPOSITION_CAPACITY.slots);
    const value = parseOwnerRecord(raw!, scope);
    requireValue(key === ownerKey(scope, value.slot.id)); records.push(value);
  }
  const document = createCompositionDocument(scope);
  document.slots = records.map(value => value.slot);
  document.asks = records.map(value => {
    const enabled = readAskEnabled(scope, value.ask.id);
    return { ...value.ask, ...(enabled === undefined ? {} : { enabled }) };
  });
  return parseComposition(document, scope);
}

/** Refresh user preferences at tab initialization without importing another tab's layout. */
export function refreshCompositionAskPreferences(document: CompositionDocument): boolean {
  let changed = false;
  for (const owner of document.asks) {
    const enabled = readAskEnabled(document.scope, owner.id);
    if (owner.enabled === enabled) continue;
    if (enabled === undefined) delete owner.enabled; else owner.enabled = enabled;
    changed = true;
  }
  return changed;
}

export function saveCompositionAskEnabled(document: CompositionDocument, id: string, enabled: boolean, isCurrent: () => boolean): void {
  const generation = recoveryGeneration(document.scope), current = () => isCurrent() && recoveryGeneration(document.scope) === generation;
  requireValue(document.asks.some(owner => owner.id === id));
  retainCompositionOwners(document, current);
  const key = askEnabledKey(document.scope, id), encoded = String(enabled);
  requireValue(current()); conversationLocalStorage.setItem(key, encoded);
  requireValue(current() && conversationLocalStorage.getItem(key) === encoded);
}

export function compositionOwnersImported(scope: string): boolean {
  const raw = conversationLocalStorage.getItem(importKey(scope));
  requireValue(raw === null || raw === '2'); return raw !== null;
}
export function completeCompositionOwnerImport(scope: string, isCurrent: () => boolean): void {
  requireValue(isCurrent()); conversationLocalStorage.setItem(importKey(scope), '2');
  requireValue(isCurrent() && conversationLocalStorage.getItem(importKey(scope)) === '2');
}
