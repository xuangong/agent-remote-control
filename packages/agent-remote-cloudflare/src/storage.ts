import { createHmac } from 'node:crypto';
import { SQL_SNAPSHOT_FORMAT, decodeSqlSnapshot, encodeSqlSnapshot, type SqlManifest, type SqlChunk, type SqlEncodedRecord } from './storage-codec.js';
import { emptyRelayState, hostedAuthStateConfig, hostedAuthStorageIdentity, resolveHostedAuth, validateRelayState, type HostedAuthOptions, type HostedRelayState, type RelayStateStore } from '@orchardworks/agent-remote-hosted';

type RecordKind = 'sessionTitle' | 'sessionTitleRevision' | 'favoritesTree' | 'sessionMigration' | 'sessionStar' | 'preview' | 'securityEvent' | 'session' | 'tenant' | 'deviceKey' | 'host' | 'binding' | 'creation' | 'share' | 'reservation' | 'loginChallenge' | 'consumedProof';
type StoredRecord = { kind: RecordKind; owner: string; key: string; version: number; value: string };
const recordTable = (kind: RecordKind) => kind === 'sessionTitle' || kind === 'sessionTitleRevision' ? 'relay_session_titles' : kind === 'favoritesTree' ? 'relay_favorites_trees' : kind === 'sessionMigration' ? 'relay_session_migrations' : kind === 'sessionStar' ? 'relay_session_stars' : kind === 'preview' ? 'relay_previews' : kind === 'securityEvent' ? 'relay_security_events' : 'relay_records';
const recordId = (record: Pick<StoredRecord, 'kind' | 'owner' | 'key'>) => JSON.stringify([record.kind, record.owner, record.key]);

const legacyTables = ['relay_records', 'relay_security_events', 'relay_previews', 'relay_session_stars',
  'relay_session_migrations', 'relay_favorites_trees', 'relay_session_titles'] as const;
/** Complete chunked snapshot publication shares the existing atomic transaction and durability gate. */
export class SqliteRelayStore implements RelayStateStore {
  readonly initial: HostedRelayState;
  private records: Map<string, SqlEncodedRecord> = new Map();
  private format: number;
  private durabilityUnknown = false;
  constructor(private readonly storage: DurableObjectStorage, private readonly auth: HostedAuthOptions) {
    auth = this.auth = resolveHostedAuth(auth);
    const config = hostedAuthStateConfig(auth);
    // Flatten the shared identity to retain the original Gateway fingerprint bytes.
    const fingerprint = createHmac('sha256', auth.secret).update(JSON.stringify(['agent-remote-cloudflare', 1, ...JSON.parse(hostedAuthStorageIdentity(auth))])).digest('hex');
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, origin TEXT NOT NULL, issuer TEXT NOT NULL, fingerprint TEXT NOT NULL
      )`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_records (
        kind TEXT NOT NULL CHECK (kind IN ('session','tenant','deviceKey','host','binding','creation','share','reservation','loginChallenge','consumedProof')),
        owner TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), value TEXT NOT NULL CHECK (json_valid(value)),
        PRIMARY KEY (kind, owner, key)
      )`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_security_events (kind TEXT NOT NULL CHECK (kind = 'securityEvent'), owner TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), value TEXT NOT NULL CHECK (json_valid(value)), PRIMARY KEY (kind, owner, key))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_previews (kind TEXT NOT NULL CHECK (kind = 'preview'), owner TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), value TEXT NOT NULL CHECK (json_valid(value)), PRIMARY KEY (kind, owner, key))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_session_stars (kind TEXT NOT NULL CHECK (kind = 'sessionStar'), owner TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), value TEXT NOT NULL CHECK (json_valid(value)), PRIMARY KEY (kind, owner, key))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_session_migrations (kind TEXT NOT NULL CHECK (kind = 'sessionMigration'), owner TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), value TEXT NOT NULL CHECK (json_valid(value)), PRIMARY KEY (kind, owner, key))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_favorites_trees (kind TEXT NOT NULL CHECK (kind = 'favoritesTree'), owner TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), value TEXT NOT NULL CHECK (json_valid(value)), PRIMARY KEY (kind, owner, key))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_session_titles (kind TEXT NOT NULL CHECK (kind IN ('sessionTitle', 'sessionTitleRevision')), owner TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), value TEXT NOT NULL CHECK (json_valid(value)), PRIMARY KEY (kind, owner, key))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_snapshot_manifests (
        kind TEXT NOT NULL, identity TEXT NOT NULL CHECK (length(identity) = 64), format INTEGER NOT NULL,
        byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL CHECK (length(digest) = 64),
        PRIMARY KEY (kind, identity)
      )`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_snapshot_chunks (
        kind TEXT NOT NULL, identity TEXT NOT NULL CHECK (length(identity) = 64), ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        bytes BLOB NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) BETWEEN 1 AND 262144),
        PRIMARY KEY (kind, identity, ordinal)
      )`);
      const metadata = storage.sql.exec('SELECT * FROM relay_metadata WHERE id = 1').toArray()[0];
      if (metadata) {
        if (![2, SQL_SNAPSHOT_FORMAT].includes(metadata.version as number) || metadata.origin !== config.origin || metadata.issuer !== config.issuer || metadata.fingerprint !== fingerprint) {
          throw new Error('Relay configuration does not match persisted state.');
        }
      } else {
        if (storage.sql.exec('SELECT identity FROM relay_snapshot_manifests LIMIT 1').toArray().length || storage.sql.exec('SELECT identity FROM relay_snapshot_chunks LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_session_titles LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_favorites_trees LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_session_migrations LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_session_stars LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_records LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_security_events LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_previews LIMIT 1').toArray().length) throw new Error('Relay metadata is missing.');
        storage.sql.exec('INSERT INTO relay_metadata (id, version, origin, issuer, fingerprint) VALUES (1, 2, ?, ?, ?)', config.origin, config.issuer, fingerprint);
      }
    });
    const metadata = storage.sql.exec('SELECT version FROM relay_metadata WHERE id = 1').toArray()[0]!;
    this.format = metadata.version as number;
    const legacyRows = legacyTables.flatMap(table => storage.sql.exec<StoredRecord>(`SELECT kind, owner, key, version, value FROM ${table}`).toArray().map(row => {
      if (recordTable(row.kind) !== table) throw new Error('Invalid legacy Relay table kind.');
      return row;
    }));
    const manifests = storage.sql.exec<SqlManifest>('SELECT kind, identity, format, byte_length, chunk_count, digest FROM relay_snapshot_manifests').toArray();
    const chunks = storage.sql.exec<Omit<SqlChunk, 'bytes'> & { bytes: ArrayBuffer }>('SELECT kind, identity, ordinal, bytes FROM relay_snapshot_chunks').toArray();
    if (this.format === 2) {
      if (manifests.length || chunks.length) throw new Error('Unmarked mixed SQL snapshot formats.');
      if (new Set(legacyRows.map(recordId)).size !== legacyRows.length) throw new Error('Duplicate legacy Relay identity.');
      this.initial = validateRelayState(decode(legacyRows, auth), auth);
    } else {
      if (legacyRows.length) throw new Error('Legacy records remain in SQL snapshot format 3.');
      this.initial = decodeSqlSnapshot(manifests, chunks, auth);
      this.records = encodeSqlSnapshot(this.initial, auth).records;
    }
  }
  async commit(state: HostedRelayState): Promise<void> {
    if (this.durabilityUnknown) throw new Error('Relay SQL durability is unknown.');
    const next = encodeSqlSnapshot(state, this.auth);
    this.storage.transactionSync(() => {
      for (const [id, record] of this.records) {
        if (next.records.has(id)) continue;
        this.storage.sql.exec('DELETE FROM relay_snapshot_chunks WHERE kind = ? AND identity = ?', record.manifest.kind, record.manifest.identity);
        this.storage.sql.exec('DELETE FROM relay_snapshot_manifests WHERE kind = ? AND identity = ?', record.manifest.kind, record.manifest.identity);
      }
      for (const [id, record] of next.records) {
        const row = record.manifest; const previous = this.records.get(id)?.manifest;
        if (previous && previous.format === row.format && previous.digest === row.digest && previous.byte_length === row.byte_length && previous.chunk_count === row.chunk_count) continue;
        this.storage.sql.exec('DELETE FROM relay_snapshot_chunks WHERE kind = ? AND identity = ?', row.kind, row.identity);
        this.storage.sql.exec(`INSERT INTO relay_snapshot_manifests (kind, identity, format, byte_length, chunk_count, digest) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (kind, identity) DO UPDATE SET format = excluded.format, byte_length = excluded.byte_length, chunk_count = excluded.chunk_count, digest = excluded.digest`,
          row.kind, row.identity, row.format, row.byte_length, row.chunk_count, row.digest);
        for (const chunk of record.chunks) {
          const bytes = chunk.bytes instanceof Uint8Array ? chunk.bytes.slice().buffer : chunk.bytes;
          this.storage.sql.exec('INSERT INTO relay_snapshot_chunks (kind, identity, ordinal, bytes) VALUES (?, ?, ?, ?)', chunk.kind, chunk.identity, chunk.ordinal, bytes);
        }
      }
      if (this.format === 2) {
        for (const table of legacyTables) this.storage.sql.exec(`DELETE FROM ${table}`);
        this.storage.sql.exec('UPDATE relay_metadata SET version = ? WHERE id = 1', SQL_SNAPSHOT_FORMAT);
      }
    });
    // A rejected sync does not prove rollback; the caller closes publication and restart revalidates exposed SQL.
    try { await this.storage.sync(); } catch (error) { this.durabilityUnknown = true; throw error; }
    this.records = next.records; this.format = SQL_SNAPSHOT_FORMAT;
  }
}

function encodeLegacyRecords(state: HostedRelayState) {
  const records = new Map<string, StoredRecord>();
  function add(kind: RecordKind, owner: string, key: string, value: unknown) {
    const row = { kind, owner, key, version: 1, value: JSON.stringify(value) }; records.set(recordId(row), row);
  }
  if (state.sessionTitleRevision !== undefined) add('sessionTitleRevision', '', 'revision', state.sessionTitleRevision);
  for (const session of state.sessionTitles ?? []) add('sessionTitle', '', JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]), session);
  for (const item of state.sessionMigrations ?? []) add('sessionMigration', item.subject, item.id, item);
  for (const tree of state.favoritesTrees ?? []) add('favoritesTree', tree.subject, 'tree', tree);
  for (const star of state.sessionStars ?? []) add('sessionStar', star.subject, JSON.stringify([star.hostId, star.providerId, star.nativeSessionId]), star);
  for (const event of state.securityEvents ?? []) add('securityEvent', '', event.id, event);
  for (const session of state.sessions) add('session', '', session.hash, session);
  for (const [key, value] of state.loginChallenges) add('loginChallenge', '', key, value);
  for (const [key, value] of state.consumedProofs) add('consumedProof', '', key, value);
  for (const tenant of state.tenants) {
    const owner = tenant.namespace;
    add('tenant', '', owner, { subject: tenant.subject, sharing: tenant.broker.sharing !== undefined });
    for (const [key, value] of tenant.broker.keys) add('deviceKey', owner, key, value);
    for (const value of tenant.broker.hosts) add('host', owner, value.id, value);
    for (const value of tenant.broker.previews ?? []) add('preview', owner, value.hostId, value);
    for (const value of tenant.broker.bindings) add('binding', owner, value.agentId, value);
    for (const [key, value] of tenant.broker.creations) add('creation', owner, key, value);
    for (const value of tenant.broker.sharing?.grants ?? []) add('share', owner, JSON.stringify([value.hostId, value.subject]), value);
    for (const value of tenant.broker.sharing?.reservations ?? []) add('reservation', owner, value.key, value);
  }
  return records;
}
function decode(rows: StoredRecord[], auth: HostedAuthOptions): HostedRelayState {
  const kinds: RecordKind[] = ['sessionTitle', 'sessionTitleRevision', 'favoritesTree', 'sessionMigration', 'sessionStar', 'preview', 'securityEvent', 'session', 'tenant', 'deviceKey', 'host', 'binding', 'creation', 'share', 'reservation', 'loginChallenge', 'consumedProof'];
  if (rows.some(row => !kinds.includes(row.kind) || row.version !== 1 || typeof row.owner !== 'string' || typeof row.key !== 'string' || typeof row.value !== 'string')) throw new Error('Unsupported legacy Relay record kind or version.');
  const state = emptyRelayState(auth);
  for (const row of rows.filter(value => value.kind === 'tenant')) {
    const value = JSON.parse(row.value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.sharing !== 'boolean') throw new Error('Invalid legacy Relay tenant header.');
    state.tenants.push({ namespace: row.key, subject: value.subject,
      broker: { keys: [], hosts: [], bindings: [], creations: [], ...(value.sharing ? { sharing: { grants: [], reservations: [] } } : {}) } });
  }
  for (const row of rows) {
    if (row.version !== 1) throw new Error('Unsupported Relay record version.');
    const value = JSON.parse(row.value);
    const broker = state.tenants.find(tenant => tenant.namespace === row.owner)?.broker;
    if (row.owner && !broker && row.kind !== 'sessionStar' && row.kind !== 'sessionMigration' && row.kind !== 'favoritesTree') throw new Error('Relay record owner is missing.');
    switch (row.kind) {
      case 'tenant': break;
      case 'sessionTitleRevision': state.sessionTitleRevision = value; break;
      case 'sessionTitle': (state.sessionTitles ??= []).push(value); break;
      case 'sessionMigration': (state.sessionMigrations ??= []).push(value); break;
      case 'favoritesTree': (state.favoritesTrees ??= []).push(value); break;
      case 'sessionStar': (state.sessionStars ??= []).push(value); break;
      case 'securityEvent': (state.securityEvents ??= []).push(value); break;
      case 'session': state.sessions.push(value); break;
      case 'loginChallenge': state.loginChallenges.push([row.key, value]); break;
      case 'consumedProof': state.consumedProofs.push([row.key, value]); break;
      case 'deviceKey': broker!.keys.push([row.key, value]); break;
      case 'host': broker!.hosts.push(value); break;
      case 'preview': (broker!.previews ??= []).push(value); break;
      case 'binding': broker!.bindings.push(value); break;
      case 'creation': broker!.creations.push([row.key, value]); break;
      case 'share': if (!broker!.sharing) throw new Error('Relay sharing owner is missing.'); broker!.sharing.grants.push(value); break;
      case 'reservation': if (!broker!.sharing) throw new Error('Relay sharing owner is missing.'); broker!.sharing.reservations.push(value); break;
      default: throw new Error('Unsupported Relay record kind.');
    }
  }
  state.securityEvents?.sort((a, b) => a.at - b.at);
  const encoded = encodeLegacyRecords(state);
  if (encoded.size !== rows.length || rows.some(row => !encoded.has(recordId(row)))) throw new Error('Inconsistent Relay record identity.');
  return state;
}
