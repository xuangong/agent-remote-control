import { expect, test } from 'vitest';
import { buildCompleteRelayState } from '@orchardworks/agent-relay-core/testing';
import { isTeam } from '@orchardworks/agent-remote-protocol';
import { SqliteRelayStore } from '../src/storage.js';
import { createHostedRelay, encodeValidatedHostedSnapshot } from '@orchardworks/agent-relay-core';
import { SQL_SNAPSHOT_FORMAT } from '../src/storage-codec.js';
import { sqliteStorage } from './sqlite-storage.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'workers-fixture-secret-01234567890123456789' };
const chief = 'b_' + '1'.repeat(32), temporary = 'b_' + '9'.repeat(32);

/**
 * What the Worker before timer ends and forked sub-sessions stored: a bot's inbox with a timer that has no end, and a sub-session whose
 * task has no `forkedFrom`.
 */
function previousState() {
  const state: any = structuredClone(buildCompleteRelayState(auth));
  const broker = state.tenants[0].broker;
  const member = (id: string, role: string, native: string) => ({ id, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: native, role, name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 });
  const source = { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'chief-session', title: 'Chief' };
  broker.teams = [
    { id: 'inbox', operationId: 'inbox', revision: 1, title: 'Chief inbox', status: 'active', createdAt: 1, updatedAt: 1, source, messages: [], members: [member('seat', 'requester', 'chief-session')],
      inbox: { botId: chief, timers: [{ name: 'Check in', intervalMs: 600_000, dueAt: 5 }] } },
    { id: 'sub', operationId: 'sub', revision: 1, title: 'sub', status: 'active', createdAt: 1, updatedAt: 1, source, messages: [],
      members: [member('sub-w', 'leader', 'sub-session'), member('sub-o', 'requester', 'chief-session')], task: { title: 'sub', brief: 'Do it.', state: 'working', createdAt: 1, updatedAt: 1 } },
  ];
  state.bots = [{ subject: 'owner', botId: chief, chief: { kind: 'person' }, createdAt: 1, updatedAt: 1 }];
  return state;
}

function storePreviousState() {
  const { db, storage } = sqliteStorage();
  new SqliteRelayStore(storage, auth);
  const snapshot = encodeValidatedHostedSnapshot(previousState(), SQL_SNAPSHOT_FORMAT);
  for (const { manifest, chunks } of snapshot.records.values()) {
    db.prepare('INSERT INTO relay_snapshot_manifests (kind, identity, format, byte_length, chunk_count, digest) VALUES (?, ?, ?, ?, ?, ?)').run(manifest.kind, manifest.identity, manifest.format, manifest.byte_length, manifest.chunk_count, manifest.digest);
    for (const chunk of chunks) db.prepare('INSERT INTO relay_snapshot_chunks (kind, identity, ordinal, bytes) VALUES (?, ?, ?, ?)').run(chunk.kind, chunk.identity, chunk.ordinal, chunk.bytes);
  }
  db.exec('UPDATE relay_metadata SET version = ' + SQL_SNAPSHOT_FORMAT);
  return { db, storage };
}

test('loads the state the Worker stored before routines: the retired quiet timer is dropped without breaking the inbox, the sub-session has no fork, and it commits again', async () => {
  const { storage } = storePreviousState();
  const store = new SqliteRelayStore(storage, auth);
  const teams = store.initial.tenants[0]!.broker.teams ?? [];
  expect(teams.map(team => team.id)).toEqual(['inbox', 'sub']);
  // The earlier timer is still valid state to read; the Relay drops it when it builds its broker state.
  expect(teams[0]!.inbox!.timers).toEqual([{ name: 'Check in', intervalMs: 600_000, dueAt: 5 }]);
  expect(teams[1]!.task).not.toHaveProperty('forkedFrom');
  expect(teams.every(team => isTeam(team))).toBe(true);
  await store.commit(store.initial);
  expect(new SqliteRelayStore(storage, auth).initial).toEqual(store.initial);
});
