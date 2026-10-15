import { createHash } from 'node:crypto';
import { validateRelayState, type HostedRelayState } from './state.js';
import type { HostedAuthOptions } from './hosted-auth.js';
import type { SuccessionEncodingCosts } from './succession-capacity.js';

export const HOSTED_SNAPSHOT_FORMAT = 3;
export const HOSTED_RECORD_FORMAT = 1;
export const HOSTED_CHUNK_BYTES = 262144;
export const HOSTED_RECORD_KINDS = ['relayHeader', 'tenant', 'brokerHeader', 'associationHeader', 'favoritesHeader',
  'session', 'loginChallenge', 'consumedProof', 'securityEvent', 'sessionStar', 'favoritesTree', 'sessionMigration',
  'sessionTitle', 'deviceKey', 'host', 'binding', 'creation', 'preview', 'pairing', 'share', 'reservation',
  'workspaceWindow', 'revokedHost', 'admission', 'freeze', 'relationChange', 'relationReset', 'favoritesReceipt'] as const;
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
type HostedBrokerHeader = Omit<Broker, 'keys' | 'hosts' | 'bindings' | 'creations' | 'previews' | 'pairings' | 'revokedHosts' | 'sharing' | 'associations'> & {
  keys: Identity<'deviceKey'>[]; hosts: Identity<'host'>[]; bindings: Identity<'binding'>[]; creations: Identity<'creation'>[];
  previews?: Identity<'preview'>[]; pairings?: Identity<'pairing'>[]; revokedHosts?: Identity<'revokedHost'>[];
  sharing?: HostedSharingHeader; associations?: Identity<'associationHeader'>;
};
type HostedTenantHeader = Omit<Tenant, 'broker' | 'favoritesSuccession'> & {
  broker: Identity<'brokerHeader'>; favoritesSuccession?: Identity<'favoritesHeader'>;
};
type HostedRelayHeader = Omit<HostedRelayState, 'workspaceWindows' | 'tenants' | 'sessions' | 'loginChallenges' | 'consumedProofs' | 'securityEvents' | 'sessionStars' | 'favoritesTrees' | 'sessionMigrations' | 'sessionTitles'> & {
  workspaceWindows?: Identity<'workspaceWindow'>[];
  tenants: Identity<'tenant'>[]; sessions: Identity<'session'>[]; loginChallenges: Identity<'loginChallenge'>[];
  consumedProofs: Identity<'consumedProof'>[]; securityEvents?: Identity<'securityEvent'>[]; sessionStars?: Identity<'sessionStar'>[];
  favoritesTrees?: Identity<'favoritesTree'>[]; sessionMigrations?: Identity<'sessionMigration'>[]; sessionTitles?: Identity<'sessionTitle'>[];
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
export interface HostedSnapshot { records: Map<string, HostedEncodedRecord>; costs: HostedRecordCost[] }
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

/** Encoding bound only. The payload is never allocated or treated as valid domain evidence. */
export function quoteHostedRecord(input: { kind: string; owner: string; key: string; payloadJsonBytesUpperBound: number }): Pick<HostedRecordCost, 'byteLength' | 'chunkCount' | 'manifestBytes'> {
  if (!input || !isKind(input.kind) || typeof input.owner !== 'string' || typeof input.key !== 'string') invalid('quote tuple or kind');
  const bound = input.payloadJsonBytesUpperBound;
  if (!Number.isSafeInteger(bound) || bound < 0) invalid('quote payload length');
  const framing = jsonBytes(envelope(input.kind, input.owner, input.key, null)).byteLength - 4;
  const byteLength = framing + bound;
  if (!Number.isSafeInteger(byteLength)) invalid('quote length overflow');
  const manifest = manifestFor(input.kind, identityHash([input.kind, input.owner, input.key]), byteLength, '0'.repeat(64));
  const manifestBytes = jsonBytes(manifest).byteLength;
  if (!Number.isSafeInteger(byteLength + manifestBytes)) invalid('quote charge overflow');
  return { byteLength, chunkCount: manifest.chunk_count, manifestBytes };
}

/** Exact logical bytes and per-record chunks; manifestBytes measures its explicit JSON fields, not physical storage allocation. */
export function encodeHostedSnapshot(input: HostedRelayState, auth: HostedAuthOptions): HostedSnapshot {
  const state = validateRelayState(input, auth);
  const records = new Map<string, HostedEncodedRecord>();
  const tuples = new Set<string>(); const hashes = new Map<string, string>(); const costs: HostedRecordCost[] = [];
  function add<K extends HostedRecordKind>(kind: K, owner: string, key: string, payload: unknown): Identity<K> {
    const tuple: Identity<K> = [kind, owner, key]; const logical = tupleKey(tuple); const identity = identityHash(tuple);
    if (tuples.has(logical)) invalid('duplicate logical identity');
    if (hashes.has(identity) && hashes.get(identity) !== logical) invalid('identity hash collision');
    tuples.add(logical); hashes.set(identity, logical);
    const bytes = jsonBytes(envelope(kind, owner, key, payload));
    const manifest = manifestFor(kind, identity, bytes.byteLength, digest(bytes));
    const chunkCount = manifest.chunk_count;
    const chunks: HostedChunk[] = [];
    for (let ordinal = 0; ordinal < chunkCount; ordinal++) chunks.push({ kind, identity, ordinal, bytes: bytes.slice(ordinal * HOSTED_CHUNK_BYTES, (ordinal + 1) * HOSTED_CHUNK_BYTES) });
    records.set(physicalKey(kind, identity), { manifest, chunks });
    costs.push({ kind, owner, key, identity, byteLength: bytes.byteLength, chunkCount, manifestBytes: jsonBytes(manifest).byteLength,
      payloadStringBytes: jsonBytes(JSON.stringify(payload)).byteLength - 2 });
    return tuple;
  }
  function references<T, K extends HostedRecordKind>(values: T[], kind: K, owner: string, key: (value: T) => string, payload?: (value: T) => unknown): Identity<K>[];
  function references<T, K extends HostedRecordKind>(values: T[] | undefined, kind: K, owner: string, key: (value: T) => string, payload?: (value: T) => unknown): Identity<K>[] | undefined;
  function references<T, K extends HostedRecordKind>(values: T[] | undefined, kind: K, owner: string, key: (value: T) => string, payload: (value: T) => unknown = value => value) {
    return values?.map(value => add(kind, owner, key(value), payload(value)));
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
    tenants: state.tenants.map(tenant => {
      const owner = tenant.namespace; const source = tenant.broker;
      const broker: HostedBrokerHeader = { ...source,
        keys: references(source.keys, 'deviceKey', owner, value => value[0], value => value[1]),
        hosts: references(source.hosts, 'host', owner, value => value.id),
        bindings: references(source.bindings, 'binding', owner, value => value.agentId),
        creations: references(source.creations, 'creation', owner, value => value[0], value => value[1]),
        previews: references(source.previews, 'preview', owner, value => value.hostId),
        pairings: references(source.pairings, 'pairing', owner, value => value.id),
        revokedHosts: references(source.revokedHosts, 'revokedHost', owner, value => JSON.stringify([value.hostId, value.installationId])),
        sharing: source.sharing === undefined ? undefined : { ...source.sharing,
          grants: references(source.sharing.grants, 'share', owner, value => JSON.stringify([value.hostId, value.subject])),
          reservations: references(source.sharing.reservations, 'reservation', owner, value => value.key),
        },
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
    }),
  };
  add('relayHeader', '', 'relay', relay);
  preflightHostedSnapshot({ records, costs });
  return { records, costs };
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

export function decodeHostedSnapshot(manifests: HostedManifest[], chunks: HostedChunk[], auth: HostedAuthOptions): HostedRelayState {
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
  const expected = encodeHostedSnapshot(state, auth).records;
  if (expected.size !== manifests.length) invalid('identity coverage');
  for (const manifest of manifests) {
    const wanted = expected.get(physicalKey(manifest.kind, manifest.identity))?.manifest;
    if (!wanted || wanted.digest !== manifest.digest || wanted.byte_length !== manifest.byte_length || wanted.chunk_count !== manifest.chunk_count) invalid('payload identity or header mismatch');
  }
  return state;
}

/** Common logical admission accounting; runtimes retain their own persistence and durability guarantees. */
export function hostedRecordEncodingCosts(auth: HostedAuthOptions): SuccessionEncodingCosts {
  return {
    measureSnapshot: state => ({ snapshotFormat: HOSTED_SNAPSHOT_FORMAT, recordFormat: HOSTED_RECORD_FORMAT,
      chunkBytes: HOSTED_CHUNK_BYTES, costs: encodeHostedSnapshot(state, auth).costs }),
    quoteRecord: quoteHostedRecord,
  };
}
