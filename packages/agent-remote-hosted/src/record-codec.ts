import { createHash } from 'node:crypto';
import { checkedRelayState, validateRelayState, type HostedRelayState } from './state.js';
import type { HostedAuthOptions } from './hosted-auth.js';
import type { SuccessionEncodingCosts } from './succession-capacity.js';

/** Format 4 stores each Team as its own record; format 3 kept every Team of an account inside its broker header. */
export const HOSTED_SNAPSHOT_FORMAT = 4;
/** Formats this codec reads; it writes only HOSTED_SNAPSHOT_FORMAT. */
export const HOSTED_READABLE_SNAPSHOT_FORMATS = [3, 4] as const;
export type HostedSnapshotFormat = typeof HOSTED_READABLE_SNAPSHOT_FORMATS[number];
export const HOSTED_RECORD_FORMAT = 1;
export const HOSTED_CHUNK_BYTES = 262144;
export const HOSTED_RECORD_KINDS = ['relayHeader', 'tenant', 'brokerHeader', 'associationHeader', 'favoritesHeader',
  'session', 'loginChallenge', 'consumedProof', 'securityEvent', 'sessionStar', 'favoritesTree', 'sessionMigration',
  'sessionTitle', 'deviceKey', 'host', 'binding', 'creation', 'preview', 'pairing', 'share', 'reservation',
  'workspaceWindow', 'revokedHost', 'admission', 'freeze', 'relationChange', 'relationReset', 'favoritesReceipt', 'team', 'sessionRead', 'sessionReadAccount', 'sessionDraft'] as const;
export type HostedRecordKind = typeof HOSTED_RECORD_KINDS[number];
type Identity<K extends HostedRecordKind = HostedRecordKind> = [K, string, string];
type JsonObject = Record<string, unknown>;
type Tenant = HostedRelayState['tenants'][number];
type Broker = Tenant['broker'];
type Associations = NonNullable<Broker['associations']>;
type Favorites = NonNullable<Tenant['favoritesSuccession']>;
type HostedAssociationHeader = Omit<Associations, 'version' | 'admissions' | 'freezes' | 'relationChanges' | 'relationResets'> & {
  version: 1 | 2 | 3 | 4 | 5 | 6; admissions: Identity<'admission'>[]; freezes: Identity<'freeze'>[];
  relationChanges?: Identity<'relationChange'>[]; relationResets?: Identity<'relationReset'>[];
};
type HostedFavoritesHeader = Omit<Favorites, 'receipts'> & { receipts: Identity<'favoritesReceipt'>[] };
type HostedSharingHeader = Omit<NonNullable<Broker['sharing']>, 'grants' | 'reservations'> & {
  grants: Identity<'share'>[]; reservations: Identity<'reservation'>[];
};
type HostedBrokerHeader = Omit<Broker, 'keys' | 'hosts' | 'bindings' | 'creations' | 'previews' | 'pairings' | 'revokedHosts' | 'sharing' | 'associations' | 'teams'> & {
  keys: Identity<'deviceKey'>[]; hosts: Identity<'host'>[]; bindings: Identity<'binding'>[]; creations: Identity<'creation'>[];
  previews?: Identity<'preview'>[]; pairings?: Identity<'pairing'>[]; revokedHosts?: Identity<'revokedHost'>[];
  sharing?: HostedSharingHeader; associations?: Identity<'associationHeader'>;
  /** Format 4: one record per Team, so a change to one Team rewrites only that Team. Format 3: the Teams themselves. */
  teams?: Identity<'team'>[] | Broker['teams'];
};
type HostedTenantHeader = Omit<Tenant, 'broker' | 'favoritesSuccession'> & {
  broker: Identity<'brokerHeader'>; favoritesSuccession?: Identity<'favoritesHeader'>;
};
type HostedRelayHeader = Omit<HostedRelayState, 'workspaceWindows' | 'tenants' | 'sessions' | 'loginChallenges' | 'consumedProofs' | 'securityEvents' | 'sessionStars' | 'favoritesTrees' | 'sessionMigrations' | 'sessionTitles' | 'sessionReads' | 'sessionReadAccounts' | 'sessionDrafts'> & {
  workspaceWindows?: Identity<'workspaceWindow'>[];
  tenants: Identity<'tenant'>[]; sessions: Identity<'session'>[]; loginChallenges: Identity<'loginChallenge'>[];
  consumedProofs: Identity<'consumedProof'>[]; securityEvents?: Identity<'securityEvent'>[]; sessionStars?: Identity<'sessionStar'>[];
  favoritesTrees?: Identity<'favoritesTree'>[]; sessionMigrations?: Identity<'sessionMigration'>[]; sessionTitles?: Identity<'sessionTitle'>[];
  sessionReads?: Identity<'sessionRead'>[]; sessionReadAccounts?: Identity<'sessionReadAccount'>[]; sessionDrafts?: Identity<'sessionDraft'>[];
};
export type HostedManifest = {
  format: number; kind: HostedRecordKind; identity: string; byte_length: number; chunk_count: number; digest: string;
}
export type HostedChunk = { kind: HostedRecordKind; identity: string; ordinal: number; bytes: ArrayBuffer | Uint8Array };
export interface HostedEncodedRecord { manifest: HostedManifest; chunks: HostedChunk[] }
export interface HostedRecordCost {
  kind: HostedRecordKind; owner: string; key: string; identity: string; byteLength: number; chunkCount: number; manifestBytes: number;
  payloadStringBytes: number;
}
export interface HostedSnapshot {
  records: Map<string, HostedEncodedRecord>; costs: HostedRecordCost[];
  /** Records encoded from their payload; the others reused a cached encoding. */
  encoded: number;
}
interface CachedRecord {
  payload: unknown; identity: string; cost: HostedRecordCost; encoded?: HostedEncodedRecord;
  /** The payload was immutable when encoded: committed state is deeply frozen, so the same object has the same content. */
  trusted: boolean;
  /** The record's reference in its parent header; the same object while the record exists, so headers stay equal. */
  tuple: Identity;
  /** A header encoded from immutable fields: an equal header has the same fields, in order. */
  fields?: object;
}
export interface HostedRecordCacheOptions {
  /** Every this many uses, encode the snapshot again without the cache and keep that encoding if the two differ. */
  verifyEvery?: number;
  /** A verification found cached encodings that differ from a complete encoding; that encoding was used instead. */
  onMismatch?(kinds: HostedRecordKind[]): void;
}
/**
 * The encodings of the records of the last snapshot encoded with this cache. A record whose payload is the same frozen object
 * reuses its encoding without serializing it; one whose payload serializes to the same JSON reuses its bytes, digest and chunks.
 */
export class HostedRecordCache {
  /** @internal */ entries = new Map<string, CachedRecord>();
  /** @internal Reference lists and nested header objects, kept while equal so their headers stay equal. */ parts = new Map<string, object>();
  /** @internal */ uses = 0;
  constructor(readonly options: HostedRecordCacheOptions = {}) {}
}
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const safePositive = (value: number) => Number.isSafeInteger(value) && value > 0;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const tupleKey = (tuple: Identity) => JSON.stringify(tuple);
const identityHash = (tuple: Identity) => digest(tupleKey(tuple));
const physicalKey = (kind: HostedRecordKind, identity: string) => JSON.stringify([kind, identity]);
function invalid(message: string): never { throw new Error(`Invalid hosted record snapshot: ${message}.`); }
function isKind(value: unknown): value is HostedRecordKind { return HOSTED_RECORD_KINDS.includes(value as HostedRecordKind); }
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const envelope = (kind: HostedRecordKind, owner: string, key: string, payload: unknown) => ({ format: HOSTED_RECORD_FORMAT, kind, owner, key, payload });
function manifestFor(kind: HostedRecordKind, identity: string, byteLength: number, contentDigest: string): HostedManifest {
  return { format: HOSTED_RECORD_FORMAT, kind, identity, byte_length: byteLength, chunk_count: Math.ceil(byteLength / HOSTED_CHUNK_BYTES), digest: contentDigest };
}

const ZERO_DIGEST = '0'.repeat(64);
/** Encoding bound only. The payload is never allocated or treated as valid domain evidence. */
export function quoteHostedRecord(input: { kind: string; owner: string; key: string; payloadJsonBytesUpperBound: number }): Pick<HostedRecordCost, 'byteLength' | 'chunkCount' | 'manifestBytes'> {
  if (!input || !isKind(input.kind) || typeof input.owner !== 'string' || typeof input.key !== 'string') invalid('quote tuple or kind');
  const bound = input.payloadJsonBytesUpperBound;
  if (!Number.isSafeInteger(bound) || bound < 0) invalid('quote payload length');
  const framing = Buffer.byteLength(JSON.stringify(envelope(input.kind, input.owner, input.key, null))) - 4;
  const byteLength = framing + bound;
  if (!Number.isSafeInteger(byteLength)) invalid('quote length overflow');
  // An identity and a digest are both 64 hex digits, so their values do not change the manifest's length.
  const manifest = manifestFor(input.kind, ZERO_DIGEST, byteLength, ZERO_DIGEST);
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  if (!Number.isSafeInteger(byteLength + manifestBytes)) invalid('quote charge overflow');
  return { byteLength, chunkCount: manifest.chunk_count, manifestBytes };
}

/**
 * Exact logical bytes and per-record chunks; manifestBytes measures its explicit JSON fields, not physical storage allocation.
 * With a cache, records whose payload is unchanged since the cache's last snapshot reuse their encoding.
 */
export function encodeHostedSnapshot(input: HostedRelayState, auth: HostedAuthOptions, format: HostedSnapshotFormat = HOSTED_SNAPSHOT_FORMAT, cache?: HostedRecordCache): HostedSnapshot {
  readableFormat(format);
  if (!cache) return encodeValidatedHostedSnapshot(validateRelayState(input, auth), format);
  return cachedEncoding(cache, input, auth, (state, target) => encodeValidatedHostedSnapshot(state, format, target));
}
/** The costs of encodeHostedSnapshot without producing the records' bytes. */
export function measureHostedSnapshot(input: HostedRelayState, auth: HostedAuthOptions, cache?: HostedRecordCache): HostedRecordCost[] {
  if (!cache) return encodeValidatedHostedSnapshot(validateRelayState(input, auth), HOSTED_SNAPSHOT_FORMAT, undefined, 'costs').costs;
  return cachedEncoding(cache, input, auth, (state, target) => encodeValidatedHostedSnapshot(state, HOSTED_SNAPSHOT_FORMAT, target, 'costs')).costs;
}
function cachedEncoding(cache: HostedRecordCache, input: HostedRelayState, auth: HostedAuthOptions, encode: (state: HostedRelayState, cache: HostedRecordCache) => HostedSnapshot): HostedSnapshot {
  const result = encode(checkedRelayState(input, auth), cache);
  const every = cache.options.verifyEvery;
  if (!every || ++cache.uses % every) return result;
  // A cache trusts only frozen payloads, so a difference here is a defect of the cache, not a caller's in-place change.
  const fresh = new HostedRecordCache(cache.options), complete = encode(validateRelayState(input, auth), fresh);
  const kinds = new Set<HostedRecordKind>();
  for (const [index, cost] of complete.costs.entries()) {
    const other = result.costs[index];
    if (!other || other.kind !== cost.kind || other.owner !== cost.owner || other.key !== cost.key || other.identity !== cost.identity || other.byteLength !== cost.byteLength
      || other.chunkCount !== cost.chunkCount || other.manifestBytes !== cost.manifestBytes || other.payloadStringBytes !== cost.payloadStringBytes) kinds.add(cost.kind);
  }
  for (const [key, record] of complete.records) if (result.records.get(key)?.manifest.digest !== record.manifest.digest) kinds.add(record.manifest.kind);
  if (!kinds.size && result.costs.length === complete.costs.length && result.records.size === complete.records.size) return result;
  cache.entries = fresh.entries; cache.parts = fresh.parts;
  cache.options.onMismatch?.([...kinds]);
  return complete;
}
function readableFormat(format: number): HostedSnapshotFormat {
  if (!HOSTED_READABLE_SNAPSHOT_FORMATS.includes(format as HostedSnapshotFormat)) invalid('unsupported snapshot format');
  return format as HostedSnapshotFormat;
}
/** Equal identity is equal content only for a value nobody can change; committed state is deeply frozen. */
const immutable = (payload: unknown) => payload === null || typeof payload !== 'object' || Object.isFrozen(payload);
const HEADER_KINDS = new Set<HostedRecordKind>(['relayHeader', 'tenant', 'brokerHeader', 'associationHeader', 'favoritesHeader']);
/** A header payload whose fields are all immutable, which the next snapshot compares field by field. */
const header = (kind: HostedRecordKind, payload: unknown) => HEADER_KINDS.has(kind) && object(payload) && Object.values(payload).every(immutable) ? payload : undefined;
const sameItems = (previous: readonly unknown[], next: readonly unknown[]) => previous.length === next.length && previous.every((item, index) => item === next[index]);
/** The same immutable fields in the same order serialize to the same JSON. */
function sameFields(previous: object, next: object): boolean {
  const before = Object.entries(previous), after = Object.entries(next);
  return before.length === after.length && after.every(([key, value], index) => key === before[index]![0] && value === before[index]![1] && immutable(value));
}
function encodeValidatedHostedSnapshot(state: HostedRelayState, format: HostedSnapshotFormat, cache?: HostedRecordCache, mode: 'records' | 'costs' = 'records'): HostedSnapshot {
  const records = new Map<string, HostedEncodedRecord>();
  const tuples = new Set<string>(); const hashes = new Map<string, string>(); const costs: HostedRecordCost[] = [];
  const previous = cache?.entries, next = new Map<string, CachedRecord>();
  const previousParts = cache?.parts, nextParts = new Map<string, object>();
  let encoded = 0;
  /** value, or the equal one this slot held in the cache's last snapshot. */
  function stable<T extends object>(slot: unknown[], value: T, same: (previous: T, next: T) => boolean): T {
    const key = JSON.stringify(slot), prior = previousParts?.get(key) as T | undefined;
    const result = prior !== undefined && same(prior, value) ? prior : Object.freeze(value);
    nextParts.set(key, result);
    return result;
  }
  function encodeRecord(kind: HostedRecordKind, owner: string, key: string, logical: string, tuple: Identity, payload: unknown, cached: CachedRecord | undefined): CachedRecord {
    const text = JSON.stringify(payload);
    if (text === undefined) invalid('record envelope');
    // The text JSON.stringify(envelope(kind, owner, key, payload)) produces, without serializing the payload again.
    const json = `{"format":${HOSTED_RECORD_FORMAT},"kind":${JSON.stringify(kind)},"owner":${JSON.stringify(owner)},"key":${JSON.stringify(key)},"payload":${text}}`;
    const identity = cached?.identity ?? digest(logical);
    if (mode === 'costs') {
      const byteLength = Buffer.byteLength(json), manifest = manifestFor(kind, identity, byteLength, ZERO_DIGEST);
      encoded++;
      return { payload, identity, trusted: immutable(payload), tuple, fields: header(kind, payload), cost: { kind, owner, key, identity, byteLength, chunkCount: manifest.chunk_count, manifestBytes: jsonBytes(manifest).byteLength,
        payloadStringBytes: Buffer.byteLength(JSON.stringify(text)) - 2 } };
    }
    const contentDigest = digest(json);
    if (cached?.encoded && cached.encoded.manifest.digest === contentDigest) return { ...cached, payload, trusted: immutable(payload), fields: header(kind, payload) };
    const bytes = new TextEncoder().encode(json);
    const manifest = manifestFor(kind, identity, bytes.byteLength, contentDigest);
    const chunks: HostedChunk[] = [];
    for (let ordinal = 0; ordinal < manifest.chunk_count; ordinal++) chunks.push({ kind, identity, ordinal, bytes: bytes.subarray(ordinal * HOSTED_CHUNK_BYTES, (ordinal + 1) * HOSTED_CHUNK_BYTES) });
    // Only bounded physical identities, BLOBs and exact lengths; cross-record identities are checked as records are added.
    readHostedRecords([manifest], chunks);
    encoded++;
    return { payload, identity, trusted: immutable(payload), tuple, fields: header(kind, payload), encoded: { manifest, chunks },
      cost: { kind, owner, key, identity, byteLength: bytes.byteLength, chunkCount: manifest.chunk_count, manifestBytes: jsonBytes(manifest).byteLength,
        payloadStringBytes: Buffer.byteLength(JSON.stringify(text)) - 2 } };
  }
  function add<K extends HostedRecordKind>(kind: K, owner: string, key: string, payload: unknown): Identity<K> {
    const logical = tupleKey([kind, owner, key]);
    if (tuples.has(logical)) invalid('duplicate logical identity');
    const cached = previous?.get(logical);
    const tuple = (cached?.tuple ?? Object.freeze([kind, owner, key])) as Identity<K>;
    const unchanged = cached && (cached.trusted && cached.payload === payload || cached.fields !== undefined && sameFields(cached.fields, payload as object));
    const entry = unchanged && (mode === 'costs' || cached.encoded) ? cached : encodeRecord(kind, owner, key, logical, tuple, payload, cached);
    const identity = entry.identity;
    if (hashes.has(identity) && hashes.get(identity) !== logical) invalid('identity hash collision');
    tuples.add(logical); hashes.set(identity, logical); next.set(logical, entry);
    if (entry.encoded) records.set(physicalKey(kind, identity), entry.encoded);
    costs.push(entry.cost);
    return tuple;
  }
  function references<T, K extends HostedRecordKind>(values: T[], kind: K, owner: string, key: (value: T) => string, payload?: (value: T) => unknown): Identity<K>[];
  function references<T, K extends HostedRecordKind>(values: T[] | undefined, kind: K, owner: string, key: (value: T) => string, payload?: (value: T) => unknown): Identity<K>[] | undefined;
  function references<T, K extends HostedRecordKind>(values: T[] | undefined, kind: K, owner: string, key: (value: T) => string, payload: (value: T) => unknown = value => value) {
    return values && stable(['references', kind, owner], values.map(value => add(kind, owner, key(value), payload(value))), sameItems);
  }
  const relay: HostedRelayHeader = { ...state,
    workspaceWindows: references(state.workspaceWindows, 'workspaceWindow', '', value => JSON.stringify([value.subject, value.id])),
    sessions: references(state.sessions, 'session', '', value => value.hash),
    loginChallenges: references(state.loginChallenges, 'loginChallenge', '', value => value[0], value => value[1]),
    consumedProofs: references(state.consumedProofs, 'consumedProof', '', value => value[0], value => value[1]),
    securityEvents: references(state.securityEvents, 'securityEvent', '', value => value.id),
    sessionStars: references(state.sessionStars, 'sessionStar', '', value => JSON.stringify([value.subject, value.hostId, value.providerId, value.nativeSessionId])),
    favoritesTrees: references(state.favoritesTrees, 'favoritesTree', '', value => value.subject),
    sessionMigrations: references(state.sessionMigrations, 'sessionMigration', '', value => JSON.stringify([value.subject, value.id])),
    sessionTitles: references(state.sessionTitles, 'sessionTitle', '', value => JSON.stringify([value.hostId, value.providerId, value.nativeSessionId])),
    sessionReads: references(state.sessionReads, 'sessionRead', '', value => JSON.stringify([value.subject, value.hostId, value.providerId, value.nativeSessionId])),
    sessionReadAccounts: references(state.sessionReadAccounts, 'sessionReadAccount', '', value => value.subject),
    sessionDrafts: references(state.sessionDrafts, 'sessionDraft', '', value => JSON.stringify([value.subject, value.hostId, value.providerId, value.nativeSessionId])),
    tenants: stable(['references', 'tenant', ''], state.tenants.map(tenant => {
      const owner = tenant.namespace; const source = tenant.broker;
      const broker: HostedBrokerHeader = { ...source,
        keys: references(source.keys, 'deviceKey', owner, value => value[0], value => value[1]),
        hosts: references(source.hosts, 'host', owner, value => value.id),
        bindings: references(source.bindings, 'binding', owner, value => value.agentId),
        creations: references(source.creations, 'creation', owner, value => value[0], value => value[1]),
        previews: references(source.previews, 'preview', owner, value => value.hostId),
        pairings: references(source.pairings, 'pairing', owner, value => value.id),
        revokedHosts: references(source.revokedHosts, 'revokedHost', owner, value => JSON.stringify([value.hostId, value.installationId])),
        ...(format >= 4 ? { teams: references(source.teams, 'team', owner, value => value.id) } : {}),
        sharing: source.sharing === undefined ? undefined : stable(['sharing', owner], { ...source.sharing,
          grants: references(source.sharing.grants, 'share', owner, value => JSON.stringify([value.hostId, value.subject])),
          reservations: references(source.sharing.reservations, 'reservation', owner, value => value.key),
        }, sameFields),
        associations: source.associations === undefined ? undefined : (() => {
          const associations: HostedAssociationHeader = { ...source.associations,
            admissions: references(source.associations.admissions, 'admission', owner, value => value.id),
            freezes: references(source.associations.freezes, 'freeze', owner, value => value.receipt.token),
            relationChanges: references(source.associations.relationChanges, 'relationChange', owner, value => value.reservation.operationId),
            relationResets: references(source.associations.relationResets, 'relationReset', owner, value => value.intent.operationId),
          };
          return add('associationHeader', owner, 'associations', associations);
        })(),
      };
      const header: HostedTenantHeader = { ...tenant, broker: add('brokerHeader', owner, 'broker', broker),
        favoritesSuccession: tenant.favoritesSuccession === undefined ? undefined : (() => {
          const progress: HostedFavoritesHeader = { ...tenant.favoritesSuccession,
            receipts: references(tenant.favoritesSuccession.receipts, 'favoritesReceipt', owner, value => value.token),
          };
          return add('favoritesHeader', owner, 'favorites', progress);
        })(),
      };
      return add('tenant', '', owner, header);
    }), sameItems),
  };
  add('relayHeader', '', 'relay', relay);
  // Only a complete encoding replaces the cache, which so holds exactly the records of its last snapshot.
  if (cache) { cache.entries = next; cache.parts = nextParts; }
  return { records, costs, encoded };
}

/** No aggregate admission: these are only bounded physical identities, BLOBs and safe exact lengths. */
export function preflightHostedSnapshot(snapshot: HostedSnapshot): void {
  const manifests: HostedManifest[] = []; const chunks: HostedChunk[] = [];
  for (const [key, record] of snapshot.records) {
    if (key !== physicalKey(record.manifest.kind, record.manifest.identity)) invalid('physical identity');
    manifests.push(record.manifest); chunks.push(...record.chunks);
  }
  readHostedRecords(manifests, chunks);
}

function readHostedRecords(manifests: HostedManifest[], chunks: HostedChunk[]) {
  const records = new Map<string, { tuple: Identity; payload: unknown }>();
  const physical = new Set<string>(); const logical = new Set<string>(); const hashes = new Map<string, string>();
  const chunkGroups = new Map<string, Map<number, Uint8Array>>();
  for (const chunk of chunks) {
    if (!isKind(chunk.kind) || !/^[a-f0-9]{64}$/.test(chunk.identity) || !Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0) invalid('chunk identity or ordinal');
    if (!(chunk.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk.bytes)) invalid('non-BLOB chunk');
    const bytes = chunk.bytes instanceof ArrayBuffer ? new Uint8Array(chunk.bytes) : new Uint8Array(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
    if (!bytes.byteLength || bytes.byteLength > HOSTED_CHUNK_BYTES) invalid('chunk length');
    const key = physicalKey(chunk.kind, chunk.identity); const group = chunkGroups.get(key) ?? new Map<number, Uint8Array>();
    if (group.has(chunk.ordinal)) invalid('duplicate chunk ordinal');
    group.set(chunk.ordinal, bytes); chunkGroups.set(key, group);
  }
  for (const manifest of manifests) {
    if (manifest.format !== HOSTED_RECORD_FORMAT || !isKind(manifest.kind) || !/^[a-f0-9]{64}$/.test(manifest.identity)
      || !/^[a-f0-9]{64}$/.test(manifest.digest) || !safePositive(manifest.byte_length) || !safePositive(manifest.chunk_count)
      || manifest.chunk_count !== Math.ceil(manifest.byte_length / HOSTED_CHUNK_BYTES)) invalid('manifest format, identity or lengths');
    const key = physicalKey(manifest.kind, manifest.identity);
    if (physical.has(key)) invalid('duplicate manifest');
    physical.add(key);
    const group = chunkGroups.get(key);
    if (!group || group.size !== manifest.chunk_count) invalid('missing or excess chunks');
    const bytes = new Uint8Array(manifest.byte_length);
    for (let ordinal = 0; ordinal < manifest.chunk_count; ordinal++) {
      const chunk = group.get(ordinal); const expected = Math.min(HOSTED_CHUNK_BYTES, manifest.byte_length - ordinal * HOSTED_CHUNK_BYTES);
      if (!chunk || chunk.byteLength !== expected) invalid('noncontiguous or wrong-sized chunk');
      bytes.set(chunk, ordinal * HOSTED_CHUNK_BYTES);
    }
    if (digest(bytes) !== manifest.digest) invalid('record digest');
    let envelope: unknown;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { invalid('record JSON or UTF-8'); }
    if (!object(envelope) || Object.keys(envelope).join(',') !== 'format,kind,owner,key,payload' || envelope.format !== HOSTED_RECORD_FORMAT
      || envelope.kind !== manifest.kind || typeof envelope.owner !== 'string' || typeof envelope.key !== 'string') invalid('record envelope');
    const tuple: Identity = [manifest.kind, envelope.owner, envelope.key]; const tupleId = tupleKey(tuple);
    if (identityHash(tuple) !== manifest.identity) invalid('logical identity digest');
    if (logical.has(tupleId)) invalid('duplicate logical identity');
    if (hashes.has(manifest.identity) && hashes.get(manifest.identity) !== tupleId) invalid('identity hash collision');
    logical.add(tupleId); hashes.set(manifest.identity, tupleId);
    records.set(tupleId, { tuple, payload: envelope.payload });
  }
  if (physical.size !== chunkGroups.size || [...chunkGroups.keys()].some(key => !physical.has(key))) invalid('orphan chunks');
  return records;
}

/**
 * Reads a snapshot written in format; a format 3 snapshot keeps its Teams inside the broker header.
 * A cache receives the encodings of the records read, so the first commit after a restart reuses them.
 */
export function decodeHostedSnapshot(manifests: HostedManifest[], chunks: HostedChunk[], auth: HostedAuthOptions, format: HostedSnapshotFormat = HOSTED_SNAPSHOT_FORMAT, cache?: HostedRecordCache): HostedRelayState {
  readableFormat(format);
  const records = readHostedRecords(manifests, chunks); const consumed = new Set<string>();
  function take(ref: unknown, kind: HostedRecordKind, owner: string, key?: string) {
    if (!Array.isArray(ref) || ref.length !== 3 || ref[0] !== kind || ref[1] !== owner || typeof ref[2] !== 'string' || key !== undefined && ref[2] !== key) invalid('header child identity');
    const id = JSON.stringify(ref); const record = records.get(id);
    if (!record || consumed.has(id)) invalid('missing or repeated child');
    consumed.add(id); return record.payload;
  }
  function header(ref: unknown, kind: HostedRecordKind, owner: string, key: string): JsonObject {
    const value = take(ref, kind, owner, key);
    if (!object(value)) invalid('header payload');
    return value;
  }
  function collection(parent: JsonObject, field: string, kind: HostedRecordKind, owner: string, required = false, tuples = false) {
    if (!Object.hasOwn(parent, field)) { if (required) invalid('missing required collection'); return; }
    const refs = parent[field];
    if (!Array.isArray(refs)) invalid('collection presence');
    parent[field] = refs.map((ref: unknown) => {
      const value = take(ref, kind, owner); return tuples ? [(ref as Identity)[2], value] : value;
    });
  }
  const relay = header(['relayHeader', '', 'relay'], 'relayHeader', '', 'relay');
  collection(relay, 'workspaceWindows', 'workspaceWindow', '');
  collection(relay, 'sessions', 'session', '', true);
  collection(relay, 'loginChallenges', 'loginChallenge', '', true, true);
  collection(relay, 'consumedProofs', 'consumedProof', '', true, true);
  collection(relay, 'securityEvents', 'securityEvent', '');
  collection(relay, 'sessionStars', 'sessionStar', '');
  collection(relay, 'favoritesTrees', 'favoritesTree', '');
  collection(relay, 'sessionMigrations', 'sessionMigration', '');
  collection(relay, 'sessionTitles', 'sessionTitle', '');
  collection(relay, 'sessionReads', 'sessionRead', '');
  collection(relay, 'sessionReadAccounts', 'sessionReadAccount', '');
  collection(relay, 'sessionDrafts', 'sessionDraft', '');
  if (!Array.isArray(relay.tenants)) invalid('tenant order');
  relay.tenants = relay.tenants.map((ref: unknown) => {
    if (!Array.isArray(ref) || typeof ref[2] !== 'string') invalid('tenant reference');
    const tenant = header(ref, 'tenant', '', ref[2]); const owner = tenant.namespace;
    if (typeof owner !== 'string' || owner !== ref[2]) invalid('tenant namespace');
    const broker = header(tenant.broker, 'brokerHeader', owner, 'broker');
    collection(broker, 'keys', 'deviceKey', owner, true, true);
    collection(broker, 'hosts', 'host', owner, true);
    collection(broker, 'bindings', 'binding', owner, true);
    collection(broker, 'creations', 'creation', owner, true, true);
    collection(broker, 'previews', 'preview', owner);
    collection(broker, 'pairings', 'pairing', owner);
    collection(broker, 'revokedHosts', 'revokedHost', owner);
    if (format >= 4) collection(broker, 'teams', 'team', owner);
    if (Object.hasOwn(broker, 'sharing')) {
      if (!object(broker.sharing)) invalid('sharing presence');
      collection(broker.sharing, 'grants', 'share', owner, true);
      collection(broker.sharing, 'reservations', 'reservation', owner, true);
    }
    if (Object.hasOwn(broker, 'associations')) {
      const associations = header(broker.associations, 'associationHeader', owner, 'associations');
      collection(associations, 'admissions', 'admission', owner, true);
      collection(associations, 'freezes', 'freeze', owner, true);
      collection(associations, 'relationChanges', 'relationChange', owner);
      collection(associations, 'relationResets', 'relationReset', owner);
      broker.associations = associations;
    }
    tenant.broker = broker;
    if (Object.hasOwn(tenant, 'favoritesSuccession')) {
      const progress = header(tenant.favoritesSuccession, 'favoritesHeader', owner, 'favorites');
      collection(progress, 'receipts', 'favoritesReceipt', owner, true); tenant.favoritesSuccession = progress;
    }
    return tenant;
  });
  if (consumed.size !== records.size) invalid('orphan or unlisted record');
  const state = validateRelayState(relay, auth);
  // Re-encoding checks payload-derived identities, parent versions and complete coverage after the owning validators.
  // Validate identities against the original Window bytes after their owning
  // validator has accepted them; normalization must not invalidate old digests.
  const verifying = cache && new HostedRecordCache(cache.options);
  const expected = encodeValidatedHostedSnapshot({ ...state,
    ...(relay.workspaceWindows === undefined ? {} : { workspaceWindows: relay.workspaceWindows as HostedRelayState['workspaceWindows'] }) }, format, verifying).records;
  if (expected.size !== manifests.length) invalid('identity coverage');
  for (const manifest of manifests) {
    const wanted = expected.get(physicalKey(manifest.kind, manifest.identity))?.manifest;
    if (!wanted || wanted.digest !== manifest.digest || wanted.byte_length !== manifest.byte_length || wanted.chunk_count !== manifest.chunk_count) invalid('payload identity or header mismatch');
  }
  if (cache) { cache.entries = verifying!.entries; cache.parts = verifying!.parts; }
  return state;
}

/**
 * Common logical admission accounting; runtimes retain their own persistence and durability guarantees.
 * Each view of the state measured keeps its own cache, so a commit measures only the records it changed.
 */
export function hostedRecordEncodingCosts(auth: HostedAuthOptions, options?: HostedRecordCacheOptions): SuccessionEncodingCosts {
  const caches = { actual: new HostedRecordCache(options), ordinary: new HostedRecordCache(options) };
  return {
    measureSnapshot: (state, view = 'actual') => ({ snapshotFormat: HOSTED_SNAPSHOT_FORMAT, recordFormat: HOSTED_RECORD_FORMAT,
      chunkBytes: HOSTED_CHUNK_BYTES, costs: measureHostedSnapshot(state as HostedRelayState, auth, caches[view]) }),
    quoteRecord: quoteHostedRecord,
  };
}
