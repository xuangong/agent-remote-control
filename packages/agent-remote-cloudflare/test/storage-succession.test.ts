import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { createRelayState } from '../../agent-remote-hosted/src/state.js';
import { createHostBroker, emptyRelayState, type HostedRelayState } from '@orchardworks/agent-remote-hosted';
import { SqliteRelayStore } from '../src/storage.js';
import { decodeSqlSnapshot, encodeSqlSnapshot, quoteSqlRecord, SQL_CHUNK_BYTES, type SqlChunk, type SqlManifest } from '../src/storage-codec.js';
import { codecState } from './storage-codec-fixture.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
test('quotes the actual record envelope and manifest without allocating a payload', () => {
  const state: any = emptyRelayState(auth);
  state.padding = '';
  const baseline = encodeSqlSnapshot(state, auth).costs[0]!;
  for (const length of [SQL_CHUNK_BYTES, SQL_CHUNK_BYTES + 1, SQL_CHUNK_BYTES * 9, SQL_CHUNK_BYTES * 9 + 1]) {
    state.padding = 'x'.repeat(length - baseline.byteLength);
    const actual = encodeSqlSnapshot(state, auth).costs[0]!;
    const quote = quoteSqlRecord({ kind: 'relayHeader', owner: '', key: 'relay', payloadJsonBytesUpperBound: Buffer.byteLength(JSON.stringify(state)) });
    expect(quote).toEqual({ byteLength: actual.byteLength, chunkCount: actual.chunkCount, manifestBytes: actual.manifestBytes });
  }
  const full = codecState(auth);
  full.tenants[0]!.broker.creations[0]![0] = 'escape\\"😀\ud800';
  for (const cost of encodeSqlSnapshot(full, auth).costs) {
    const framing = quoteSqlRecord({ ...cost, payloadJsonBytesUpperBound: 0 }).byteLength;
    expect(Buffer.byteLength(JSON.stringify([cost.kind, cost.owner, cost.key]))).toBeLessThanOrEqual(framing);
    const exact = quoteSqlRecord({ ...cost, payloadJsonBytesUpperBound: cost.byteLength - framing });
    expect(exact).toEqual({ byteLength: cost.byteLength, chunkCount: cost.chunkCount, manifestBytes: cost.manifestBytes });
    const larger = quoteSqlRecord({ ...cost, payloadJsonBytesUpperBound: cost.byteLength - framing + 1 });
    expect(larger.byteLength).toBeGreaterThanOrEqual(cost.byteLength);
    expect(larger.manifestBytes).toBeGreaterThanOrEqual(cost.manifestBytes);
  }
  expect(quoteSqlRecord({ kind: 'freeze', owner: 'owner', key: 'token', payloadJsonBytesUpperBound: 10 ** 12 }).byteLength).toBeGreaterThan(10 ** 12);
}, 10000);

test('rejects unsupported or incomplete quote tuples and unsafe lengths before allocation', () => {
  for (const input of [
    { kind: 'invented', owner: '', key: 'relay', payloadJsonBytesUpperBound: 1 },
    { kind: 'freeze', key: 'token', payloadJsonBytesUpperBound: 1 },
    { kind: 'freeze', owner: 'owner', payloadJsonBytesUpperBound: 1 },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1].map(payloadJsonBytesUpperBound => ({ kind: 'freeze', owner: 'owner', key: 'token', payloadJsonBytesUpperBound })),
  ]) expect(() => quoteSqlRecord(input as any)).toThrow(/quote|length|tuple|kind/i);
}, 10000);
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); }, 10000);
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let reverse = false;
  const storage = {
    sql: { exec(query: string, ...bindings: any[]) { const statement = db.prepare(query);
      bindings = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => reverse ? [...rows].reverse() : rows }; } },
    transactionSync<T>(change: () => T) { db.exec('BEGIN'); try { const result = change(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    async sync() {},
  } as unknown as DurableObjectStorage;
  const store = new SqliteRelayStore(storage, auth);
  const snapshot = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(row => [row.name, db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()]));
  return { store, storage, snapshot, db, shuffle() { reverse = true; } };
}
const reopen = (storage: DurableObjectStorage) => new SqliteRelayStore(storage, auth);
function physical(db: DatabaseSync) {
  return { manifests: db.prepare('SELECT * FROM relay_snapshot_manifests').all() as unknown as SqlManifest[],
    chunks: db.prepare('SELECT * FROM relay_snapshot_chunks').all() as unknown as SqlChunk[] };
}
function rewrite(db: DatabaseSync, kind: string, change: (record: any) => void) {
  const row = db.prepare('SELECT * FROM relay_snapshot_manifests WHERE kind = ? LIMIT 1').get(kind) as any;
  const chunks = db.prepare('SELECT bytes FROM relay_snapshot_chunks WHERE kind = ? AND identity = ? ORDER BY ordinal').all(kind, row.identity);
  const record = JSON.parse(Buffer.concat(chunks.map(chunk => chunk.bytes as Uint8Array)).toString()); change(record);
  const bytes = Buffer.from(JSON.stringify(record));
  db.prepare('UPDATE relay_snapshot_manifests SET byte_length = ?, chunk_count = ?, digest = ? WHERE kind = ? AND identity = ?').run(bytes.length, Math.ceil(bytes.length / SQL_CHUNK_BYTES), createHash('sha256').update(bytes).digest('hex'), kind, row.identity);
  db.prepare('DELETE FROM relay_snapshot_chunks WHERE kind = ? AND identity = ?').run(kind, row.identity);
  for (let ordinal = 0; ordinal < Math.ceil(bytes.length / SQL_CHUNK_BYTES); ordinal++) db.prepare('INSERT INTO relay_snapshot_chunks VALUES (?, ?, ?, ?)').run(kind, row.identity, ordinal, bytes.subarray(ordinal * SQL_CHUNK_BYTES, (ordinal + 1) * SQL_CHUNK_BYTES));
}
test('default store accepts supported Relay versions and rejects incomplete state before changing SQLite rows', async () => {
  const f = fixture(); const normal = emptyRelayState(auth);
  normal.favoritesTrees = [{ subject: 'owner', revision: 1, folders: [{ id: 'folder', parentId: null, title: 'Original', order: 0 }] }];
  for (const version of [6, 7, 8] as const) {
    const supported = { ...normal, version };
    await f.store.commit(supported);
    expect(new SqliteRelayStore(f.storage, auth).initial).toEqual(supported);
  }
  await f.store.commit(normal); const before = f.snapshot();
  for (const change of [
    (state: any) => { state.tenants = [{ subject: 'owner', namespace: 'namespace', broker: { revokedHosts: [] } }]; },
    (state: any) => { state.tenants = [{ subject: 'owner', namespace: 'namespace', broker: { keys: [['key', { recovery: {} }]] } }]; },
    (state: any) => { state.tenants = [{ subject: 'owner', namespace: 'namespace', broker: { pairings: [{ recovery: {} }] } }]; },
    (state: any) => { state.tenants = [{ subject: 'owner', namespace: 'namespace', broker: { associations: { version: 4 } } }]; },
    (state: any) => { state.tenants = [{ subject: 'owner', namespace: 'namespace', favoritesSuccession: { version: 1, receipts: [] }, broker: {} }]; },
  ]) {
    const state = structuredClone(normal); state.favoritesTrees![0]!.folders[0]!.title = 'Must not persist'; change(state);
    await expect(f.store.commit(state as HostedRelayState)).rejects.toThrow(/unsupported|succession|invalid|state/i);
    expect(f.snapshot()).toBe(before);
  }
  expect(new SqliteRelayStore(f.storage, auth).initial.favoritesTrees).toEqual(normal.favoritesTrees);
}, 10000);

test('roundtrips the complete frozen inventory, actual versions and nested receipt bytes independently of SQL order', async () => {
  const f = fixture(); const state = codecState(auth);
  await f.store.commit(state); f.shuffle();
  expect(reopen(f.storage).initial).toEqual(state);
  expect(JSON.stringify(reopen(f.storage).initial.tenants[0]!.broker.associations!.freezes)).toBe(JSON.stringify(state.tenants[0]!.broker.associations!.freezes));
  expect(new SqliteRelayStore(f.storage, auth).initial).toEqual(state);
  const next = structuredClone(state); next.tenants.reverse(); next.securityEvents!.reverse();
  next.tenants[1]!.broker.pairings!.reverse(); next.tenants[1]!.broker.creations = [];
  await f.store.commit(next); expect(reopen(f.storage).initial).toEqual(next);
  next.tenants[1]!.broker.creations = structuredClone(state.tenants[0]!.broker.creations);
  await f.store.commit(next); expect(reopen(f.storage).initial).toEqual(next);
  const legacy = structuredClone(state) as any; legacy.version = 8; legacy.tenants[0].broker.associations.version = 4;
  for (const freeze of legacy.tenants[0].broker.associations.freezes) { freeze.receipt.version = 1; delete freeze.receipt.maxProjectionBytes; }
  // Receipt identity changed, so these historic fixtures carry no invented progress hash.
  delete legacy.tenants[0].favoritesSuccession;
  await f.store.commit(legacy); expect(reopen(f.storage).initial).toEqual(legacy);
}, 10000);

test('migrates real format2 rows atomically, fences old readers and rejects unmarked or retained legacy rows', async () => {
  const f = fixture(); const owner = createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex');
  const viewer = createHash('sha256').update(JSON.stringify([auth.issuer, 'viewer'])).digest('hex');
  const insert = f.db.prepare('INSERT INTO relay_records VALUES (?, ?, ?, 1, ?)');
  for (const [namespace, subject] of [[owner, 'owner'], [viewer, 'viewer']]) {
    insert.run('tenant', '', namespace!, JSON.stringify({ subject, sharing: true }));
    insert.run('deviceKey', namespace!, 'a'.repeat(64), JSON.stringify({ expires: 1 }));
  }
  f.db.prepare('INSERT INTO relay_security_events VALUES (?, ?, ?, 1, ?)').run('securityEvent', '', 'old', JSON.stringify({ id: 'old', at: 1, subject: 'owner', action: 'login', outcome: 'allowed' }));
  const legacy = new SqliteRelayStore(f.storage, auth);
  expect(legacy.initial.version).toBe(2); expect(legacy.initial.tenants).toHaveLength(2);
  expect(legacy.initial.tenants[0]!.broker).not.toHaveProperty('pairings');
  const before = f.snapshot();
  f.db.exec("CREATE TRIGGER fail_upgrade BEFORE UPDATE ON relay_metadata BEGIN SELECT RAISE(ABORT, 'upgrade failure'); END");
  await expect(legacy.commit(legacy.initial)).rejects.toThrow(/upgrade failure/); expect(f.snapshot()).toBe(before);
  f.db.exec('DROP TRIGGER fail_upgrade'); await legacy.commit(legacy.initial);
  expect(f.db.prepare('SELECT version FROM relay_metadata').get()!.version).toBe(3);
  expect(f.db.prepare('SELECT count(*) AS n FROM relay_records').get()!.n).toBe(0);
  // The released format2 reader checks this exact marker before reading any state.
  expect(f.db.prepare('SELECT version FROM relay_metadata').get()!.version === 2).toBe(false);
  expect(new SqliteRelayStore(f.storage, auth).initial).toEqual(legacy.initial);
  f.db.exec('UPDATE relay_metadata SET version = 2'); expect(() => new SqliteRelayStore(f.storage, auth)).toThrow(/mixed/);
  f.db.exec('UPDATE relay_metadata SET version = 3'); insert.run('tenant', '', owner, JSON.stringify({ subject: 'owner', sharing: false }));
  expect(() => new SqliteRelayStore(f.storage, auth)).toThrow(/Legacy records remain/);
}, 10000);

test('rejects configuration, legacy kinds, versions, identity conflicts and missing metadata before restore', () => {
  const f = fixture();
  expect(() => new SqliteRelayStore(f.storage, { ...auth, origin: 'https://other.example' })).toThrow(/configuration/);
  expect(() => new SqliteRelayStore(f.storage, { ...auth, secret: 'other'.repeat(10) })).toThrow(/configuration/);
  f.db.exec('PRAGMA ignore_check_constraints = ON');
  f.db.prepare('INSERT INTO relay_records VALUES (?, ?, ?, ?, ?)').run('unknown', '', 'bad', 1, '{}');
  expect(() => new SqliteRelayStore(f.storage, auth)).toThrow(/kind/);
  f.db.exec('DELETE FROM relay_records');
  f.db.prepare('INSERT INTO relay_records VALUES (?, ?, ?, ?, ?)').run('consumedProof', '', 'proof-proof-proof', 9, '1');
  expect(() => new SqliteRelayStore(f.storage, auth)).toThrow(/version/);
  f.db.exec('DELETE FROM relay_records');
  f.db.prepare('INSERT INTO relay_records VALUES (?, ?, ?, ?, ?)').run('consumedProof', '', 'proof-proof-proof', 1, '1');
  f.db.exec('DELETE FROM relay_metadata'); expect(() => new SqliteRelayStore(f.storage, auth)).toThrow(/metadata/);
}, 10000);

test('splits exact 256KiB and next-byte records, multibyte JSON, long logical keys and ordered headers with exact costs', async () => {
  const f = fixture(); const state: any = emptyRelayState(auth); state.padding = '';
  const overhead = encodeSqlSnapshot(state, auth).costs[0]!.byteLength;
  for (const length of [SQL_CHUNK_BYTES, SQL_CHUNK_BYTES + 1]) {
    state.padding = 'x'.repeat(length - overhead);
    const encoded = encodeSqlSnapshot(state, auth); expect(encoded.costs[0]!.byteLength).toBe(length);
    expect(encoded.costs[0]!.chunkCount).toBe(length === SQL_CHUNK_BYTES ? 1 : 2);
    await f.store.commit(state); expect(reopen(f.storage).initial).toEqual(state);
  }
  state.padding = 'x'.repeat(SQL_CHUNK_BYTES - overhead - 1) + '😀\ud800';
  await f.store.commit(state); expect(reopen(f.storage).initial).toEqual(state);
  const full = codecState(auth); full.tenants[0]!.broker.bindings = Array.from({ length: 80 }, (_, index) => ({ agentId: 'a'.repeat(4090) + index, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'native-' + index }));
  full.tenants[0]!.broker.creations = [];
  full.tenants[0]!.broker.sharing!.reservations[0]!.key = '\ud800'.repeat(65536);
  const encoded = encodeSqlSnapshot(full, auth);
  expect(encoded.costs.find(row => row.kind === 'brokerHeader')!.chunkCount).toBeGreaterThan(1);
  expect(encoded.costs.find(row => row.kind === 'reservation')!.chunkCount).toBeGreaterThan(1);
  expect(encoded.costs.reduce((sum, row) => sum + row.chunkCount, 0)).toBe([...encoded.records.values()].reduce((sum, row) => sum + row.chunks.length, 0));
  await f.store.commit(full); expect(reopen(f.storage).initial).toEqual(full);
  expect(f.db.prepare('SELECT max(length(bytes)) AS n FROM relay_snapshot_chunks').get()!.n).toBeLessThanOrEqual(SQL_CHUNK_BYTES);
  expect(f.db.prepare('SELECT max(length(identity)) AS n FROM relay_snapshot_manifests').get()!.n).toBe(64);
}, 15000);

test.each([
  ['future manifest', (f: ReturnType<typeof fixture>) => f.db.exec('UPDATE relay_snapshot_manifests SET format = 9')],
  ['unknown kind', (f: ReturnType<typeof fixture>) => f.db.exec("UPDATE relay_snapshot_manifests SET kind = 'unknown'")],
  ['digest', (f: ReturnType<typeof fixture>) => f.db.exec("UPDATE relay_snapshot_manifests SET digest = '" + '0'.repeat(64) + "'")],
  ['count', (f: ReturnType<typeof fixture>) => f.db.exec('UPDATE relay_snapshot_manifests SET chunk_count = chunk_count + 1')],
  ['missing chunk', (f: ReturnType<typeof fixture>) => f.db.exec('DELETE FROM relay_snapshot_chunks WHERE rowid = (SELECT min(rowid) FROM relay_snapshot_chunks)')],
  ['ordinal gap', (f: ReturnType<typeof fixture>) => f.db.exec('UPDATE relay_snapshot_chunks SET ordinal = ordinal + 1')],
  ['missing header', (f: ReturnType<typeof fixture>) => f.db.exec("DELETE FROM relay_snapshot_manifests WHERE kind = 'brokerHeader'")],
  ['child identity', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'host', row => { row.payload.id = 'different'; })],
  ['owner identity', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'host', row => { row.owner = 'different'; })],
  ['unlisted child', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'brokerHeader', row => { row.payload.hosts = []; })],
  ['duplicate child', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'brokerHeader', row => { row.payload.hosts.push(row.payload.hosts[0]); })],
  ['future parent', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'associationHeader', row => { row.payload.version = 99; })],
  ['presence contradiction', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'brokerHeader', row => { row.payload.pairings = null; })],
  ['authority', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'freeze', row => { row.payload.receipt.authority.ownerSubject = 'different'; })],
  ['receipt hash', (f: ReturnType<typeof fixture>) => rewrite(f.db, 'favoritesReceipt', row => { row.payload.receiptHash = '0'.repeat(64); })],
])('rejects %s before publishing a reconstructed snapshot', async (_name, corrupt) => {
  const f = fixture(); await f.store.commit(codecState(auth)); corrupt(f);
  const before = f.snapshot(); expect(() => reopen(f.storage)).toThrow(); expect(f.snapshot()).toBe(before);
}, 10000);

test('rejects duplicate manifests/chunks, orphan chunks and invalid strict UTF8 without SQL scan assumptions', async () => {
  const f = fixture(); await f.store.commit(codecState(auth)); const { manifests, chunks } = physical(f.db);
  expect(() => decodeSqlSnapshot([...manifests, manifests[0]!], chunks, auth)).toThrow(/duplicate/);
  expect(() => decodeSqlSnapshot(manifests, [...chunks, chunks[0]!], auth)).toThrow(/duplicate/);
  expect(() => decodeSqlSnapshot(manifests, [...chunks, { ...chunks[0]!, identity: '0'.repeat(64) }], auth)).toThrow(/orphan/);
  const bytes = new Uint8Array([255]); const manifest = { ...manifests[0]!, byte_length: 1, chunk_count: 1, digest: createHash('sha256').update(bytes).digest('hex') };
  expect(() => decodeSqlSnapshot([manifest], [{ ...chunks[0]!, bytes }], auth)).toThrow(/UTF-8/);
}, 10000);

test('whole-snapshot preflight rejects duplicate logical tuples or invalid complete evidence without writing', async () => {
  const f = fixture(); const state = codecState(auth); await f.store.commit(state); const before = f.snapshot();
  state.securityEvents!.push(state.securityEvents![0]!);
  await expect(f.store.commit(state)).rejects.toThrow(/duplicate/); expect(f.snapshot()).toBe(before);
  state.securityEvents!.pop(); state.tenants[0]!.favoritesSuccession!.receipts[0]!.receiptHash = '0'.repeat(64);
  await expect(f.store.commit(state)).rejects.toThrow(/Invalid/); expect(f.snapshot()).toBe(before);
}, 10000);

test('retains large actual freeze relations and repeated relation receipt bytes; rejects a missing lineage link', async () => {
  const f = fixture(); const state = codecState(auth); const associations = state.tenants[0]!.broker.associations!;
  const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
  const relations = Array.from({ length: 700 }, (_, index) => ({ relationId: 'large-' + index, kind: 'side' as const,
    readerRef: ref('x'.repeat(400) + index), sourceRef: ref('A'), linked: true, revision: 0 }));
  associations.freezes[0]!.receipt.relations.push(...relations);
  const change = associations.relationChanges[1]!; change.reservation.relations.push(...relations);
  change.hostReceipt!.reservation = structuredClone(change.reservation);
  // Full freeze relations participate in Favorites identity, so update the owning hash in this fixture.
  const { successionFreezeKey } = await import('../../agent-remote-protocol/src/index.js');
  const freeze = associations.freezes[0]!;
  state.tenants[0]!.favoritesSuccession!.receipts[0]!.receiptHash = createHash('sha256').update(JSON.stringify([successionFreezeKey(freeze.receipt), freeze.projection])).digest('hex');
  const encoded = encodeSqlSnapshot(state, auth);
  expect(encoded.costs.some(row => row.kind === 'freeze' && row.chunkCount > 1)).toBe(true);
  expect(encoded.costs.some(row => row.kind === 'relationChange' && row.chunkCount > 2)).toBe(true);
  await f.store.commit(state); const restored = reopen(f.storage).initial;
  expect(JSON.stringify(restored.tenants[0]!.broker.associations!.relationChanges)).toBe(JSON.stringify(associations.relationChanges));
  const before = f.snapshot(); associations.freezes.splice(0, 1); state.tenants[0]!.favoritesSuccession!.receipts.splice(0, 1);
  await expect(f.store.commit(state)).rejects.toThrow(/Invalid/); expect(f.snapshot()).toBe(before);
}, 15000);

test.each([
  ['DELETE', 'relay_snapshot_chunks', ''], ['INSERT', 'relay_snapshot_chunks', " WHEN NEW.kind = 'favoritesReceipt'"],
  ['INSERT', 'relay_snapshot_manifests', " WHEN NEW.kind = 'relayHeader'"],
  ['UPDATE', 'relay_snapshot_manifests', " WHEN NEW.kind = 'favoritesReceipt'"],
  ['INSERT', 'relay_snapshot_manifests', " WHEN NEW.kind = 'deviceKey'"],
])('rolls back every table after %s on %s%s', async (operation, table, condition) => {
  const f = fixture(); const state = codecState(auth); await f.store.commit(state); const before = f.snapshot();
  f.db.exec(`CREATE TRIGGER fail_snapshot BEFORE ${operation} ON ${table}${condition} BEGIN SELECT RAISE(ABORT, 'late codec failure'); END`);
  const next: any = structuredClone(state); next.extraRelay.changed = true;
  next.tenants[0].broker.associations.freezes[0].extraEvidence = 'new';
  next.tenants[0].favoritesSuccession.receipts[1].status = 'applied';
  next.sessionStars[0].title = 'new'; next.favoritesTrees[0].folders[0].title = 'new';
  next.tenants[0].broker.keys[0][1].expires++;
  await expect(f.store.commit(next)).rejects.toThrow(/late codec failure/); expect(f.snapshot()).toBe(before);
  f.db.exec('DROP TRIGGER fail_snapshot'); expect(reopen(f.storage).initial).toEqual(state);
}, 10000);

test('awaits sync before Relay current/replies and cache, rejects unknown durability without asserting rollback', async () => {
  const f = fixture(); await f.store.commit(codecState(auth));
  let release!: () => void; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.storage.sync = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  let publications = 0, failures = 0, replied = false;
  const relay = createRelayState(auth, { initial: reopen(f.storage).initial, commit: state => f.store.commit(state) }, () => { failures++; }, () => { publications++; });
  const before = structuredClone(relay.read());
  const pending = relay.mutate(state => { state.sessionStars![0]!.title = 'durable'; return 'reply'; }).then(() => { replied = true; });
  await started; expect(relay.read()).toEqual(before); expect(publications).toBe(0); expect(replied).toBe(false);
  expect(reopen(f.storage).initial.sessionStars![0]!.title).toBe('durable');
  release(); await pending; expect(publications).toBe(1); expect(replied).toBe(true);
  f.storage.sync = async () => { throw new Error('sync rejected'); };
  await expect(relay.mutate(state => { state.sessionStars![0]!.title = 'unknown'; })).rejects.toThrow(/sync rejected/);
  expect(failures).toBe(1); expect(relay.read().sessionStars![0]!.title).toBe('durable');
  expect(() => relay.assertAvailable()).toThrow(/unavailable/);
  expect(reopen(f.storage).initial.sessionStars![0]!.title).toBe('unknown');
  await expect(f.store.commit(before)).rejects.toThrow(/durability is unknown/);
}, 10000);

test('Broker pairing draft, Relay current and successful reply wait together for SQL sync', async () => {
  const f = fixture(); const state = emptyRelayState(auth);
  state.tenants = [{ subject: 'owner', namespace: createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex'), broker: { keys: [], hosts: [], bindings: [], creations: [], pairings: [] } }];
  await f.store.commit(state);
  const relay = createRelayState(auth, { initial: state, commit: value => f.store.commit(value) }, () => {}, () => {});
  const broker = createHostBroker({ origin: auth.origin, ownerSubject: 'owner', durable: true, initialState: state.tenants[0]!.broker,
    onStateChange: value => relay.mutate(draft => { draft.tenants[0]!.broker = value; }) });
  let release!: () => void; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let replied = false;
  f.storage.sync = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  try {
    const pending = broker.handleRequest(new Request(auth.origin + '/v1/remote/pairings', { method: 'POST', body: '{}' }), { principalSubject: () => 'owner' }).then(response => { replied = true; return response; });
    await Promise.race([started, pending.then(async response => { throw new Error('Pairing replied before sync: ' + await response?.text()); })]);
    expect(broker.snapshot().pairings).toEqual([]); expect(relay.read().tenants[0]!.broker.pairings).toEqual([]); expect(replied).toBe(false);
    release(); expect((await pending)!.status).toBe(201);
    expect(broker.snapshot().pairings).toHaveLength(1); expect(relay.read().tenants[0]!.broker.pairings).toHaveLength(1);
    expect(new SqliteRelayStore(f.storage, auth).initial.tenants[0]!.broker.pairings).toHaveLength(1);
  } finally { release?.(); broker.close(); await relay.close(); }
}, 10000);

test('preserves empty optional collections and complete ordinary metadata through reopen', async () => {
  const f = fixture(); const state = emptyRelayState(auth);
  state.securityEvents = []; state.sessionStars = []; state.sessionTitles = [];
  state.sessionTitleRevision = 0;
  (state as any).extension = { retained: 'complete' };
  await f.store.commit(state);
  expect(new SqliteRelayStore(f.storage, auth).initial).toEqual(state);
}, 10000);

test('configured accounting fences SQL writes at eleven, holds publication on sync and restores unknown complete evidence', async () => {
  const f = fixture(); const initial = codecState(auth);
  const unresolved: any = initial.tenants[0]!.broker.associations!.freezes.find(row => row.released === undefined)!;
  unresolved.receipt = { ...unresolved.receipt, version: 2, maxProjectionBytes: 65536 };
  await f.store.commit(initial);
  const encoding = { measureSnapshot(value: Readonly<HostedRelayState>) { return { snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(value as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord };
  let publications = 0, failures = 0, replies = 0;
  const relay = createRelayState(auth, { initial, commit: value => f.store.commit(value) }, () => { failures++; }, () => { publications++; }, encoding);
  expect(reopen(f.storage).initial.version).toBe(9);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.storage.sync = () => { enter(); return new Promise<void>(resolve => { release = resolve; }); };
  const before = structuredClone(relay.read());
  const pending = relay.mutate(draft => { draft.securityEvents!.push({ id: 'accounting', subject: 'owner', action: 'fixture', outcome: 'allowed', at: 1 }); }).then(() => { replies++; });
  await entered;
  expect(relay.read()).toEqual(before); expect(publications).toBe(0); expect(replies).toBe(0);
  expect(reopen(f.storage).initial.version).toBe(11);
  release(); await pending;
  expect(relay.read().version).toBe(11); expect(publications).toBe(1); expect(replies).toBe(1);
  expect(new SqliteRelayStore(f.storage, auth).initial).toEqual(relay.read());
  f.storage.sync = async () => { throw new Error('unknown accounting sync'); };
  await expect(relay.mutate(draft => { (draft.tenants[0]!.broker.associations as any).unknownEvidence = 'complete'; })).rejects.toThrow(/unknown accounting sync/);
  expect(failures).toBe(1); expect(publications).toBe(1);
  expect(relay.read().tenants[0]!.broker.associations).not.toHaveProperty('unknownEvidence');
  const restored = reopen(f.storage).initial;
  expect(restored.version).toBe(11); expect(restored.tenants[0]!.broker.associations).toHaveProperty('unknownEvidence', 'complete');
  expect(() => createRelayState(auth, { initial: restored, async commit() {} }, () => {}, () => {})).toThrow(/cost/i);
  expect(() => createRelayState(auth, { initial: restored, async commit() {} }, () => {}, () => {}, encoding)).not.toThrow();
}, 10000);

test('configured accounting rolls back a late SQL fault before format and runtime publication', async () => {
  const f = fixture(); const initial = emptyRelayState(auth); initial.version = 9;
  await f.store.commit(initial); const before = f.snapshot();
  const encoding = { measureSnapshot(value: Readonly<HostedRelayState>) { return { snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(value as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord };
  let failures = 0, publications = 0;
  const relay = createRelayState(auth, { initial, commit: value => f.store.commit(value) }, () => { failures++; }, () => { publications++; }, encoding);
  f.db.exec("CREATE TRIGGER fail_accounting BEFORE UPDATE ON relay_snapshot_manifests WHEN NEW.kind = 'relayHeader' BEGIN SELECT RAISE(ABORT, 'accounting rollback'); END");
  await expect(relay.mutate(() => {})).rejects.toThrow(/accounting rollback/);
  expect(f.snapshot()).toBe(before); expect(relay.read().version).toBe(9); expect(publications).toBe(0); expect(failures).toBe(1);
  f.db.exec('DROP TRIGGER fail_accounting');
  expect(reopen(f.storage).initial.version).toBe(9);
}, 10000);

for (const failure of ['hold', 'rollback', 'unknown-sync'] as const) test(`atomic source completion preserves the Broker and SQL boundary on ${failure}`, async () => {
  const { sourceCompletionState, sourceCompletionBroker } = await import('./source-completion-fixture.js');
  const f = fixture(); const initial = sourceCompletionState(auth); await f.store.commit(initial);
  const encoding = { measureSnapshot(value: Readonly<HostedRelayState>) { return { snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(value as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord };
  const relay = createRelayState(auth, { initial, commit: value => f.store.commit(value) }, () => {}, () => {}, encoding);
  let entered!: () => void, release!: () => void; const held = new Promise<void>(resolve => { entered = resolve; });
  let unresolved: HostedRelayState | undefined, physicalBefore: string | undefined;
  const peer = await sourceCompletionBroker(relay, auth, () => {
    unresolved = structuredClone(relay.read()); physicalBefore = f.snapshot();
    if (failure === 'rollback') f.db.exec("CREATE TRIGGER fail_source BEFORE DELETE ON relay_snapshot_manifests WHEN OLD.kind = 'admission' BEGIN SELECT RAISE(ABORT, 'source rollback'); END");
    else f.storage.sync = async () => { entered(); if (failure === 'unknown-sync') throw new Error('unknown source sync'); await new Promise<void>(resolve => { release = resolve; }); };
  });
  try {
    let replied = false; const pending = peer.create().then(response => { replied = true; return response; });
    if (failure === 'hold') {
      await held; expect(replied).toBe(false); expect(peer.broker.snapshot()).toEqual(unresolved!.tenants[0]!.broker); expect(relay.read()).toEqual(unresolved);
      const local = reopen(f.storage).initial.tenants[0]!.broker;
      expect(local.bindings).toHaveLength(2); expect(local.creations).toHaveLength(1); expect(local.sharing!.reservations[0]!.agentId).toBe('reader-agent'); expect(local.associations!.admissions).toHaveLength(0);
      release(); expect((await pending)?.status).toBe(200);
    } else {
      expect((await pending)?.status).toBe(503); expect(peer.broker.snapshot()).toEqual(unresolved!.tenants[0]!.broker); expect(relay.read()).toEqual(unresolved);
      const local = reopen(f.storage).initial.tenants[0]!.broker;
      if (failure === 'rollback') { expect(f.snapshot()).toBe(physicalBefore); expect(local).toEqual(unresolved!.tenants[0]!.broker); f.db.exec('DROP TRIGGER fail_source'); }
      else { expect(local.bindings).toHaveLength(2); expect(local.creations).toHaveLength(1); expect(local.associations!.admissions).toHaveLength(0); expect(local.sharing!.reservations[0]!.agentId).toBe('reader-agent'); }
    }
    expect(peer.counts().creates).toBe(1);
    peer.broker.close(); await relay.close(); f.storage.sync = async () => {};
    const restored = reopen(f.storage), restarted = createRelayState(auth, restored, () => {}, () => {}, encoding);
    const recovered = await sourceCompletionBroker(restarted, auth);
    try { expect((await recovered.create())?.status).toBe(200); expect(recovered.counts().creates).toBe(0); expect(recovered.counts().readbacks).toBe(failure === 'rollback' ? 1 : 0); }
    finally { recovered.broker.close(); await restarted.close(); }
  } finally { release?.(); peer.broker.close(); await relay.close(); }
}, 10000);

for (const failure of ['hold', 'rollback', 'unknown-sync'] as const) test(`exact relation completion keeps its last durable phase on ${failure}`, async () => {
  const { relationCompletionState, sourceCompletionBroker } = await import('./source-completion-fixture.js');
  const f = fixture(), initial = relationCompletionState(auth); await f.store.commit(initial);
  const encoding = { measureSnapshot(value: Readonly<HostedRelayState>) { return { snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(value as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord };
  const relay = createRelayState(auth, { initial, commit: value => f.store.commit(value) }, () => {}, () => {}, encoding);
  let enter!: () => void, release!: () => void; const held = new Promise<void>(resolve => { enter = resolve; });
  let before: HostedRelayState | undefined, physicalBefore: string | undefined;
  const peer = await sourceCompletionBroker(relay, auth, () => {
    before = structuredClone(relay.read()); physicalBefore = f.snapshot();
    if (failure === 'rollback') f.db.exec("CREATE TRIGGER fail_relation BEFORE UPDATE ON relay_snapshot_manifests WHEN NEW.kind = 'relationChange' BEGIN SELECT RAISE(ABORT, 'relation rollback'); END");
    else f.storage.sync = async () => { enter(); if (failure === 'unknown-sync') throw new Error('unknown relation sync'); await new Promise<void>(resolve => { release = resolve; }); };
  });
  try {
    let replied = false; const pending = peer.reconcile().then(() => { replied = true; return undefined; }, error => error);
    if (failure === 'hold') {
      await held; expect(replied).toBe(false); expect(peer.broker.snapshot()).toEqual(before!.tenants[0]!.broker); expect(relay.read()).toEqual(before);
      expect(reopen(f.storage).initial.tenants[0]!.broker.associations!.relationChanges[0]!.phase).toBe('committed'); release(); expect(await pending).toBeUndefined();
    } else {
      expect(await pending).toBeInstanceOf(Error); expect(replied).toBe(false); expect(peer.broker.snapshot()).toEqual(before!.tenants[0]!.broker); expect(relay.read()).toEqual(before);
      if (failure === 'rollback') { expect(f.snapshot()).toBe(physicalBefore); f.db.exec('DROP TRIGGER fail_relation'); }
    }
    const restored = reopen(f.storage).initial;
    expect(restored.tenants[0]!.broker.associations!.relationChanges[0]!.phase).toBe(failure === 'rollback' ? 'overlay_applied' : 'committed');
    peer.broker.close(); await relay.close(); f.storage.sync = async () => {};
    const restarted = createRelayState(auth, reopen(f.storage), () => {}, () => {}, encoding), recovered = await sourceCompletionBroker(restarted, auth);
    try { expect((await recovered.reconcile()).operation.phase).toBe('committed'); expect(recovered.broker.snapshot().associations!.revision).toBe(11); }
    finally { recovered.broker.close(); await restarted.close(); }
  } finally { release?.(); peer.broker.close(); await relay.close(); }
}, 10000);

for (const consumer of ['terminal', 'favorites', 'invitation', 'registration', 'rotation', 'acknowledgment', 'revoke'] as const) {
  for (const failure of ['hold', 'rollback', 'unknown-sync'] as const) test(`retention ${consumer} fences Node SQL publication through ${failure}`, async () => {
    const { retentionState, retentionPeer } = await import('./retention-consumption-fixture.js');
    const initial = retentionState(auth, true);
    if (consumer === 'invitation' || consumer === 'registration') {
      const broker = initial.tenants[0]!.broker; broker.hosts = []; broker.keys = [];
      broker.revokedHosts![0]!.revocationId = '00000000-0000-4000-8000-000000000002';
    }
    const f = fixture(); await f.store.commit(initial);
    const encoding = { measureSnapshot: (state: Readonly<HostedRelayState>) => ({ snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }), quoteRecord: quoteSqlRecord };
    let publications = 0;
    const relay = createRelayState(auth, { initial, commit: value => f.store.commit(value) }, () => {}, () => { publications++; }, encoding);
    const peer = retentionPeer(relay, auth);
    let invitationKey = '';
    if (consumer === 'registration') invitationKey = (await (await peer.invitation())!.json()).key;
    else if (consumer !== 'invitation') await peer.connect();
    if (consumer === 'favorites' || consumer === 'revoke') expect((await peer.terminal())?.status).toBe(200);
    if (consumer === 'acknowledgment') expect((await peer.rotate())?.status).toBe(200);
    const before = structuredClone(relay.read()), brokerBefore = peer.broker.snapshot(), counts = peer.counts(), published = publications, physical = f.snapshot();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    if (failure === 'rollback') for (const operation of ['INSERT', 'UPDATE', 'DELETE']) f.db.exec(`CREATE TRIGGER fail_retention_${operation} BEFORE ${operation} ON relay_snapshot_manifests BEGIN SELECT RAISE(ABORT, 'retention rollback'); END`);
    else f.storage.sync = async () => {
      f.storage.sync = async () => {}; enter();
      if (failure === 'unknown-sync') throw new Error('unknown retention sync');
      await new Promise<void>(resolve => { release = resolve; });
    };
    const action = () => consumer === 'terminal' ? peer.terminal() : consumer === 'favorites' ? peer.apply() : consumer === 'invitation' ? peer.invitation()
      : consumer === 'registration' ? peer.connect(invitationKey) : consumer === 'rotation' ? peer.rotate() : consumer === 'acknowledgment' ? peer.acknowledge() : peer.revoke();
    let replied = false;
    const pending = action().then(value => { replied = true; return value; }, error => error);
    try {
      if (failure === 'hold') {
        await entered; expect(replied).toBe(false); expect(relay.read()).toEqual(before); expect(peer.broker.snapshot()).toEqual(brokerBefore);
        expect(peer.counts()).toMatchObject({ releases: counts.releases, issued: counts.issued, registered: counts.registered }); expect(publications).toBe(published);
        const held = reopen(f.storage).initial;
        if (consumer === 'terminal') expect(held.tenants[0]).toMatchObject({ favoritesSuccession: { receipts: [{ status: 'pending' }] }, broker: { associations: { freezes: [{ released: 'committed', projection: { version: 1 } }] } } });
        release(); await pending;
      } else {
        await pending;
        expect(relay.read()).toEqual(before); expect(peer.broker.snapshot()).toEqual(brokerBefore); expect(publications).toBe(published);
        expect(peer.counts()).toMatchObject({ releases: counts.releases, issued: counts.issued, registered: counts.registered });
        if (failure === 'rollback') {
          expect(f.snapshot()).toBe(physical);
          for (const operation of ['INSERT', 'UPDATE', 'DELETE']) f.db.exec(`DROP TRIGGER fail_retention_${operation}`);
        }
      }
      const restored = reopen(f.storage).initial;
      if (failure === 'rollback') expect(restored).toEqual(before);
      else if (consumer === 'terminal' || consumer === 'favorites') {
        expect(restored.tenants[0]!.broker.associations!.freezes[0]!.projection).toBeDefined();
        expect(restored.tenants[0]!.favoritesSuccession!.receipts[0]!.status).toBe(consumer === 'terminal' ? 'pending' : 'applied');
        expect(restored.sessionStars![0]!.nativeSessionId).toBe(consumer === 'terminal' ? 'A' : 'B');
      } else if (consumer === 'invitation') expect(restored.tenants[0]!.broker.pairings).toHaveLength(2);
      else if (consumer === 'registration') expect(restored.tenants[0]!.broker.hosts[0]).toMatchObject({ id: 'mapped-host', credentialRotation: true });
      else if (consumer === 'rotation') expect(restored.tenants[0]!.broker.keys).toHaveLength(2);
      else if (consumer === 'acknowledgment') expect(restored.tenants[0]!.broker.keys).toHaveLength(1);
      else {
        expect(restored.tenants[0]!.broker.hosts).toEqual([]); expect(restored.tenants[0]!.broker.keys).toEqual([]);
        expect(restored.tenants[0]!.broker.associations).toEqual(before.tenants[0]!.broker.associations);
        expect(restored.tenants[0]!.favoritesSuccession).toEqual(before.tenants[0]!.favoritesSuccession);
        expect(restored.tenants[0]!.broker.sharing).toEqual(before.tenants[0]!.broker.sharing);
      }
      peer.close(); await relay.close(); f.storage.sync = async () => {};
      const reopened = createRelayState(auth, reopen(f.storage), () => {}, () => {}, encoding), recovered = retentionPeer(reopened, auth);
      try {
        if (consumer === 'terminal' || consumer === 'favorites') {
          await recovered.connect(); expect((await recovered.terminal())?.status).toBe(200);
          await recovered.apply(); const applied = structuredClone(reopened.read()); await recovered.apply();
          expect(reopened.read()).toEqual(applied); expect(applied.tenants[0]!.favoritesSuccession!.receipts[0]!.status).toBe('applied');
        } else if (consumer === 'rotation' && failure !== 'rollback') {
          const overlap = structuredClone(reopened.read().tenants[0]!.broker.keys); await recovered.connect();
          expect(reopened.read().tenants[0]!.broker.keys).toEqual(overlap);
          expect((await recovered.rotate())?.status).toBe(409); expect(recovered.counts().issued).toBe(0);
        }
      } finally { recovered.close(); await reopened.close(); }
    } finally { release?.(); peer.close(); await relay.close(); }
  }, 15000);
}

test('full recovery registration construction fits the saved claim and ends only future Host growth', async () => {
  const { retentionState, retentionPeer } = await import('./retention-consumption-fixture.js');
  const { deriveSuccessionCapacity } = await import('../../agent-remote-hosted/src/succession-capacity.js');
  const initial = retentionState(auth, true), broker = initial.tenants[0]!.broker;
  broker.hosts = []; broker.keys = []; broker.revokedHosts![0]!.revocationId = '00000000-0000-4000-8000-000000000002';
  const f = fixture(); await f.store.commit(initial);
  const encoding = { measureSnapshot: (state: Readonly<HostedRelayState>) => ({ snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }), quoteRecord: quoteSqlRecord };
  const relay = createRelayState(auth, { initial, commit: value => f.store.commit(value) }, () => {}, () => {}, encoding), peer = retentionPeer(relay, auth);
  try {
    const invitation = await (await peer.invitation())!.json(), before = structuredClone(relay.read()), capacity = deriveSuccessionCapacity(before, encoding);
    expect(capacity.tenants[0]).toMatchObject({ hostSlots: 1, credentialSlots: 1 });
    const label = '\ud800'.repeat(160), tool = { id: label, name: label, status: 'not-found' };
    const metadata = { name: '\ud800'.repeat(512), environment: { detectedAt: 1.7976931348623157e308,
      os: { platform: label, name: label, arch: label, release: label }, wsl: false, container: false,
      shell: { name: label, source: 'environment' }, shells: Array(16).fill(tool), browsers: Array(16).fill(tool), vscode: { status: 'not-found' } },
      controller: { version: '999999999.999999999.999999999', revision: 'f'.repeat(40), platform: '\ud800'.repeat(32), arch: '\ud800'.repeat(32), nodeMajor: 100, remoteUpdate: false },
      providerManagement: true, tpmManagement: true, providers: Array.from({ length: 64 }, (_, index) => ({ providerId: '\ud800'.repeat(510) + String(index).padStart(2, '0'), displayName: '\ud800'.repeat(512), promptEditing: true, sessionRename: true, daemonControl: true })) };
    await peer.connect(invitation.key, metadata);
    const saved = reopen(f.storage).initial;
    expect(saved.tenants[0]!.broker.hosts[0]).toMatchObject(metadata);
    expect(deriveSuccessionCapacity(saved, encoding).tenants[0]).toMatchObject({ hostSlots: 0, credentialSlots: 0 });
    const total = (state: HostedRelayState) => encodeSqlSnapshot(state, auth).costs.reduce((sum, row) => sum + row.byteLength + row.manifestBytes, 0);
    expect(total(saved) - total(before)).toBeLessThanOrEqual(capacity.remainingBytes);
    expect(peer.counts().issued).toBe(1); await peer.acknowledge(); expect(peer.counts().registered).toBe(1);
    expect(reopen(f.storage).initial.tenants[0]!.broker.hosts[0]).toMatchObject(metadata);
  } finally { peer.close(); await relay.close(); }
}, 15000);
