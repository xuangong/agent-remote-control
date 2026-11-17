import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { MAX_RETAINED_HOST_IDENTITIES, retainedHostIdentities, type RevokedHost } from './host-recovery.js';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://issuer.example', secret: 'test-secret' };
const namespace = createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex');
const marker = (): RevokedHost => ({ hostId: 'host', installationId: 'installation', revocationId: randomUUID(), revokedAt: 10 });
function fixture(): HostedRelayState {
  const state = emptyRelayState(auth);
  state.tenants.push({ subject: 'owner', namespace, broker: { hosts: [], keys: [], bindings: [], creations: [] } });
  return state;
}
function recoveryState() {
  const state = fixture(); state.version = 8;
  const retained = marker(), { revokedAt: _, ...recovery } = retained;
  state.tenants[0]!.broker = { ...state.tenants[0]!.broker, revokedHosts: [retained],
    keys: [['a'.repeat(64), { expires: 200, installationId: retained.installationId, requiresRotation: true, purpose: 'host-only', pairingId: 'pairing', recovery }]],
    pairings: [{ id: 'pairing', purpose: 'host-only', createdAt: 100, expiresAt: 200, recovery }] };
  return state;
}

test.each([2, 3, 4, 5, 6, 7] as const)('reads existing Relay%d and upgrades only when recovery metadata is committed', async version => {
  const initial = fixture(); initial.version = version;
  let saved: HostedRelayState | undefined;
  const state = createRelayState(auth, { initial, async commit(value) { saved = validateRelayState(value, auth); } }, () => {}, () => {});
  expect(state.read().version).toBe(version);
  await state.mutate(draft => { draft.tenants[0]!.broker.revokedHosts = [marker()]; });
  expect(saved!.version).toBe(8);
  const restored = createRelayState(auth, { initial: saved, async commit(value) { saved = validateRelayState(value, auth); } }, () => {}, () => {});
  await restored.mutate(() => {});
  expect(saved!.version).toBe(8);
});

test('roundtrips a targeted recovery invitation and legacy markers without fabricated timestamps', () => {
  const state = recoveryState();
  delete state.tenants[0]!.broker.revokedHosts![0]!.revokedAt;
  expect(validateRelayState(JSON.parse(JSON.stringify(state)), auth)).toEqual(state);
});

test.each([2, 3, 4, 5, 6, 7])('rejects recovery metadata disguised as Relay%d', version => {
  const recovered = recoveryState();
  for (const field of ['revokedHosts', 'keys', 'pairings'] as const) {
    const state = fixture(); (state as { version: number }).version = version;
    Object.assign(state.tenants[0]!.broker, { [field]: recovered.tenants[0]!.broker[field] });
    expect(() => validateRelayState(state, auth)).toThrow('Invalid or unsupported Relay state.');
  }
});

test('rejects contradictory recovery authority without interpreting malformed storage', () => {
  for (const mutate of [
    (state: HostedRelayState) => { state.tenants[0]!.broker.revokedHosts!.push(marker()); },
    (state: HostedRelayState) => { state.tenants[0]!.broker.keys[0]![1].recovery!.revocationId = randomUUID(); },
    (state: HostedRelayState) => { state.tenants[0]!.broker.keys[0]![1].installationId = 'different'; },
    (state: HostedRelayState) => { state.tenants[0]!.broker.keys[0]![1].purpose = 'gateway-setup'; },
    (state: HostedRelayState) => { state.tenants[0]!.broker.keys[0]![1].requiresRotation = false; },
    (state: HostedRelayState) => { state.tenants[0]!.broker.keys[0]![1].kind = 'device'; },
    (state: HostedRelayState) => { state.tenants[0]!.broker.hosts.push({ id: 'other', installationId: 'installation', name: 'Other', providers: [], legacyDsh: false }); },
    (state: HostedRelayState) => { Object.assign(state.tenants[0]!.broker.revokedHosts![0]!, { unknown: true }); },
    (state: HostedRelayState) => { Object.assign(state.tenants[0]!.broker.keys[0]![1].recovery!, { unknown: true }); },
    (state: HostedRelayState) => { Object.assign(state.tenants[0]!.broker.pairings![0]!, { hostId: 'wrong', hostName: 'Wrong', usedAt: 110 }); },
    (state: HostedRelayState) => { Object.assign(state.tenants[0]!.broker, { keys: {} }); state.version = 2; },
  ]) {
    const state = structuredClone(recoveryState()); mutate(state);
    expect(() => validateRelayState(state, auth)).toThrow('Invalid or unsupported Relay state.');
  }
});

test('bounds the union of markers and admitted identities, while an existing identity needs no extra slot', () => {
  const state = fixture().tenants[0]!.broker;
  state.revokedHosts = Array.from({ length: MAX_RETAINED_HOST_IDENTITIES }, (_, index) => ({ hostId: `host-${index}`, installationId: `installation-${index}`, revocationId: randomUUID() }));
  state.hosts = [{ id: 'host-new', installationId: 'installation-new', name: 'New', providers: [], legacyDsh: false }];
  state.associations = { version: 4, revision: 0, freezes: [], relationChanges: [], relationResets: [], admissions: [{ id: 'admitted', fingerprint: 'fingerprint', source: { controllerId: 'installation-new', providerId: 'fixture', nativeSessionId: 'A' } }] };
  expect(() => retainedHostIdentities(state)).toThrow(/capacity/);
  state.revokedHosts.pop();
  expect(retainedHostIdentities(state).size).toBe(MAX_RETAINED_HOST_IDENTITIES);
  state.revokedHosts.push({ hostId: 'host-new', installationId: 'installation-new', revocationId: randomUUID() });
  state.hosts = [];
  expect(retainedHostIdentities(state).size).toBe(MAX_RETAINED_HOST_IDENTITIES);
});

test('reads legacy reset and re-pair history, preserving both identities through upgrade and restart', async () => {
  const legacy = fixture(); legacy.version = 6;
  const broker = legacy.tenants[0]!.broker;
  const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
  broker.hosts.push({ id: 'new-host', installationId: 'installation', name: 'Repaired', providers: [], legacyDsh: false });
  broker.keys.push(['a'.repeat(64), { expires: Number.MAX_SAFE_INTEGER, installationId: 'installation', kind: 'device' }]);
  broker.associations = { version: 4, revision: 1, admissions: [], freezes: [], relationChanges: [], relationResets: [{ version: 1, phase: 'pre_effect', intent: {
    version: 1, operationId: 'reset-before-revoke', authority: { version: 1, origin: auth.origin, issuer: auth.issuer, namespace, ownerSubject: 'owner' },
    hostId: 'old-host', controllerId: 'installation', readerRef: ref('S'), sourceRef: ref('A'), relationId: 'side', linked: false, expectedRelationRevision: 0, expectedRoleRevision: 1,
  } }] };
  expect(validateRelayState(legacy, auth)).toEqual(legacy);
  expect(retainedHostIdentities(broker).size).toBe(0);
  let saved: HostedRelayState | undefined;
  const state = createRelayState(auth, { initial: legacy, async commit(value) { saved = validateRelayState(value, auth); } }, () => {}, () => {});
  await state.mutate(draft => { draft.tenants[0]!.broker.revokedHosts = [{ hostId: 'unrelated-host', installationId: 'unrelated-installation', revocationId: randomUUID() }]; });
  expect(saved!.version).toBe(11);
  const restarted = createRelayState(auth, { initial: saved, async commit(value) { saved = validateRelayState(value, auth); } }, () => {}, () => {});
  await restarted.mutate(() => {});
  expect(saved!.tenants[0]!.broker).toMatchObject({ hosts: broker.hosts, keys: broker.keys, associations: { ...broker.associations, version: 6 } });
  expect(retainedHostIdentities(saved!.tenants[0]!.broker).has('old-host')).toBe(false);
  const contradictory = structuredClone(saved!);
  contradictory.tenants[0]!.broker.revokedHosts!.push({ hostId: 'old-host', installationId: 'installation', revocationId: randomUUID() });
  expect(() => validateRelayState(contradictory, auth)).toThrow('Invalid or unsupported Relay state.');
});
