import { expect, test } from 'vitest';
import { buildCompleteRelayState } from '@orchardworks/agent-relay-core/testing';
import { createHash } from 'node:crypto';
import { createWindowView, successionFreezeKey } from '@orchardworks/agent-remote-protocol';
import { SqliteRelayStore } from '../src/storage.js';
import { createHostedRelay, encodeValidatedHostedSnapshot } from '@orchardworks/agent-relay-core';
import { SQL_SNAPSHOT_FORMAT } from '../src/storage-codec.js';
import { sqliteStorage } from './sqlite-storage.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'workers-fixture-secret-01234567890123456789' };

/** What the previous Worker kept: ordinary Teams with file transfers, a Call For Support group and its state, a TPM in a handoff receipt, and bots as Window details. */
function previousWorkerState() {
  const state: any = structuredClone(buildCompleteRelayState(auth));
  const broker = state.tenants[0].broker;
  const member = (id: string, role: string) => ({ id, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: `native-${id}`, role, name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 });
  const source = (id: string) => ({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: `${id}-source`, title: 'Source' });
  const bytes = { resourceId: 'r1', name: 'a.txt', mediaType: 'text/plain', byteLength: 1, sha256: 'a'.repeat(64) };
  broker.teams = [
    { id: 'ordinary', operationId: 'ordinary', revision: 2, title: 'Ordinary', status: 'active', createdAt: 1, updatedAt: 1, source: source('ordinary'),
      members: [member('leader', 'leader'), member('helper', 'member')], messages: [{ id: 'm1', from: 'leader', to: 'helper', text: 'Go', status: 'queued', createdAt: 1, resources: [bytes] }], resourceUploads: [{ ownerMemberId: 'helper', resource: bytes }] },
    { id: 'support', operationId: 'support', revision: 2, title: 'Support', status: 'active', createdAt: 1, updatedAt: 1, source: source('support'),
      members: [member('leader', 'leader'), member('requester', 'requester')], messages: [], callForSupport: { profileId: 'profile', role: 'Reviewer' } },
  ];
  broker.callForSupport = { profiles: [], enablement: [] };
  broker.associations.freezes[1].projection.receipt.prepared.participants = [{ relationId: 'work-1', kind: 'tpm', before: { controllerId: 'installation', providerId: 'fixture', nativeSessionId: 'B' }, after: { controllerId: 'installation', providerId: 'fixture', nativeSessionId: 'C' } }];
  // The progress of Favorites succession names each handoff by a hash of its projection.
  const handoff = broker.associations.freezes[1];
  const progress = state.tenants[0].favoritesSuccession.receipts.find((entry: any) => entry.token === handoff.receipt.token);
  progress.receiptHash = createHash('sha256').update(JSON.stringify([successionFreezeKey(handoff.receipt), handoff.projection])).digest('hex');
  state.workspaceWindows = [{ subject: 'owner', id: 'group', generation: 0, receipts: [], bots: { rank: 'm', members: { v1: { name: 'Chief', label: 'Lead', pinned: true } } },
    window: { schemaVersion: 3, id: 'group', title: 'Group', revision: 1, selectedViewId: 'v1', selectedPrimaryViewId: 'v1',
      views: [createWindowView('v1', { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 's1', title: 's1' }, 'primary'),
        { ...createWindowView('v2', { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'native-helper', title: 'helper' }, 'dock'), bindingPolicy: 'managed', feature: { kind: 'team', id: 'ordinary' } }] } }];
  delete state.bots;
  return state;
}

/** Writes the state as the previous Worker stored it: the earlier record kinds and encodings, and the tables it kept. */
function storePreviousWorkerState() {
  const { db, storage } = sqliteStorage();
  new SqliteRelayStore(storage, auth);
  const snapshot = encodeValidatedHostedSnapshot(previousWorkerState(), SQL_SNAPSHOT_FORMAT);
  for (const { manifest, chunks } of snapshot.records.values()) {
    db.prepare('INSERT INTO relay_snapshot_manifests (kind, identity, format, byte_length, chunk_count, digest) VALUES (?, ?, ?, ?, ?, ?)').run(manifest.kind, manifest.identity, manifest.format, manifest.byte_length, manifest.chunk_count, manifest.digest);
    for (const chunk of chunks) db.prepare('INSERT INTO relay_snapshot_chunks (kind, identity, ordinal, bytes) VALUES (?, ?, ?, ?)').run(chunk.kind, chunk.identity, chunk.ordinal, chunk.bytes);
  }
  db.exec('UPDATE relay_metadata SET version = ' + SQL_SNAPSHOT_FORMAT);
  db.exec('CREATE TABLE relay_team_resource_chunks (team TEXT, ordinal INTEGER, bytes BLOB)');
  db.exec("INSERT INTO relay_team_resource_chunks VALUES ('ordinary', 0, x'00')");
  return { db, storage, kinds: new Set([...snapshot.records.values()].map(record => record.manifest.kind)) };
}

test('loads the state the previous Worker stored: the removed features are dropped, the rest kept, and it commits again', async () => {
  const { db, storage, kinds } = storePreviousWorkerState();
  expect(kinds.has('team')).toBe(true);
  const store = new SqliteRelayStore(storage, auth);
  const tenant = store.initial.tenants[0]!;
  expect(tenant.broker.teams ?? []).toEqual([]);
  expect(Object.hasOwn(tenant.broker, 'callForSupport')).toBe(false);
  expect(JSON.stringify(tenant.broker.associations)).not.toContain('"tpm"');
  expect(tenant.broker.hosts.length).toBeGreaterThan(0);
  expect(store.initial.bots).toEqual([expect.objectContaining({ subject: 'owner', name: 'Chief', label: 'Lead' })]);
  expect(store.initial.workspaceWindows![0]!.window!.views[1]).not.toHaveProperty('feature');
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'relay_team_resource_chunks'").all()).toEqual([]);

  // The next commit stores the loaded state, and a restart reads it back unchanged.
  await store.commit(store.initial);
  const restarted = new SqliteRelayStore(storage, auth);
  expect(restarted.initial).toEqual(store.initial);
  expect(db.prepare("SELECT count(*) AS n FROM relay_snapshot_manifests WHERE kind = 'team'").get()).toEqual({ n: 0 });

  // A Relay serving over the store takes its first request and commits; the stored state is then the loaded state, with no old row left.
  const relay = createHostedRelay({ ...auth, storage: restarted, successionEnrollment: true, scheduler: { schedule: async () => {}, cancel: async () => {} } });
  try { expect((await relay.fetch(new Request(auth.origin + '/auth/login')))?.status).toBe(303); } finally { await relay.close(); }
  const served = new SqliteRelayStore(storage, auth);
  expect(JSON.stringify(served.initial.tenants[0]!.broker.associations)).not.toContain('"tpm"');
  expect(db.prepare("SELECT count(*) AS n FROM relay_snapshot_manifests WHERE kind = 'team'").get()).toEqual({ n: 0 });
});
