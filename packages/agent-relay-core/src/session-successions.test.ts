import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createRelayState, emptyRelayState, validateRelayState } from './state.js';
import { migrateBrokerAssociations } from './succession-associations.js';
import type { RemoteHostBrokerState } from './broker.js';
import type { CommittedSuccessionProjection, SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
const namespace = createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex');
const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
function row(revision = 2) {
  const request = { operationId: `op-${revision}`, roleId: 'role', expectedRevision: revision - 1, from: ref(revision === 2 ? 'A' : 'B') };
  const projection: CommittedSuccessionProjection = { version: 1, role: { id: 'role', revision, origin: ref('A'), current: ref(revision === 2 ? 'B' : 'C'), workspace },
    receipt: { ...request, to: ref(revision === 2 ? 'B' : 'C'), phase: 'committed', committedRevision: revision, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: ref(revision === 2 ? 'B' : 'C'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } };
  const receipt: SuccessionAssociationFreeze = { version: 1, token: `freeze-${revision}`,
    authority: { version: 1, origin: auth.origin, issuer: auth.issuer, namespace, ownerSubject: 'owner' }, controllerId: 'installation', request,
    associationRevision: 0, lineage: revision === 2 ? [ref('A')] : [ref('A'), ref('B')], relations: [] };
  return { hostId: 'mapped-host', receipt, released: 'committed' as const, projection };
}
function saved(rows = [row(), row(3)]) {
  const state = emptyRelayState(auth); state.version = 5;
  const broker: RemoteHostBrokerState = { hosts: [{ id: 'mapped-host', installationId: 'installation', name: 'Host', legacyDsh: false,
    providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }], keys: [], bindings: [], creations: [],
    associations: { version: 3, revision: 2, admissions: [], relationChanges: [], relationResets: [], freezes: rows } };
  state.tenants.push({ subject: 'owner', namespace, broker }); return state;
}
test('rejects a structurally valid committed gap instead of manufacturing its missing receipt', () => {
  expect(() => validateRelayState(saved([row(3)]), auth)).toThrow();
});
test('migrates only exact legacy mirrors to the single Broker authority', async () => {
  const legacy = { ...saved(), sessionSuccessions: [row(), row(3)].map(item => ({ subject: 'owner', ...item.projection })) };
  let persisted: unknown;
  const state = createRelayState(auth, { initial: legacy, commit: async value => { persisted = structuredClone(value); } }, () => {}, () => {});
  await state.mutate(() => {});
  expect(persisted).toMatchObject({ version: 11, tenants: [{ broker: { associations: { version: 6 } } }] });
  expect(persisted).not.toHaveProperty('sessionSuccessions');
  expect(legacy.sessionSuccessions).toHaveLength(2);
  expect(() => validateRelayState({ ...legacy, sessionSuccessions: [{ ...legacy.sessionSuccessions[0]!, receipt: { ...row().projection.receipt, updatedAt: 'changed' } }] }, auth)).toThrow();
});
test('retains committed evidence when a current mapping or provider is removed', () => {
  const initial = saved(); initial.tenants[0]!.broker.hosts = [];
  expect(validateRelayState(initial, auth).tenants[0]!.broker.associations!.freezes).toHaveLength(2);
  const unavailable = saved(); unavailable.tenants[0]!.broker.hosts[0]!.providers = [];
  expect(validateRelayState(unavailable, auth).tenants[0]!.broker.associations!.freezes).toHaveLength(2);
  const contradictory = saved(); contradictory.tenants[0]!.broker.hosts[0]!.installationId = 'other';
  expect(() => validateRelayState(contradictory, auth)).toThrow();
});
test('rejects changed freeze request, reordered lineage and reused executors', () => {
  for (const mutate of [
    (value: ReturnType<typeof saved>) => { value.tenants[0]!.broker.associations!.freezes[0]!.receipt.request.from = ref('wrong'); },
    (value: ReturnType<typeof saved>) => { value.tenants[0]!.broker.associations!.freezes[1]!.receipt.lineage.reverse(); },
    (value: ReturnType<typeof saved>) => { const item = value.tenants[0]!.broker.associations!.freezes[1]!; item.projection!.role.current = ref('A'); item.projection!.receipt.to = ref('A'); item.projection!.receipt.prepared!.to = ref('A'); },
  ]) { const initial = saved(); mutate(initial); expect(() => validateRelayState(initial, auth)).toThrow(); }
  expect(migrateBrokerAssociations(saved().tenants[0]!.broker.associations).version).toBe(6);
});
