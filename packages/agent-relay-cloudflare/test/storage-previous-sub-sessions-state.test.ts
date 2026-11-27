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
 * What the Worker before sub-sessions stored: a bot's inbox with a board whose item is assigned to a temporary bot, two tasks (a working
 * `/side` and a finished one, in the old shape), and bot records that name a lifetime, one of them a temporary bot's.
 */
function previousState() {
  const state: any = structuredClone(buildCompleteRelayState(auth));
  const broker = state.tenants[0].broker;
  const member = (id: string, role: string, native: string) => ({ id, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: native, role, name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 });
  const source = { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'chief-session', title: 'Chief' };
  const task = (id: string, extra: Record<string, unknown>) => ({ id, operationId: id, revision: 1, title: id, status: 'active', createdAt: 1, updatedAt: 1, source, messages: [],
    members: [member(`${id}-w`, 'leader', `${id}-session`), member(`${id}-o`, 'requester', 'chief-session')],
    task: { title: id, brief: 'Do it.', state: 'working', createdAt: 1, updatedAt: 1, ...extra } });
  broker.teams = [
    { id: 'inbox', operationId: 'inbox', revision: 1, title: 'Chief inbox', status: 'active', createdAt: 1, updatedAt: 1, source, messages: [], members: [member('seat', 'requester', 'chief-session')],
      inbox: { botId: chief, board: { next: 2, items: [{ key: 1, title: 'Run it', status: 'working', assignee: temporary, links: [], version: 2, changedAt: {}, updatedBy: chief, updatedAt: 1 }] } } },
    task('side', { side: true, doneWhen: 'Answered.' }),
    task('finished', { state: 'done', result: { status: 'done', summary: 'Ok.', reportedAt: 2 }, botId: temporary }),
  ];
  state.bots = [{ subject: 'owner', botId: chief, chief: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 1 },
    { subject: 'owner', botId: temporary, name: 'Run it', chief: { kind: 'bot', botId: chief }, lifetime: 'temporary', createdAt: 1, updatedAt: 1 }];
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

test('loads the state the Worker before sub-sessions stored: the old tasks and the temporary bot are dropped, the bot, its inbox and board kept, and it commits again', async () => {
  const { storage } = storePreviousState();
  const store = new SqliteRelayStore(storage, auth);
  const tenant = store.initial.tenants[0]!;
  // Tasks are sub-sessions now, and an old one is dropped; the bot's inbox stays with its board, whose item names a bot that is gone.
  expect((tenant.broker.teams ?? []).map(team => team.id)).toEqual(['inbox']);
  expect(tenant.broker.teams![0]!.inbox!.board!.items[0]).toMatchObject({ key: 1, assignee: temporary });
  expect(store.initial.bots).toEqual([expect.objectContaining({ botId: chief })]);
  expect(store.initial.bots![0]).not.toHaveProperty('lifetime');

  // The next commit stores the loaded state, and a restart reads it back unchanged.
  await store.commit(store.initial);
  const restarted = new SqliteRelayStore(storage, auth);
  expect(restarted.initial).toEqual(store.initial);

  // A Relay serving over the store takes its first request and commits.
  const relay = createHostedRelay({ ...auth, storage: restarted, successionEnrollment: true, scheduler: { schedule: async () => {}, cancel: async () => {} } });
  try { expect((await relay.fetch(new Request(auth.origin + '/auth/login')))?.status).toBe(303); } finally { await relay.close(); }
  const served = new SqliteRelayStore(storage, auth);
  expect((served.initial.tenants[0]!.broker.teams ?? []).every(team => isTeam(team))).toBe(true);
});
