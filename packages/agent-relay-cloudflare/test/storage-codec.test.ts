import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { buildCompleteRelayState as codecState } from '@orchardworks/agent-relay-core/testing';
import { SqliteRelayStore } from '../src/storage.js';
import { SQL_CHUNK_BYTES, SQL_SNAPSHOT_FORMAT } from '../src/storage-codec.js';
import { sqliteStorage } from './sqlite-storage.js';

const origin = 'https://relay.example', issuer = 'https://gateway.example', secret = 'workers-fixture-secret-01234567890123456789';
const auth = { origin, issuer, secret };

/** The SQL snapshot codec over one storage, with the inspection the Worker fixture offered: `inspect('codec/seed' | 'codec/snapshot' | 'codec/physical' | 'fail-commit' | 'restore-commit')`. A restart opens the store again over the same rows. */
function fixture(_options?: unknown) {
  const { db, storage } = sqliteStorage();
  const rows = (sql: string) => db.prepare(sql).all() as any[];
  const reply = (status: number, value: unknown = 'ok') => ({ status, json: async () => value });
  async function inspect(path: string, init?: { method: string; body: string }) {
    if (path === 'codec/seed') {
      try { await new SqliteRelayStore(storage, auth).commit(JSON.parse(init!.body)); return reply(200); } catch (error) { return reply(500, String(error)); }
    }
    if (path === 'codec/snapshot') return reply(200, new SqliteRelayStore(storage, auth).initial);
    if (path === 'codec/physical') return reply(200, {
      metadata: rows('SELECT * FROM relay_metadata'),
      manifests: rows('SELECT * FROM relay_snapshot_manifests ORDER BY kind, identity'),
      chunks: rows('SELECT kind, identity, ordinal, typeof(bytes) AS type, length(bytes) AS size FROM relay_snapshot_chunks ORDER BY kind, identity, ordinal'),
      chunkDigests: rows('SELECT kind, identity, ordinal, bytes FROM relay_snapshot_chunks ORDER BY kind, identity, ordinal')
        .map(row => ({ kind: row.kind, identity: row.identity, ordinal: row.ordinal, digest: createHash('sha256').update(new Uint8Array(row.bytes)).digest('hex') })),
      blob: rows('SELECT bytes FROM relay_snapshot_chunks LIMIT 1').map(row => ({ arrayBuffer: row.bytes instanceof Uint8Array, size: row.bytes.byteLength, prefix: Array.from(new Uint8Array(row.bytes).slice(0, 16)) })),
    });
    if (path.startsWith('fail-commit')) {
      const kind = new URLSearchParams(path.split('?')[1]).get('kind');
      const condition = kind === 'favorites' ? " WHEN NEW.kind = 'favoritesTree'" : kind === 'host' ? " WHEN NEW.kind = 'host'" : kind === 'progress' ? " WHEN NEW.kind = 'favoritesReceipt'" : '';
      db.exec("CREATE TRIGGER fail_records BEFORE INSERT ON relay_snapshot_manifests" + condition + " BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
      return reply(200);
    }
    if (path === 'restore-commit') { db.exec('DROP TRIGGER IF EXISTS fail_records'); return reply(200); }
    return reply(404);
  }
  return { inspect, async restart() {} };
}

test('real Worker SQLite stores bounded BLOB records and ordered headers, survives a late abort and persisted restart', async () => {
  const f = fixture(); const state = codecState({ origin, issuer, secret });
  const broker = state.tenants[0]!.broker;
  (broker.associations!.freezes[0] as any).extraEvidence = '😀\ud800'.repeat(80000);
  broker.bindings = Array.from({ length: 80 }, (_, index) => ({ agentId: 'a'.repeat(4090) + index, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'native-' + index }));
  broker.creations = [];
  const member = (team: string, id: string, role: 'requester') => ({ id, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: `${team}-${id}`,
    role, name: id, responsibility: '', creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1 });
  broker.teams = ['first', 'second'].map(id => ({ id, operationId: id, revision: 1, title: id, status: 'active' as const, createdAt: 1, updatedAt: 1,
    source: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: `${id}-source`, title: 'Source' }, link: { assistants: ['leader', 'helper'] as [string, string], recent: [] }, members: [member(id, 'leader', 'requester'), member(id, 'helper', 'requester')],
    messages: [{ id: `${id}-message`, from: 'leader', to: 'helper', text: 'Review the change.', status: 'queued' as const, createdAt: 1 }] }));
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  const physical = await (await f.inspect('codec/physical')).json() as any;
  expect(physical.metadata[0].version).toBe(SQL_SNAPSHOT_FORMAT);
  // Each Team is its own record.
  expect(physical.manifests.filter((row: any) => row.kind === 'team')).toHaveLength(2);
  expect(physical.manifests.find((row: any) => row.kind === 'freeze' && row.chunk_count > 1)).toBeTruthy();
  expect(physical.manifests.find((row: any) => row.kind === 'brokerHeader' && row.chunk_count > 1)).toBeTruthy();
  expect(physical.chunks.every((row: any) => row.type === 'blob' && row.size <= SQL_CHUNK_BYTES)).toBe(true);
  expect(physical.chunkDigests).toHaveLength(physical.chunks.length);
  expect(physical.chunkDigests.every((row: any) => /^[a-f0-9]{64}$/.test(row.digest))).toBe(true);
  expect(physical.blob[0]).toMatchObject({ arrayBuffer: true });
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
  await f.inspect('fail-commit?kind=progress'); const next = structuredClone(state);
  (next.tenants[0]!.broker.associations!.freezes[0] as any).extraEvidence += 'changed';
  next.sessionStars![0]!.title = 'must roll back'; next.favoritesTrees![0]!.folders[0]!.title = 'must roll back';
  next.tenants[0]!.favoritesSuccession!.receipts[1]!.status = 'applied';
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(next) })).status).toBe(500);
  expect(await (await f.inspect('codec/physical')).json()).toEqual(physical);
  await f.inspect('restore-commit'); await f.restart();
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
});

test('keeps the smart reading switch of a Host and the pending journal deletions through the SQL snapshot and a persisted restart', async () => {
  const f = fixture(); const state = codecState({ origin, issuer, secret });
  const broker = state.tenants[0]!.broker;
  broker.hosts[0]!.smartReading = ['claude', 'codex'];
  broker.journalDeletions = ['revoked-host'];
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
  await f.restart();
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
});

test('Window documents, hashed management grants, operation receipts and deletion survive Worker SQLite restart atomically', async () => {
  const f = fixture(); const state = codecState({ origin, issuer, secret });
  const now = Date.now();
  state.workspaceWindows = [{ subject: 'owner', id: 'window', generation: 1,
    window: { schemaVersion: 3, id: 'window', title: 'Shared', revision: 1, selectedPrimaryViewId: 'primary', selectedViewId: 'primary',
      views: [{ id: 'primary', placement: 'primary', width: 480, collapsed: false, display: { mode: 'content', lettersVisible: true } }] },
    manager: { generation: 1, hash: createHash('sha256').update('private-window-grant').digest('hex'), session: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'Manager' } },
    receipts: [{ fingerprint: 'a'.repeat(64), result: { operationId: 'rename', status: 'committed', revision: 1, committedAt: now, expiresAt: now + 86400000 } }] }];
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  const physical = await (await f.inspect('codec/physical')).json() as any;
  expect(physical.manifests.some((row: any) => row.kind === 'workspaceWindow')).toBe(true);
  await f.restart();
  expect((await (await f.inspect('codec/snapshot')).json() as any).workspaceWindows).toEqual(state.workspaceWindows);
  const deleted = structuredClone(state); const row = deleted.workspaceWindows![0]!;
  delete row.window; row.deleted = true; row.receipts.push({ fingerprint: 'b'.repeat(64), result: { operationId: 'delete', status: 'committed', revision: 2, committedAt: now, expiresAt: now + 86400000 } });
  await f.inspect('fail-commit');
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(deleted) })).status).toBe(500);
  await f.inspect('restore-commit'); await f.restart();
  expect((await (await f.inspect('codec/snapshot')).json() as any).workspaceWindows).toEqual(state.workspaceWindows);
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(deleted) })).status).toBe(200);
  await f.restart();
  expect((await (await f.inspect('codec/snapshot')).json() as any).workspaceWindows).toEqual(deleted.workspaceWindows);
});
