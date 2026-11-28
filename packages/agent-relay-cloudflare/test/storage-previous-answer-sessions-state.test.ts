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
 * What the Worker with answer sessions stored: a bot's inbox (without mentions), an answer session of that bot for the conversation
 * the person asked it from (a Team of one leader seat that records the ask and its answer, with an hour's timer behind it), and a
 * retired one.
 */
function previousState() {
  const state: any = structuredClone(buildCompleteRelayState(auth));
  const broker = state.tenants[0].broker;
  const member = (id: string, role: string, native: string, extra: Record<string, unknown> = {}) => ({ id, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: native, role, name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, ...extra });
  const source = { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'chief-session', title: 'Chief' };
  const answerSession = (id: string, status: string) => ({ id, operationId: id, revision: 3, title: 'Chief answers Notes', status, createdAt: 1, updatedAt: 5, source,
    members: [member(`${id}-seat`, 'leader', `${id}-session`, { access: 'read_only' })],
    messages: [{ id: `${id}-m`, from: `${id}-seat`, to: `${id}-seat`, text: '[The person asks from Notes]\nWhat shipped?\nGuidance.', status: 'accepted', acceptance: 'started', createdAt: 2 }],
    ask: { botId: chief, from: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'notes-session', name: 'Notes' }, lastAt: 5, entries: [{ id: 'e1', text: 'What shipped?', at: 2, answer: { text: 'The 1.4 release.', at: 4 } }] } });
  broker.teams = [
    { id: 'inbox', operationId: 'inbox', revision: 1, title: 'Chief inbox', status: 'active', createdAt: 1, updatedAt: 1, source, messages: [], members: [member('seat', 'requester', 'chief-session')],
      inbox: { botId: chief } },
    answerSession('answering', 'active'),
    answerSession('retired', 'archived'),
    { id: 'logged', operationId: 'logged', revision: 1, title: 'Tracker inbox', status: 'active', createdAt: 1, updatedAt: 1, source, messages: [], members: [member('seat2', 'requester', 'tracker-session')],
      inbox: { botId: 'b_' + '2'.repeat(32), worklog: [{ seq: 1, at: 1, where: 'Notes', question: 'Ready?', answer: 'Yes.' }], logSeen: 0 } },
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

test('loads the state of the Worker with answer sessions (and one with a work log): nothing is dropped, and it commits again', async () => {
  const { storage } = storePreviousState();
  const store = new SqliteRelayStore(storage, auth);
  const tenant = store.initial.tenants[0]!;
  // The state before work logs: answer sessions and an inbox without a log load as they were.
  expect((tenant.broker.teams ?? []).map(team => team.id)).toEqual(['inbox', 'answering', 'retired', 'logged']);
  expect(tenant.broker.teams![0]!.inbox).toEqual({ botId: chief });
  expect(tenant.broker.teams![1]!.ask!.entries[0]!.answer!.text).toBe('The 1.4 release.');
  // An inbox without a work log loads as it is, and one with a log keeps it.
  expect(tenant.broker.teams![3]!.inbox!.worklog).toEqual([{ seq: 1, at: 1, where: 'Notes', question: 'Ready?', answer: 'Yes.' }]);
  expect(store.initial.bots).toEqual([expect.objectContaining({ botId: chief })]);

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
