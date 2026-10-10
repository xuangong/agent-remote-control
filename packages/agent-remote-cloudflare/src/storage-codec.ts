import { createHash } from 'node:crypto';
import { validateRelayState, type GatewayAuthOptions, type HostedRelayState } from '@orchardworks/agent-remote-hosted';

export const SQL_SNAPSHOT_FORMAT = 3;
export const SQL_RECORD_FORMAT = 1;
export const SQL_CHUNK_BYTES = 262144;
export const SQL_RECORD_KINDS = ['relayHeader', 'tenant', 'brokerHeader', 'associationHeader', 'favoritesHeader',
  'session', 'loginChallenge', 'consumedProof', 'securityEvent', 'sessionStar', 'favoritesTree', 'sessionMigration',
  'sessionTitle', 'deviceKey', 'host', 'binding', 'creation', 'preview', 'pairing', 'share', 'reservation',
  'revokedHost', 'admission', 'freeze', 'relationChange', 'relationReset', 'favoritesReceipt'] as const;
export type SqlRecordKind = typeof SQL_RECORD_KINDS[number];
type Identity<K extends SqlRecordKind = SqlRecordKind> = [K, string, string];
type JsonObject = Record<string, unknown>;
type Tenant = HostedRelayState['tenants'][number];
type Broker = Tenant['broker'];
type Associations = NonNullable<Broker['associations']>;
type Favorites = NonNullable<Tenant['favoritesSuccession']>;
type SqlAssociationHeader = Omit<Associations, 'version' | 'admissions' | 'freezes' | 'relationChanges' | 'relationResets'> & {
  version: 1 | 2 | 3 | 4 | 5; admissions: Identity<'admission'>[]; freezes: Identity<'freeze'>[];
  relationChanges?: Identity<'relationChange'>[]; relationResets?: Identity<'relationReset'>[];
};
type SqlFavoritesHeader = Omit<Favorites, 'receipts'> & { receipts: Identity<'favoritesReceipt'>[] };
type SqlSharingHeader = Omit<NonNullable<Broker['sharing']>, 'grants' | 'reservations'> & {
  grants: Identity<'share'>[]; reservations: Identity<'reservation'>[];
};
type SqlBrokerHeader = Omit<Broker, 'keys' | 'hosts' | 'bindings' | 'creations' | 'previews' | 'pairings' | 'revokedHosts' | 'sharing' | 'associations'> & {
  keys: Identity<'deviceKey'>[]; hosts: Identity<'host'>[]; bindings: Identity<'binding'>[]; creations: Identity<'creation'>[];
  previews?: Identity<'preview'>[]; pairings?: Identity<'pairing'>[]; revokedHosts?: Identity<'revokedHost'>[];
  sharing?: SqlSharingHeader; associations?: Identity<'associationHeader'>;
};
type SqlTenantHeader = Omit<Tenant, 'broker' | 'favoritesSuccession'> & {
  broker: Identity<'brokerHeader'>; favoritesSuccession?: Identity<'favoritesHeader'>;
};
type SqlRelayHeader = Omit<HostedRelayState, 'tenants' | 'sessions' | 'loginChallenges' | 'consumedProofs' | 'securityEvents' | 'sessionStars' | 'favoritesTrees' | 'sessionMigrations' | 'sessionTitles'> & {
  tenants: Identity<'tenant'>[]; sessions: Identity<'session'>[]; loginChallenges: Identity<'loginChallenge'>[];
  consumedProofs: Identity<'consumedProof'>[]; securityEvents?: Identity<'securityEvent'>[]; sessionStars?: Identity<'sessionStar'>[];
  favoritesTrees?: Identity<'favoritesTree'>[]; sessionMigrations?: Identity<'sessionMigration'>[]; sessionTitles?: Identity<'sessionTitle'>[];
};
export type SqlManifest = {
  format: number; kind: SqlRecordKind; identity: string; byte_length: number; chunk_count: number; digest: string;
}
export type SqlChunk = { kind: SqlRecordKind; identity: string; ordinal: number; bytes: ArrayBuffer | Uint8Array };
export interface SqlEncodedRecord { manifest: SqlManifest; chunks: SqlChunk[] }
export interface SqlRecordCost {
  kind: SqlRecordKind; owner: string; key: string; identity: string; byteLength: number; chunkCount: number; manifestBytes: number;
}
export interface SqlSnapshot { records: Map<string, SqlEncodedRecord>; costs: SqlRecordCost[] }
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const safePositive = (value: number) => Number.isSafeInteger(value) && value > 0;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const tupleKey = (tuple: Identity) => JSON.stringify(tuple);
const identityHash = (tuple: Identity) => digest(tupleKey(tuple));
const physicalKey = (kind: SqlRecordKind, identity: string) => JSON.stringify([kind, identity]);
function invalid(message: string): never { throw new Error(`Invalid SQL snapshot: ${message}.`); }
function isKind(value: unknown): value is SqlRecordKind { return SQL_RECORD_KINDS.includes(value as SqlRecordKind); }
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const envelope = (kind: SqlRecordKind, owner: string, key: string, payload: unknown) => ({ format: SQL_RECORD_FORMAT, kind, owner, key, payload });
function manifestFor(kind: SqlRecordKind, identity: string, byteLength: number, contentDigest: string): SqlManifest {
  return { format: SQL_RECORD_FORMAT, kind, identity, byte_length: byteLength, chunk_count: Math.ceil(byteLength / SQL_CHUNK_BYTES), digest: contentDigest };
}

/** Encoding bound only. The payload is never allocated or treated as valid domain evidence. */
export function quoteSqlRecord(input: { kind: string; owner: string; key: string; payloadJsonBytesUpperBound: number }): Pick<SqlRecordCost, 'byteLength' | 'chunkCount' | 'manifestBytes'> {
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

/** Exact logical bytes and per-record chunks; manifestBytes measures its explicit JSON fields, not SQLite disk allocation. */
export function encodeSqlSnapshot(input: HostedRelayState, auth: GatewayAuthOptions): SqlSnapshot {
  const state = validateRelayState(input, auth);
  const records = new Map<string, SqlEncodedRecord>();
  const tuples = new Set<string>(); const hashes = new Map<string, string>(); const costs: SqlRecordCost[] = [];
  function add<K extends SqlRecordKind>(kind: K, owner: string, key: string, payload: unknown): Identity<K> {
    const tuple: Identity<K> = [kind, owner, key]; const logical = tupleKey(tuple); const identity = identityHash(tuple);
    if (tuples.has(logical)) invalid('duplicate logical identity');
    if (hashes.has(identity) && hashes.get(identity) !== logical) invalid('identity hash collision');
    tuples.add(logical); hashes.set(identity, logical);
    const bytes = jsonBytes(envelope(kind, owner, key, payload));
    const manifest = manifestFor(kind, identity, bytes.byteLength, digest(bytes));
    const chunkCount = manifest.chunk_count;
    const chunks: SqlChunk[] = [];
    for (let ordinal = 0; ordinal < chunkCount; ordinal++) chunks.push({ kind, identity, ordinal, bytes: bytes.slice(ordinal * SQL_CHUNK_BYTES, (ordinal + 1) * SQL_CHUNK_BYTES) });
    records.set(physicalKey(kind, identity), { manifest, chunks });
    costs.push({ kind, owner, key, identity, byteLength: bytes.byteLength, chunkCount, manifestBytes: jsonBytes(manifest).byteLength });
    return tuple;
  }
  function references<T, K extends SqlRecordKind>(values: T[], kind: K, owner: string, key: (value: T) => string, payload?: (value: T) => unknown): Identity<K>[];
  function references<T, K extends SqlRecordKind>(values: T[] | undefined, kind: K, owner: string, key: (value: T) => string, payload?: (value: T) => unknown): Identity<K>[] | undefined;
  function references<T, K extends SqlRecordKind>(values: T[] | undefined, kind: K, owner: string, key: (value: T) => string, payload: (value: T) => unknown = value => value) {
    return values?.map(value => add(kind, owner, key(value), payload(value)));
  }
  const relay: SqlRelayHeader = { ...state,
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
      const broker: SqlBrokerHeader = { ...source,
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
          const associations: SqlAssociationHeader = { ...source.associations,
            admissions: references(source.associations.admissions, 'admission', owner, value => value.id),
            freezes: references(source.associations.freezes, 'freeze', owner, value => value.receipt.token),
            relationChanges: references(source.associations.relationChanges, 'relationChange', owner, value => value.reservation.operationId),
            relationResets: references(source.associations.relationResets, 'relationReset', owner, value => value.intent.operationId),
          };
          return add('associationHeader', owner, 'associations', associations);
        })(),
      };
      const header: SqlTenantHeader = { ...tenant, broker: add('brokerHeader', owner, 'broker', broker),
        favoritesSuccession: tenant.favoritesSuccession === undefined ? undefined : (() => {
          const progress: SqlFavoritesHeader = { ...tenant.favoritesSuccession,
            receipts: references(tenant.favoritesSuccession.receipts, 'favoritesReceipt', owner, value => value.token),
          };
          return add('favoritesHeader', owner, 'favorites', progress);
        })(),
      };
      return add('tenant', '', owner, header);
    }),
  };
  add('relayHeader', '', 'relay', relay);
  preflightSqlSnapshot({ records, costs });
  return { records, costs };
}

/** No aggregate admission: these are only bounded physical identities, BLOBs and safe exact lengths. */
export function preflightSqlSnapshot(snapshot: SqlSnapshot): void {
  const manifests: SqlManifest[] = []; const chunks: SqlChunk[] = [];
  for (const [key, record] of snapshot.records) {
    if (key !== physicalKey(record.manifest.kind, record.manifest.identity)) invalid('physical identity');
    manifests.push(record.manifest); chunks.push(...record.chunks);
  }
  readSqlRecords(manifests, chunks);
}

function readSqlRecords(manifests: SqlManifest[], chunks: SqlChunk[]) {
  const records = new Map<string, { tuple: Identity; payload: unknown }>();
  const physical = new Set<string>(); const logical = new Set<string>(); const hashes = new Map<string, string>();
  const chunkGroups = new Map<string, Map<number, Uint8Array>>();
  for (const chunk of chunks) {
    if (!isKind(chunk.kind) || !/^[a-f0-9]{64}$/.test(chunk.identity) || !Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0) invalid('chunk identity or ordinal');
    if (!(chunk.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk.bytes)) invalid('non-BLOB chunk');
    const bytes = chunk.bytes instanceof ArrayBuffer ? new Uint8Array(chunk.bytes) : new Uint8Array(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
    if (!bytes.byteLength || bytes.byteLength > SQL_CHUNK_BYTES) invalid('chunk length');
    const key = physicalKey(chunk.kind, chunk.identity); const group = chunkGroups.get(key) ?? new Map<number, Uint8Array>();
    if (group.has(chunk.ordinal)) invalid('duplicate chunk ordinal');
    group.set(chunk.ordinal, bytes); chunkGroups.set(key, group);
  }
  for (const manifest of manifests) {
    if (manifest.format !== SQL_RECORD_FORMAT || !isKind(manifest.kind) || !/^[a-f0-9]{64}$/.test(manifest.identity)
      || !/^[a-f0-9]{64}$/.test(manifest.digest) || !safePositive(manifest.byte_length) || !safePositive(manifest.chunk_count)
      || manifest.chunk_count !== Math.ceil(manifest.byte_length / SQL_CHUNK_BYTES)) invalid('manifest format, identity or lengths');
    const key = physicalKey(manifest.kind, manifest.identity);
    if (physical.has(key)) invalid('duplicate manifest');
    physical.add(key);
    const group = chunkGroups.get(key);
    if (!group || group.size !== manifest.chunk_count) invalid('missing or excess chunks');
    const bytes = new Uint8Array(manifest.byte_length);
    for (let ordinal = 0; ordinal < manifest.chunk_count; ordinal++) {
      const chunk = group.get(ordinal); const expected = Math.min(SQL_CHUNK_BYTES, manifest.byte_length - ordinal * SQL_CHUNK_BYTES);
      if (!chunk || chunk.byteLength !== expected) invalid('noncontiguous or wrong-sized chunk');
      bytes.set(chunk, ordinal * SQL_CHUNK_BYTES);
    }
    if (digest(bytes) !== manifest.digest) invalid('record digest');
    let envelope: unknown;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { invalid('record JSON or UTF-8'); }
    if (!object(envelope) || Object.keys(envelope).join(',') !== 'format,kind,owner,key,payload' || envelope.format !== SQL_RECORD_FORMAT
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

export function decodeSqlSnapshot(manifests: SqlManifest[], chunks: SqlChunk[], auth: GatewayAuthOptions): HostedRelayState {
  const records = readSqlRecords(manifests, chunks); const consumed = new Set<string>();
  function take(ref: unknown, kind: SqlRecordKind, owner: string, key?: string) {
    if (!Array.isArray(ref) || ref.length !== 3 || ref[0] !== kind || ref[1] !== owner || typeof ref[2] !== 'string' || key !== undefined && ref[2] !== key) invalid('header child identity');
    const id = JSON.stringify(ref); const record = records.get(id);
    if (!record || consumed.has(id)) invalid('missing or repeated child');
    consumed.add(id); return record.payload;
  }
  function header(ref: unknown, kind: SqlRecordKind, owner: string, key: string): JsonObject {
    const value = take(ref, kind, owner, key);
    if (!object(value)) invalid('header payload');
    return value;
  }
  function collection(parent: JsonObject, field: string, kind: SqlRecordKind, owner: string, required = false, tuples = false) {
    if (!Object.hasOwn(parent, field)) { if (required) invalid('missing required collection'); return; }
    const refs = parent[field];
    if (!Array.isArray(refs)) invalid('collection presence');
    parent[field] = refs.map((ref: unknown) => {
      const value = take(ref, kind, owner); return tuples ? [(ref as Identity)[2], value] : value;
    });
  }
  const relay = header(['relayHeader', '', 'relay'], 'relayHeader', '', 'relay');
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
  const expected = encodeSqlSnapshot(state, auth).records;
  if (expected.size !== manifests.length) invalid('identity coverage');
  for (const manifest of manifests) {
    const wanted = expected.get(physicalKey(manifest.kind, manifest.identity))?.manifest;
    if (!wanted || wanted.digest !== manifest.digest || wanted.byte_length !== manifest.byte_length || wanted.chunk_count !== manifest.chunk_count) invalid('payload identity or header mismatch');
  }
  return state;
}
