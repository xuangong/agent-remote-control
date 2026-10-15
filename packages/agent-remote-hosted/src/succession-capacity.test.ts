import { codecState } from '../../agent-remote-cloudflare/test/storage-codec-fixture.js';
import { projectSuccessionFavorites } from './favorites-succession.js';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
import { deriveSuccessionCapacity, isSuccessionCapacityError, type SuccessionEncodingCosts } from './succession-capacity.js';
import { validBrokerAssociations, migrateBrokerAssociations } from './succession-associations.js';
import { encodeSqlSnapshot, quoteSqlRecord, SQL_SNAPSHOT_FORMAT, SQL_RECORD_FORMAT, SQL_CHUNK_BYTES } from '../../agent-remote-cloudflare/src/storage-codec.js';

const auth = { origin: 'https://relay.example', issuer: 'https://issuer.example', secret: 's'.repeat(32) };
const costs: SuccessionEncodingCosts = {
  measureSnapshot(state) { return { snapshotFormat: SQL_SNAPSHOT_FORMAT, recordFormat: SQL_RECORD_FORMAT, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }; },
  quoteRecord: quoteSqlRecord,
};
function initial(ceiling = 65536, subject = 'owner'): HostedRelayState {
  const state = emptyRelayState(auth); state.version = 9;
  const namespace = createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex');
  const source = { controllerId: 'controller', providerId: 'fixture', nativeSessionId: 'source' };
  state.tenants.push({ subject, namespace, broker: { keys: [], hosts: [{ id: 'host', installationId: 'controller', name: 'Host', providers: [{ providerId: 'fixture', displayName: 'Fixture' }], legacyDsh: false }], bindings: [], creations: [], associations: {
    version: 5, revision: 1, admissions: [], relationChanges: [], relationResets: [], freezes: [{ hostId: 'host', receipt: { version: 2, token: 'token', maxProjectionBytes: ceiling, authority: { version: 1, origin: auth.origin, issuer: auth.issuer, namespace, ownerSubject: subject }, controllerId: source.controllerId, request: { operationId: 'operation', roleId: 'role', expectedRevision: 1, from: source }, associationRevision: 0, lineage: [source], relations: [] } }],
  } } });
  return state;
}

test('preflights without storage writes, fences every configured write at eleven and refuses missing costs', async () => {
  const writes: HostedRelayState[] = [];
  const state = createRelayState(auth, { initial: initial(), async commit(value) { writes.push(structuredClone(value)); } }, () => {}, () => {}, costs);
  expect(writes).toEqual([]); expect(state.read().version).toBe(9);
  await state.mutate(draft => { draft.securityEvents = []; });
  expect(writes[0]!.version).toBe(11);
  await state.mutate(draft => { draft.version = 2; delete draft.successionAccounting; });
  expect(writes[1]!.version).toBe(11);
  expect(() => createRelayState(auth, { initial: writes[1], async commit() {} }, () => {}, () => {})).toThrow(/cost|accounting/i);
  expect(() => createRelayState(auth, { initial: writes[1], async commit() {} }, () => {}, () => {}, { measureSnapshot: costs.measureSnapshot } as any)).toThrow(/cost|accounting/i);
  const ordinary = createRelayState(auth, { async commit(value) { writes.push(value); } }, () => {}, () => {}, costs);
  await ordinary.mutate(() => {}); expect(writes.at(-1)!.version).toBe(11);
}, 10000);

test('accounts across tenants while preserving large unrelated complete ordinary data', () => {
  const state = initial(); const before = JSON.stringify(state);
  const one = deriveSuccessionCapacity(state, costs);
  expect(one.featureCharge).toBeGreaterThan(65536); expect(one.tenants[0]).toMatchObject({ remainingAssociationRevisions: 1, progressSlots: 1, bindingSlots: 0, creationSlots: 0 });
  state.tenants.push(...initial(65536, 'other').tenants);
  const two = deriveSuccessionCapacity(state, costs);
  expect(two.featureCharge).toBeGreaterThan(one.featureCharge * 1.9);
  (state as any).ordinaryExtra = '\ud800'.repeat(1024 * 1024);
  const padded = deriveSuccessionCapacity(state, costs);
  expect(padded.featureCharge).toBe(two.featureCharge);
  expect(JSON.stringify(initial())).toBe(before);
}, 10000);

test('rejects a policy deficit before storage without poisoning the Relay queue', async () => {
  let writes = 0, failures = 0;
  const state = createRelayState(auth, { initial: initial(), async commit() { writes++; } }, () => { failures++; }, () => {}, costs);
  const before = JSON.stringify(state.read());
  let refusal: unknown;
  try { await state.mutate(draft => { (draft.tenants[0]!.broker.associations as any).extra = 'x'.repeat(8388608); }); } catch (error) { refusal = error; }
  expect(isSuccessionCapacityError(refusal)).toBe(true);
  expect(writes).toBe(0); expect(failures).toBe(0); expect(JSON.stringify(state.read())).toBe(before);
  await state.mutate(() => {}); expect(writes).toBe(1);
}, 10000);

test('derives fixed source completion claims at restart and refuses revision and slot deficits', () => {
  const state = initial(); const associations = state.tenants[0]!.broker.associations!;
  associations.freezes = [];
  associations.admissions.push({ id: 'not-a-uuid', fingerprint: 'complete-admission-fingerprint', source: { controllerId: 'controller', providerId: 'fixture', nativeSessionId: '\ud800' } });
  const derived = deriveSuccessionCapacity(state, costs);
  expect(derived.featureCharge).toBeGreaterThan(500000);
  expect(deriveSuccessionCapacity(structuredClone(state), costs)).toEqual(derived);
  expect(derived.tenants[0]).toMatchObject({ bindingSlots: 1, creationSlots: 1, remainingAssociationRevisions: 1 });
  associations.revision = Number.MAX_SAFE_INTEGER;
  expect(() => createRelayState(auth, { initial: state, async commit() {} }, () => {}, () => {}, costs)).toThrow(/revision/i);
}, 10000);

test('defers unresolved saved one without changing its identity or storage', () => {
  const state = initial(); const receipt: any = state.tenants[0]!.broker.associations!.freezes[0]!.receipt;
  receipt.version = 1; delete receipt.maxProjectionBytes;
  const before = JSON.stringify(state); let writes = 0;
  expect(() => createRelayState(auth, { initial: state, async commit() { writes++; } }, () => {}, () => {}, costs)).toThrow(/bound|legacy/i);
  expect(writes).toBe(0); expect(JSON.stringify(state)).toBe(before);
  expect(createRelayState(auth, { initial: state, async commit() {} }, () => {}, () => {}).read()).toEqual(state);
}, 10000);

test('reserves only durable cancellation for an explicit v1 cancellation fence', async () => {
  const state = initial(), row = state.tenants[0]!.broker.associations!.freezes[0]!;
  const { maxProjectionBytes: _allowance, ...receipt } = row.receipt as Extract<typeof row.receipt, { version: 2 }>;
  row.receipt = { ...receipt, version: 1 }; Object.assign(row, { cancelOnly: true });
  const associations = state.tenants[0]!.broker.associations!;
  expect(validBrokerAssociations(migrateBrokerAssociations(associations))).toBe(true);
  expect(validBrokerAssociations({ ...associations, freezes: [{ ...row, cancelOnly: false }] })).toBe(false);
  expect(validBrokerAssociations({ ...associations, freezes: [{ ...row, released: 'committed' }] })).toBe(false);
  expect(validBrokerAssociations({ ...associations, freezes: [{ ...row, receipt: { ...row.receipt, version: 2, maxProjectionBytes: 65536 } }] })).toBe(false);
  const before = deriveSuccessionCapacity(state, costs);
  expect(before.tenants[0]).toMatchObject({ remainingAssociationRevisions: 1, progressSlots: 0 });
  const saved: HostedRelayState[] = [];
  const relay = createRelayState(auth, { initial: state, async commit(value) { saved.push(structuredClone(value)); } }, () => {}, () => {}, costs);
  await relay.mutate(draft => { draft.tenants[0]!.broker.associations!.freezes[0]!.released = 'cancelled'; draft.tenants[0]!.broker.associations!.revision++; });
  const settled = deriveSuccessionCapacity(saved[0]!, costs);
  expect(settled.retainedBytes).toBeLessThanOrEqual(before.featureCharge);
  expect(settled.tenants[0]).toMatchObject({ remainingAssociationRevisions: 0, progressSlots: 0 });
  expect(createRelayState(auth, { initial: saved[0], async commit() {} }, () => {}, () => {}, costs).read()).toEqual(saved[0]);
}, 10000);

function fullInventory() {
  const state = codecState(auth);
  const unresolved: any = state.tenants[0]!.broker.associations!.freezes.find(row => row.released === undefined)!;
  unresolved.receipt.version = 2; unresolved.receipt.maxProjectionBytes = 65536;
  return state;
}
const total = (state: HostedRelayState) => encodeSqlSnapshot(state, auth).costs.reduce((value, cost) => value + cost.byteLength + cost.manifestBytes, 0);

test('checks complete snapshot reserves before ordinary writes without poisoning the queue', async () => {
  const saved = initial(); let writes = 0, failures = 0;
  const envelope = (value: HostedRelayState) => Buffer.byteLength(JSON.stringify({ payload: JSON.stringify(value), signature: '0'.repeat(64) }));
  const limit = envelope(saved) + deriveSuccessionCapacity(saved, costs).remainingSnapshotBytes + 100;
  const encoding = { ...costs, acceptsSnapshot: (value: HostedRelayState, reserve: number) => envelope(value) + reserve <= limit };
  const relay = createRelayState(auth, { initial: saved, async commit() { writes++; } }, () => { failures++; }, () => {}, encoding);
  let refusal: unknown;
  try { await relay.mutate(draft => { draft.tenants[0]!.broker.hosts[0]!.name = '"'.repeat(100); }); } catch (error) { refusal = error; }
  expect(isSuccessionCapacityError(refusal)).toBe(true);
  expect(writes).toBe(0); expect(failures).toBe(0);
  expect(relay.read().tenants[0]!.broker.hosts[0]!.name).toBe('Host');
  await relay.mutate(() => {}); expect(writes).toBe(1);
  expect(() => createRelayState(auth, { initial: saved, async commit() {} }, () => {}, () => {}, { ...encoding, acceptsSnapshot: () => false })).toThrow(/snapshot.*capacity/i);
});

test('reserves escaped snapshot growth through intermediate relation transitions', () => {
  const state = fullInventory();
  const envelope = (value: HostedRelayState) => Buffer.byteLength(JSON.stringify({ payload: JSON.stringify(value), signature: '0'.repeat(64) }));
  const budget = envelope(state) + deriveSuccessionCapacity(state, costs).remainingSnapshotBytes;
  const row = state.tenants[0]!.broker.associations!.relationChanges.find(value => value.phase === 'reserved')!;
  for (const phase of ['metadata_committed', 'overlay_applied', 'committed'] as const) {
    row.phase = phase;
    row.hostReceipt = { reservation: row.reservation, phase: phase === 'metadata_committed' ? 'reserved' : 'released', associationRevision: row.reservation.associationRevision + (phase === 'metadata_committed' ? 0 : Number(row.reservation.previousMember !== row.reservation.linked)) };
    state.tenants[0]!.broker.associations!.revision++;
    validateRelayState(state, auth);
    expect(envelope(state) + deriveSuccessionCapacity(state, costs).remainingSnapshotBytes).toBeLessThanOrEqual(budget);
  }
});

test('consumes projection reserves even when an equal-length Favorite replacement escapes more bytes', () => {
  const state = initial(), tenant = state.tenants[0]!, row = tenant.broker.associations!.freezes[0]!;
  const from = row.receipt.request.from, to = { ...from, nativeSessionId: 'target' };
  const workspace = { controllerId: 'controller', canonicalCwd: '/workspace' };
  const star = { subject: 'owner', hostId: 'host', providerId: 'fixture', nativeSessionId: 'source', title: 'x'.repeat(512), starredAt: 1, favoriteId: 'favorite', folderId: null, order: 0 };
  state.sessionStars = [star]; state.favoritesTrees = [{ subject: 'owner', revision: 1, folders: [] }];
  state.sessionTitles = [{ hostId: 'host', providerId: 'fixture', nativeSessionId: 'target', title: '"'.repeat(256), revision: 1 }]; state.sessionTitleRevision = 1;
  const serialized = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const envelope = (value: unknown) => serialized(JSON.stringify(value));
  const replacement = { ...star, nativeSessionId: 'target', title: '"'.repeat(256) };
  expect(serialized(replacement)).toBe(serialized(star));
  expect(envelope(replacement)).toBeGreaterThan(envelope(star));
  validateRelayState(state, auth);
  const budget = envelope(state) + deriveSuccessionCapacity(state, costs).remainingSnapshotBytes;
  row.released = 'committed';
  row.projection = { version: 1, role: { id: 'role', revision: 2, origin: from, current: to, workspace }, receipt: {
    ...row.receipt.request, to, phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now',
    prepared: { ...row.receipt.request, to, workspace, associationRevision: 0, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } },
  } };
  tenant.broker.associations!.revision++;
  validateRelayState(state, auth);
  expect(envelope(state) + deriveSuccessionCapacity(state, costs).remainingSnapshotBytes).toBeLessThanOrEqual(budget);
  projectSuccessionFavorites(state, 'owner'); validateRelayState(state, auth);
  expect(state.sessionStars![0]).toMatchObject({ nativeSessionId: 'target', title: '"'.repeat(256) });
  expect(envelope(state) + deriveSuccessionCapacity(state, costs).remainingSnapshotBytes).toBeLessThanOrEqual(budget);
});

test('fits the exact shared aggregate and refuses the next byte with complete retained extras', () => {
  const state = initial(); state.tenants.push(...initial(65536, 'other').tenants);
  const associations: any = state.tenants[0]!.broker.associations!; associations.padding = '';
  let size = deriveSuccessionCapacity(state, costs).featureCharge;
  associations.padding = 'x'.repeat(8388608 - size);
  for (let adjustment = 0; adjustment < 3; adjustment++) {
    size = deriveSuccessionCapacity(state, costs).featureCharge;
    associations.padding = associations.padding.slice(0, associations.padding.length - Math.max(0, size - 8388608));
  }
  expect(deriveSuccessionCapacity(state, costs).featureCharge).toBe(8388608);
  expect(() => createRelayState(auth, { initial: state, async commit() {} }, () => {}, () => {}, costs)).not.toThrow();
  associations.padding += 'x';
  expect(deriveSuccessionCapacity(state, costs).featureCharge).toBe(8388609);
  expect(() => createRelayState(auth, { initial: state, async commit() {} }, () => {}, () => {}, costs)).toThrow(/capacity/i);
}, 10000);

test('retains all inventory kinds and derives remaining relation revisions and recovery claims after reopen', () => {
  const state = fullInventory(), capacity = deriveSuccessionCapacity(state, costs);
  const kinds = new Set(encodeSqlSnapshot(state, auth).costs.map(cost => cost.kind));
  for (const kind of ['admission', 'freeze', 'relationChange', 'relationReset', 'favoritesReceipt', 'revokedHost', 'deviceKey', 'pairing']) expect(kinds.has(kind as any)).toBe(true);
  expect(capacity.tenants[0]).toMatchObject({ remainingAssociationRevisions: 8, bindingSlots: 1, creationSlots: 1, progressSlots: 1, credentialSlots: 1, hostSlots: 1 });
  expect(deriveSuccessionCapacity(structuredClone(state), costs)).toEqual(capacity);
  const before = total(state);
  const changed: any = state.tenants[0]!.broker.associations!.freezes[0]; changed.acceptedExtra = '\ud800'.repeat(20);
  expect(deriveSuccessionCapacity(state, costs).retainedBytes - capacity.retainedBytes).toBe(total(state) - before);
  const associations = state.tenants[0]!.broker.associations!;
  associations.revision = Number.MAX_SAFE_INTEGER - 8;
  expect(deriveSuccessionCapacity(state, costs).violations).toEqual([]);
  associations.revision++;
  expect(deriveSuccessionCapacity(state, costs).violations).toContain('Association revision headroom is exhausted.');
}, 10000);

test('charges only shared quota completions matched by the actual owner creation tuple', () => {
  const state = initial(), broker = state.tenants[0]!.broker, associations = broker.associations!;
  associations.freezes = []; associations.admissions = [{ id: 'imported-unrelated', fingerprint: 'hash', source: { controllerId: 'controller', providerId: 'fixture', nativeSessionId: 'source' } }];
  const before = deriveSuccessionCapacity(state, costs);
  broker.sharing = { grants: [], reservations: Array.from({ length: 20 }, (_, index) => ({ key: 'key-' + index, hostId: 'host', subject: 'viewer', fingerprint: 'ordinary'.repeat(100), nativeRequestId: 'request-' + index })) };
  expect(Math.abs(deriveSuccessionCapacity(state, costs).featureCharge - before.featureCharge)).toBeLessThanOrEqual(2);
  const matching = (request: string) => createHash('sha256').update(JSON.stringify(['host', 'fixture', request])).digest('hex');
  associations.admissions[0]!.id = matching('request-0');
  const one = deriveSuccessionCapacity(state, costs);
  const baseline = structuredClone(state); baseline.tenants[0]!.broker.sharing!.reservations = [];
  expect(one.remainingBytes - deriveSuccessionCapacity(baseline, costs).remainingBytes).toBeGreaterThan(3000);
  associations.admissions.push({ ...associations.admissions[0]!, id: matching('request-1') });
  const quoted: string[] = [];
  const two = deriveSuccessionCapacity(state, { ...costs, quoteRecord(input) { if (input.kind === 'reservation' && input.payloadJsonBytesUpperBound > 0) quoted.push(input.key); return quoteSqlRecord(input); } });
  expect(quoted).toEqual(['key-0', 'key-1']);
  const noQuota = structuredClone(state); noQuota.tenants[0]!.broker.sharing!.reservations = [];
  expect(two.remainingBytes - deriveSuccessionCapacity(noQuota, costs).remainingBytes).toBeGreaterThan(6000);
  broker.sharing.reservations[0]!.agentId = 'completed';
  expect(deriveSuccessionCapacity(state, costs).remainingBytes).toBeLessThan(two.remainingBytes);
  associations.admissions[1]!.source.controllerId = 'other-installation';
  const unrelated = structuredClone(state); unrelated.tenants[0]!.broker.sharing!.reservations = [];
  expect(Math.abs(deriveSuccessionCapacity(state, costs).remainingBytes - deriveSuccessionCapacity(unrelated, costs).remainingBytes)).toBeLessThanOrEqual(2);
}, 10000);

test('covers full accepted source output and rejects durable binding and creation slot deficits', () => {
  const state = initial(), broker = state.tenants[0]!.broker;
  broker.associations!.freezes = [];
  const source = { controllerId: 'controller', providerId: 'fixture', nativeSessionId: 'source' };
  broker.associations!.admissions = [{ id: 'imported', fingerprint: 'hash', source }];
  const capacity = deriveSuccessionCapacity(state, costs), before = total(state);
  const widest = '\ud800'.repeat(512);
  const terminal = structuredClone(state), next = terminal.tenants[0]!.broker;
  next.bindings.push({ hostId: 'host', providerId: 'fixture', agentId: widest, nativeSessionId: widest, creatorSubject: widest,
    sourceRelation: { id: widest, kind: 'side', sourceNativeSessionId: source.nativeSessionId, nativeSourceRef: source, createdAt: '2026-10-10T00:00:00.000Z' } });
  next.creations.push(['\ud800'.repeat(16384), { fingerprint: '\ud800'.repeat(65536), agentId: widest }]);
  next.associations!.admissions = []; next.associations!.revision++;
  expect(total(terminal) - before).toBeLessThanOrEqual(capacity.remainingBytes);
  expect(deriveSuccessionCapacity(terminal, costs).tenants[0]).toMatchObject({ bindingSlots: 0, creationSlots: 0, remainingAssociationRevisions: 0 });
  broker.bindings = Array.from({ length: 4096 }, (_, index) => ({ hostId: 'host', providerId: 'fixture', agentId: 'agent-' + index, nativeSessionId: 'native-' + index }));
  broker.creations = broker.bindings.map(binding => ['create-' + binding.agentId, { fingerprint: 'full', agentId: binding.agentId }]);
  expect(deriveSuccessionCapacity(state, costs).violations).toContain('Source completion slots are exhausted.');
}, 10000);

test('holds recovery claims until complete Host and device evidence and ignores used invitation history alone', () => {
  const state = fullInventory(), broker = state.tenants[0]!.broker;
  const initialCapacity = deriveSuccessionCapacity(state, costs);
  const recovery = broker.keys[0]![1].recovery!;
  broker.keys[0]![1].claimedAt = Number.MAX_SAFE_INTEGER;
  broker.keys.push(['c'.repeat(64), { expires: Number.MAX_SAFE_INTEGER, installationId: recovery.installationId, kind: 'device' }]);
  broker.hosts.push({ id: recovery.hostId, installationId: recovery.installationId, name: 'Recovered Host', providers: [], legacyDsh: false });
  const complete = deriveSuccessionCapacity(state, costs);
  expect(complete.tenants[0]).toMatchObject({ credentialSlots: 0, hostSlots: 0 });
  expect(complete.remainingBytes).toBeLessThan(initialCapacity.remainingBytes);
  broker.keys = broker.keys.filter(([, key]) => !key.recovery);
  broker.pairings = broker.pairings!.filter(pairing => pairing.usedAt !== undefined);
  expect(deriveSuccessionCapacity(state, costs).tenants[0]).toMatchObject({ credentialSlots: 0, hostSlots: 0 });
  const pending = fullInventory(), pendingBroker = pending.tenants[0]!.broker;
  pendingBroker.keys.push(...Array.from({ length: 127 }, (_, index) => [(index + 100).toString(16).padStart(64, '0'), { expires: 1 }] as [string, { expires: number }]));
  expect(deriveSuccessionCapacity(pending, costs).violations).toContain('Recovery credential slots are exhausted.');
}, 10000);

test('precharges all 256 owner stars and absent tree while leaving product blockers pending', () => {
  const state = codecState(auth), tenant = state.tenants[0]!;
  tenant.broker.associations!.admissions = []; tenant.broker.associations!.relationChanges = [];
  tenant.broker.associations!.freezes = tenant.broker.associations!.freezes.slice(0, 1);
  tenant.favoritesSuccession!.receipts = []; state.favoritesTrees = [];
  state.sessionStars = Array.from({ length: 256 }, (_, index) => ({ subject: 'owner', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: index ? 'ordinary-' + index : 'A', title: 'Saved', starredAt: index }));
  const capacity = deriveSuccessionCapacity(state, costs), before = total(state);
  const terminal = structuredClone(state); projectSuccessionFavorites(terminal, 'owner');
  expect(terminal.sessionStars![0]!.nativeSessionId).toBe('B');
  expect(terminal.sessionStars!.every(star => star.favoriteId !== undefined)).toBe(true);
  expect(total(terminal) - before).toBeLessThanOrEqual(capacity.remainingBytes);
  expect(deriveSuccessionCapacity(terminal, costs).remainingBytes).toBeLessThan(capacity.remainingBytes);
  const blocked = structuredClone(state); blocked.favoritesTrees = [{ subject: 'owner', revision: Number.MAX_SAFE_INTEGER, folders: [] }];
  projectSuccessionFavorites(blocked, 'owner');
  expect(blocked.tenants[0]!.favoritesSuccession!.receipts[0]!.status).toBe('pending');
  expect(deriveSuccessionCapacity(blocked, costs).remainingBytes).toBeGreaterThan(0);
}, 10000);

test('bounds the final Favorite target across a pending A to B to C provider chain', () => {
  const state = codecState(auth), tenant = state.tenants[0]!;
  tenant.broker.associations!.admissions = []; tenant.broker.associations!.relationChanges = [];
  tenant.broker.associations!.freezes = tenant.broker.associations!.freezes.slice(0, 2);
  tenant.favoritesSuccession!.receipts = [];
  const row: any = tenant.broker.associations!.freezes[1]!, provider = '\ud800'.repeat(512), target = { controllerId: 'installation', providerId: provider, nativeSessionId: '\ud800'.repeat(512) };
  row.receipt.request.targetProviderId = provider;
  row.projection.role.current = target; row.projection.receipt.to = target; row.projection.receipt.targetProviderId = provider;
  row.projection.receipt.prepared.to = target; row.projection.receipt.prepared.targetProviderId = provider;
  tenant.broker.hosts[0]!.providers.push({ providerId: provider, displayName: 'Final provider' });
  state.sessionStars = [{ subject: 'owner', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: '\ud800'.repeat(512), workspace: '\ud800'.repeat(4096), starredAt: 1 }];
  state.favoritesTrees = [];
  const quotes: ReturnType<typeof quoteSqlRecord>[] = [];
  const capacity = deriveSuccessionCapacity(state, { ...costs, quoteRecord(input) {
    const quote = quoteSqlRecord(input); if (input.kind === 'sessionStar' && input.payloadJsonBytesUpperBound > 0) quotes.push(quote); return quote;
  } });
  const terminal = structuredClone(state); projectSuccessionFavorites(terminal, 'owner');
  expect(terminal.sessionStars![0]).toMatchObject({ providerId: target.providerId, nativeSessionId: target.nativeSessionId });
  expect(terminal.tenants[0]!.favoritesSuccession!.receipts.map(row => row.status)).toEqual(['applied', 'applied']);
  const actual = encodeSqlSnapshot(terminal, auth).costs.find(row => row.kind === 'sessionStar')!;
  expect(quotes).toHaveLength(1);
  expect(actual.byteLength + actual.manifestBytes).toBeLessThanOrEqual(quotes[0]!.byteLength + quotes[0]!.manifestBytes);
  expect(total(terminal) - total(state)).toBeLessThanOrEqual(capacity.remainingBytes);
}, 10000);

test('keeps only incremental shared-header length and chunk-count widths across ordinary growth boundaries', () => {
  const state = initial(), owner = state.tenants[0]!.namespace;
  const ordinary = structuredClone(state); delete ordinary.tenants[0]!.broker.associations;
  (ordinary.tenants[0]!.broker as any).ordinaryHeader = '';
  const baseline = encodeSqlSnapshot(ordinary, auth).costs.find(row => row.kind === 'brokerHeader' && row.owner === owner)!.byteLength;
  const charges: number[] = [];
  for (const target of [999, 1000, 9999, 10000, 262144, 262145, 2359296, 2359297]) {
    (ordinary.tenants[0]!.broker as any).ordinaryHeader = 'x'.repeat(target - baseline);
    const cost = encodeSqlSnapshot(ordinary, auth).costs.find(row => row.kind === 'brokerHeader' && row.owner === owner)!;
    expect(cost.byteLength).toBe(target); expect(cost.chunkCount).toBe(Math.ceil(target / 262144));
    (state.tenants[0]!.broker as any).ordinaryHeader = (ordinary.tenants[0]!.broker as any).ordinaryHeader;
    const capacity = deriveSuccessionCapacity(state, costs); charges.push(capacity.featureCharge);
    expect(capacity.violations).toEqual([]);
    expect(deriveSuccessionCapacity(ordinary, costs).featureCharge).toBe(0);
  }
  // No whole ordinary-header charge or virtual fee appears at either BLOB boundary.
  expect(Math.max(...charges) - Math.min(...charges)).toBeLessThanOrEqual(4);
}, 10000);

test('derives every missing progress slot and retains the full supported Host identity inventory', () => {
  const state = initial(1), associations = state.tenants[0]!.broker.associations!, template = associations.freezes[0]!;
  associations.freezes = Array.from({ length: 1024 }, (_, index) => ({ ...structuredClone(template), receipt: { ...template.receipt, token: 'token-' + index,
    request: { ...template.receipt.request, operationId: 'operation-' + index, roleId: 'role-' + Math.floor(index / 512) } } }));
  expect(deriveSuccessionCapacity(state, costs).tenants[0]!.progressSlots).toBe(1024);
  const retained = initial(1); retained.tenants[0]!.broker.revokedHosts = Array.from({ length: 8191 }, (_, index) => ({ hostId: 'historic-host-' + index,
    installationId: 'historic-installation-' + index, revocationId: '00000000-0000-4000-8000-000000000001' }));
  expect(deriveSuccessionCapacity(retained, costs).violations).toEqual([]);
  retained.tenants[0]!.broker.revokedHosts.push({ hostId: 'overflow-host', installationId: 'overflow-installation', revocationId: '00000000-0000-4000-8000-000000000001' });
  expect(() => createRelayState(auth, { initial: retained, async commit() {} }, () => {}, () => {}, costs)).toThrow(/state|identity|capacity/i);
}, 10000);

function currentRecovery() {
  const state = fullInventory(), broker = state.tenants[0]!.broker;
  broker.associations!.freezes = []; broker.associations!.admissions = []; broker.associations!.relationChanges = [];
  delete state.tenants[0]!.favoritesSuccession;
  broker.keys = []; broker.pairings = broker.pairings!.filter(row => row.usedAt !== undefined);
  return state;
}

test('current used recovery identity retains missing completion claims without inventing future rotations', () => {
  const state = currentRecovery(), broker = state.tenants[0]!.broker, recovery = broker.pairings![0]!.recovery!;
  expect(deriveSuccessionCapacity(state, costs).tenants[0]).toMatchObject({ hostSlots: 1, credentialSlots: 1 });
  broker.hosts.push({ id: recovery.hostId, installationId: recovery.installationId, name: 'Recovered', providers: [], legacyDsh: false });
  expect(deriveSuccessionCapacity(state, costs).tenants[0]).toMatchObject({ hostSlots: 0, credentialSlots: 1 });
  broker.keys.push(['c'.repeat(64), { expires: Number.MAX_SAFE_INTEGER, installationId: recovery.installationId, kind: 'device' }]);
  const complete = deriveSuccessionCapacity(state, costs);
  expect(complete.tenants[0]).toMatchObject({ hostSlots: 0, credentialSlots: 0 });
  const before = total(state);
  broker.keys.push(['d'.repeat(64), { expires: Number.MAX_SAFE_INTEGER, installationId: recovery.installationId, kind: 'device', extra: 'complete retained overlap' } as any]);
  const overlap = deriveSuccessionCapacity(state, costs);
  expect(overlap.retainedBytes - complete.retainedBytes).toBe(total(state) - before);
  expect(overlap.tenants[0]).toMatchObject({ hostSlots: 0, credentialSlots: 0 });
  broker.keys.shift();
  expect(deriveSuccessionCapacity(state, costs).featureCharge).toBeLessThan(overlap.featureCharge);
  broker.keys = []; broker.hosts = broker.hosts.filter(row => row.id !== recovery.hostId);
  broker.revokedHosts![0]!.revocationId = '00000000-0000-4000-8000-000000000002';
  expect(deriveSuccessionCapacity(state, costs).tenants[0]).toMatchObject({ hostSlots: 0, credentialSlots: 0 });
  broker.keys.push(['e'.repeat(64), { expires: 100, requiresRotation: true, purpose: 'host-only', installationId: recovery.installationId, recovery }]);
  expect(() => deriveSuccessionCapacity(state, costs)).toThrow(/state/);
}, 10000);

for (const blocker of ['authority', 'mapping', 'tree', 'revision'] as const) test(`pending Favorites ${blocker} preserves complete projection and recomputes ordinary growth`, async () => {
  const state = fullInventory(), tenant = state.tenants[0]!;
  tenant.broker.associations!.freezes = tenant.broker.associations!.freezes.slice(0, 1);
  tenant.broker.associations!.admissions = []; tenant.broker.associations!.relationChanges = []; delete tenant.favoritesSuccession;
  state.sessionStars = [{ subject: 'owner', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'Before', starredAt: 1 }];
  state.favoritesTrees = [];
  if (blocker === 'mapping') tenant.broker.hosts[0]!.providers = [];
  if (blocker === 'tree') state.favoritesTrees = Array.from({ length: 1024 }, (_, index) => ({ subject: 'other-' + index, revision: 0, folders: [] }));
  if (blocker === 'revision') state.favoritesTrees = [{ subject: 'owner', revision: Number.MAX_SAFE_INTEGER, folders: [] }];
  let saved: HostedRelayState | undefined;
  const relay = createRelayState(auth, { initial: state, async commit(value) { saved = structuredClone(value); } }, () => {}, () => {}, costs);
  await relay.mutate(draft => { projectSuccessionFavorites(draft, 'owner', blocker !== 'authority'); });
  expect(saved!.tenants[0]!.favoritesSuccession!.receipts[0]!.status).toBe('pending');
  expect(saved!.tenants[0]!.broker.associations!.freezes[0]).toEqual(tenant.broker.associations!.freezes[0]);
  const identity = saved!.tenants[0]!.favoritesSuccession!.receipts[0]!, before = deriveSuccessionCapacity(saved!, costs);
  await relay.mutate(draft => {
    draft.sessionStars![0]!.title = '\ud800'.repeat(512);
    draft.sessionStars!.push(...Array.from({ length: 255 }, (_, index) => ({ subject: 'owner', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'ordinary-' + index, title: 'Ordinary', workspace: '/preserved/' + index, starredAt: index + 2 })));
    draft.sessionTitles = [{ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'B', title: 'Authoritative target', revision: 1 }]; draft.sessionTitleRevision = 1;
  });
  expect(deriveSuccessionCapacity(saved!, costs).remainingBytes).toBeGreaterThan(before.remainingBytes);
  const restored = createRelayState(auth, { initial: saved, async commit(value) { saved = structuredClone(value); } }, () => {}, () => {}, costs);
  await restored.mutate(draft => {
    draft.tenants[0]!.broker.hosts[0]!.providers = [{ providerId: 'fixture', displayName: 'Fixture' }];
    draft.favoritesTrees = []; projectSuccessionFavorites(draft, 'owner', true);
  });
  expect(saved!.sessionStars![0]).toMatchObject({ nativeSessionId: 'B', title: 'Authoritative target' });
  expect(saved!.sessionStars).toHaveLength(256); expect(saved!.sessionStars!.every(star => star.favoriteId !== undefined)).toBe(true);
  expect(saved!.sessionStars![1]!.workspace).toBe('/preserved/0');
  expect(saved!.tenants[0]!.favoritesSuccession!.receipts[0]).toEqual({ ...identity, status: 'applied' });
  const applied = structuredClone(saved); await restored.mutate(draft => { projectSuccessionFavorites(draft, 'owner', true); }); expect(saved).toEqual(applied);
  await relay.close(); await restored.close();
}, 10000);


test('v3 prefix projection costs retain exact request bytes and accounting provenance', async () => {
  const legacy = initial(); legacy.version = 10;
  let saved: HostedRelayState | undefined;
  const state = createRelayState(auth, { initial: legacy, commit: async value => { saved = value; } }, () => {}, () => {}, costs);
  await state.mutate(() => {});
  await state.mutate(draft => {
    const freeze = draft.tenants[0]!.broker.associations!.freezes[0]!.receipt;
    Object.assign(freeze, { version: 3 });
    freeze.request.preparation = { kind: 'native_prefix', turnId: 'turn', messageId: 'message' };
  });
  expect(saved).toMatchObject({ version: 11, successionAccounting: true });
  const capacity = deriveSuccessionCapacity(saved!, costs);
  expect(capacity.featureCharge).toBeGreaterThan(65536);
  expect(() => createRelayState(auth, { initial: saved, commit: async () => {} }, () => {}, () => {})).toThrow(/accounting/);
});
