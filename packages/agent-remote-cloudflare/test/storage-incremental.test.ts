import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { createRelayState, hostedRecordEncodingCosts, type HostedRelayState, type RelayStateCommitMetrics } from '@orchardworks/agent-remote-hosted';
import { deriveSuccessionCapacity } from '@orchardworks/agent-remote-hosted/succession-capacity';
import { SqliteRelayStore } from '../src/storage.js';
import { encodeSqlSnapshot } from '../src/storage-codec.js';
import { accountingAuth as auth } from './accounting-worker-fixture.js';
import { codecState } from './storage-codec-fixture.js';
import { operatingEncoding, prepareOperatingDatasets } from './storage-operating-fixture.js';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function sqlite() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage = { sql: { exec(query: string, ...bindings: any[]) { const statement = db.prepare(query);
    bindings = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows }; } },
    transactionSync<T>(change: () => T) { db.exec('BEGIN'); try { const result = change(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    async sync() {} } as unknown as DurableObjectStorage;
  const manifests = () => db.prepare('SELECT kind, identity, byte_length, chunk_count, digest FROM relay_snapshot_manifests ORDER BY kind, identity').all();
  return { storage, manifests };
}
/** The manifests a complete encoding of state has, as stored rows. */
const complete = (state: HostedRelayState) => [...encodeSqlSnapshot(state, auth).records.values()].map(({ manifest }) => ({ kind: manifest.kind, identity: manifest.identity,
  byte_length: manifest.byte_length, chunk_count: manifest.chunk_count, digest: manifest.digest })).sort((a, b) => a.kind.localeCompare(b.kind) || a.identity.localeCompare(b.identity));
/** A Relay over a stored dataset whose caches check every encoding against a complete one. */
async function relay(initial: HostedRelayState, accounting = true) {
  const { storage, manifests } = sqlite();
  await new SqliteRelayStore(storage, auth).commit(initial);
  const mismatches: unknown[] = [], metrics: RelayStateCommitMetrics[] = [];
  const verify = (cache: string) => ({ verifyEvery: 1, onMismatch: (kinds: string[]) => mismatches.push({ cache, kinds }) });
  const costs = hostedRecordEncodingCosts(auth, verify('capacity'));
  const state = createRelayState(auth, new SqliteRelayStore(storage, auth, { cache: verify('store') }), () => { throw new Error('Relay state failed.'); }, () => {},
    accounting ? costs : undefined, value => metrics.push(value));
  return { state, storage, manifests, mismatches, metrics, costs };
}
function savedTeam(id: string, textBytes: number) {
  const member = (memberId: string, role: 'leader' | 'member') => ({ id: memberId, hostId: 'host', providerId: 'codex', nativeSessionId: `${id}-${memberId}`,
    role, name: memberId, responsibility: '', creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1 });
  return { id, operationId: id, revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: `${id}-source`, title: 'Source' }, title: 'Team',
    status: 'active' as const, createdAt: 1, updatedAt: 1, members: [member('leader', 'leader'), member('helper', 'member')],
    messages: Array.from({ length: 4 }, (_, index) => ({ id: `${id}-m${index}`, from: 'leader', to: 'helper', text: 'x'.repeat(Math.floor(textBytes / 4)), status: 'queued' as const, createdAt: 1 })) };
}
const changes: Array<[string, (draft: HostedRelayState) => void]> = [
  ['nothing', () => {}],
  ['one Host', draft => { draft.tenants[0]!.broker.hosts[0]!.name = 'Renamed Host'; }],
  ['one session', draft => { if (draft.sessions[0]) draft.sessions[0].lastSeenAt = 1_000_000; }],
  ['a consumed proof', draft => { draft.consumedProofs.push(['incremental-proof-0001', 2_000_000]); }],
  ['Teams added', draft => { draft.tenants[0]!.broker.teams = [savedTeam('team-a', 4096), savedTeam('team-b', 4096), savedTeam('team-c', 4096)]; }],
  ['one Team', draft => { draft.tenants[0]!.broker.teams![1]!.messages[0]!.text += 'changed'; }],
  ['a Team removed', draft => { draft.tenants[0]!.broker.teams!.splice(0, 1); }],
  ['a security event', draft => { (draft.securityEvents ??= []).push({ id: 'incremental-event', subject: 'owner', at: 3_000_000, action: 'session_revoked', outcome: 'allowed' }); }],
  ['the last tenant', draft => { const host = draft.tenants.at(-1)!.broker.hosts[0]; if (host) host.name = 'Last tenant Host'; }],
  ['a session removed', draft => { draft.sessions.splice(0, 1); }],
  ['a Host removed and its bindings', draft => {
    const broker = draft.tenants[0]!.broker, host = broker.hosts.at(-1)!;
    if (broker.associations?.freezes.some(row => row.hostId === host.id)) return;
    broker.hosts.splice(broker.hosts.indexOf(host), 1);
    broker.bindings = broker.bindings.filter(binding => binding.hostId !== host.id);
    broker.creations = broker.creations.filter(([, value]) => broker.bindings.some(binding => binding.agentId === value.agentId));
  }],
];

// The codec inventory holds every record kind, including legacy succession that accounting does not admit.
test.each(['codec', 'M', 'L'] as const)('every commit of %s stores exactly its complete encoding, and the caches agree with complete accounting', async id => {
  const accounting = id !== 'codec';
  const initial = id === 'codec' ? codecState(auth) : prepareOperatingDatasets().datasets[id];
  const { state, storage, manifests, mismatches, metrics, costs } = await relay(initial, accounting);
  // The first commit after a start writes what the start changed, such as authority leases that must be confirmed again.
  await state.mutate(() => {}); metrics.splice(0);
  for (const [, change] of changes) {
    await state.mutate(change);
    const current = state.read();
    expect(manifests()).toEqual(complete(current));
    if (accounting) expect(deriveSuccessionCapacity(current, costs)).toEqual(deriveSuccessionCapacity(current, operatingEncoding));
  }
  expect(mismatches).toEqual([]);
  expect(new SqliteRelayStore(storage, auth).initial).toEqual(JSON.parse(JSON.stringify(state.read())));
  // A change encodes and writes what it changed and the headers that list it, not the rest of the Relay.
  const stats = Object.fromEntries(changes.map(([name], index) => [name, { encoded: metrics[index]!.store!.encoded, written: metrics[index]!.store!.written }]));
  expect(stats['nothing']).toEqual({ encoded: 0, written: 0 });
  expect(stats['one Host']).toEqual({ encoded: 1, written: 1 });
  expect(stats['one session']).toEqual(initial.sessions.length ? { encoded: 1, written: 1 } : { encoded: 0, written: 0 });
  expect(stats['one Team']).toEqual({ encoded: 1, written: 1 });
  for (const { encoded, written } of Object.values(stats)) { expect(encoded).toBeLessThanOrEqual(5); expect(written).toBe(encoded); }
}, 120_000);

test('a commit costs what it changes, not the size of the Relay', async () => {
  const { datasets } = prepareOperatingDatasets();
  const timing: Record<string, number> = {};
  for (const id of ['M', 'L', 'O'] as const) {
    const { storage } = sqlite();
    await new SqliteRelayStore(storage, auth).commit(datasets[id]);
    const metrics: RelayStateCommitMetrics[] = [];
    const state = createRelayState(auth, new SqliteRelayStore(storage, auth), () => {}, () => {}, hostedRecordEncodingCosts(auth), value => metrics.push(value));
    for (let index = 0; index < 40; index++) await state.mutate(draft => { draft.tenants[0]!.broker.hosts[0]!.name = `Host ${index}`; });
    const settled = metrics.slice(10).map(value => value.durationMs).sort((a, b) => a - b);
    timing[id] = settled[Math.floor(settled.length / 2)]!;
    expect(metrics.at(-1)!.store).toMatchObject({ encoded: 1, written: 1 });
  }
  // A complete encoding of L or O took about 60 ms and a commit three of them; the bound leaves room for slow machines.
  expect(timing).toEqual({ M: expect.any(Number), L: expect.any(Number), O: expect.any(Number) });
  for (const value of Object.values(timing)) expect(value).toBeLessThan(20);
}, 120_000);
