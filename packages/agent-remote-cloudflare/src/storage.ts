import { createHmac } from 'node:crypto';
import { emptyRelayState, validateRelayState, type GatewayAuthOptions, type HostedRelayState, type RelayStateStore } from '@agent-remote-controller/agent-remote-hosted';

type RecordKind = 'securityEvent' | 'session' | 'tenant' | 'deviceKey' | 'host' | 'binding' | 'creation' | 'share' | 'reservation' | 'loginChallenge' | 'consumedProof';
type StoredRecord = { kind: RecordKind; owner: string; key: string; version: number; value: string };
const recordId = (record: Pick<StoredRecord, 'kind' | 'owner' | 'key'>) => JSON.stringify([record.kind, record.owner, record.key]);

/** Each independently bounded domain record occupies its own versioned SQL row. */
export class SqliteRelayStore implements RelayStateStore {
  readonly initial: HostedRelayState;
  private records: Map<string, StoredRecord>;
  constructor(private readonly storage: DurableObjectStorage, auth: GatewayAuthOptions) {
    const fingerprint = createHmac('sha256', auth.secret).update(JSON.stringify(['agent-remote-cloudflare', 1, auth.origin, auth.issuer])).digest('hex');
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
      const metadata = storage.sql.exec('SELECT * FROM relay_metadata WHERE id = 1').toArray()[0];
      if (metadata) {
        if (metadata.version !== 2 || metadata.origin !== auth.origin || metadata.issuer !== auth.issuer || metadata.fingerprint !== fingerprint) {
          throw new Error('Relay configuration does not match persisted state.');
        }
      } else {
        if (storage.sql.exec('SELECT key FROM relay_records LIMIT 1').toArray().length || storage.sql.exec('SELECT key FROM relay_security_events LIMIT 1').toArray().length) throw new Error('Relay metadata is missing.');
        storage.sql.exec('INSERT INTO relay_metadata (id, version, origin, issuer, fingerprint) VALUES (1, 2, ?, ?, ?)', auth.origin, auth.issuer, fingerprint);
      }
    });
    const rows = [...storage.sql.exec<StoredRecord>('SELECT kind, owner, key, version, value FROM relay_records').toArray(), ...storage.sql.exec<StoredRecord>('SELECT kind, owner, key, version, value FROM relay_security_events').toArray()];
    this.records = new Map(rows.map(row => [recordId(row), row]));
    this.initial = validateRelayState(decode(rows, auth), auth);
  }
  async commit(state: HostedRelayState): Promise<void> {
    const next = encode(state);
    this.storage.transactionSync(() => {
      for (const [id, row] of this.records) {
        if (!next.has(id)) this.storage.sql.exec(`DELETE FROM ${row.kind === 'securityEvent' ? 'relay_security_events' : 'relay_records'} WHERE kind = ? AND owner = ? AND key = ?`, row.kind, row.owner, row.key);
      }
      for (const [id, row] of next) {
        if (this.records.get(id)?.value === row.value) continue;
        this.storage.sql.exec(`INSERT INTO ${row.kind === 'securityEvent' ? 'relay_security_events' : 'relay_records'} (kind, owner, key, version, value) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (kind, owner, key) DO UPDATE SET value = excluded.value`, row.kind, row.owner, row.key, row.value);
      }
    });
    // Output gates also protect socket sends; the core's commit contract explicitly awaits disk durability.
    await this.storage.sync();
    this.records = next;
  }
}

function encode(state: HostedRelayState) {
  const records = new Map<string, StoredRecord>();
  function add(kind: RecordKind, owner: string, key: string, value: unknown) {
    const row = { kind, owner, key, version: 1, value: JSON.stringify(value) }; records.set(recordId(row), row);
  }
  for (const event of state.securityEvents ?? []) add('securityEvent', '', event.id, event);
  for (const session of state.sessions) add('session', '', session.hash, session);
  for (const [key, value] of state.loginChallenges) add('loginChallenge', '', key, value);
  for (const [key, value] of state.consumedProofs) add('consumedProof', '', key, value);
  for (const tenant of state.tenants) {
    const owner = tenant.namespace;
    add('tenant', '', owner, { subject: tenant.subject, sharing: tenant.broker.sharing !== undefined });
    for (const [key, value] of tenant.broker.keys) add('deviceKey', owner, key, value);
    for (const value of tenant.broker.hosts) add('host', owner, value.id, value);
    for (const value of tenant.broker.bindings) add('binding', owner, value.agentId, value);
    for (const [key, value] of tenant.broker.creations) add('creation', owner, key, value);
    for (const value of tenant.broker.sharing?.grants ?? []) add('share', owner, JSON.stringify([value.hostId, value.subject]), value);
    for (const value of tenant.broker.sharing?.reservations ?? []) add('reservation', owner, value.key, value);
  }
  return records;
}
function decode(rows: StoredRecord[], auth: GatewayAuthOptions): HostedRelayState {
  const state = emptyRelayState(auth);
  for (const row of rows.filter(value => value.kind === 'tenant')) {
    const value = JSON.parse(row.value);
    state.tenants.push({ namespace: row.key, subject: value.subject,
      broker: { keys: [], hosts: [], bindings: [], creations: [], ...(value.sharing ? { sharing: { grants: [], reservations: [] } } : {}) } });
  }
  for (const row of rows) {
    if (row.version !== 1) throw new Error('Unsupported Relay record version.');
    const value = JSON.parse(row.value);
    const broker = state.tenants.find(tenant => tenant.namespace === row.owner)?.broker;
    if (row.owner && !broker) throw new Error('Relay record owner is missing.');
    switch (row.kind) {
      case 'tenant': break;
      case 'securityEvent': (state.securityEvents ??= []).push(value); break;
      case 'session': state.sessions.push(value); break;
      case 'loginChallenge': state.loginChallenges.push([row.key, value]); break;
      case 'consumedProof': state.consumedProofs.push([row.key, value]); break;
      case 'deviceKey': broker!.keys.push([row.key, value]); break;
      case 'host': broker!.hosts.push(value); break;
      case 'binding': broker!.bindings.push(value); break;
      case 'creation': broker!.creations.push([row.key, value]); break;
      case 'share': if (!broker!.sharing) throw new Error('Relay sharing owner is missing.'); broker!.sharing.grants.push(value); break;
      case 'reservation': if (!broker!.sharing) throw new Error('Relay sharing owner is missing.'); broker!.sharing.reservations.push(value); break;
      default: throw new Error('Unsupported Relay record kind.');
    }
  }
  state.securityEvents?.sort((a, b) => a.at - b.at);
  const encoded = encode(state);
  if (encoded.size !== rows.length || rows.some(row => !encoded.has(recordId(row)))) throw new Error('Inconsistent Relay record identity.');
  return state;
}
