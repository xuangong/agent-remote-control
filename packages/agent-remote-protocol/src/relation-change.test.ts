import { expect, test } from 'vitest';
import { isRelationChangeReservation, relationChangeKey, type RelationChangeReservation } from './relation-change.js';
const ref = (nativeSessionId: string, providerId = 'p') => ({ controllerId: 'controller', providerId, nativeSessionId });
const reservation: RelationChangeReservation = { version: 1, operationId: 'edit', token: 'token', authority: { version: 1, origin: 'https://relay.example', issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' }, hostId: 'host', controllerId: 'controller', roleId: 'role', expectedRoleRevision: 2, origin: ref('A'), current: ref('A', 'other'), lineage: [ref('A'), ref('A', 'other')], associationRevision: 1, catalogRevision: 4, relationId: 'side', kind: 'side', readerRef: ref('S'), sourceRef: ref('A'), expectedRelationRevision: 0, previousLinked: true, linked: false, previousMember: true, relations: [{ relationId: 'side', kind: 'side', readerRef: ref('S'), sourceRef: ref('A'), linked: true, revision: 0 }] };
test('requires complete strict relation identity and full source lineage', () => {
  expect(isRelationChangeReservation(reservation)).toBe(true);
  for (const changed of [{ ...reservation, forged: true }, { ...reservation, sourceRef: ref('A', 'forged') }, { ...reservation, readerRef: { ...ref('S'), controllerId: 'other' } }, { ...reservation, expectedRelationRevision: 1 }, { ...reservation, relations: [] }]) expect(isRelationChangeReservation(changed)).toBe(false);
});
test('canonical identity tolerates reordered object fields and rejects changed intent', () => {
  expect(relationChangeKey({ ...reservation, current: { nativeSessionId: 'A', providerId: 'other', controllerId: 'controller' } })).toBe(relationChangeKey(reservation));
  expect(relationChangeKey({ ...reservation, linked: true })).not.toBe(relationChangeKey(reservation));
});
