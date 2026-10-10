import { expect, test } from 'vitest';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { isSuccessionAssociationFreeze, successionFreezeKey } from './succession-enrollment.js';
const source = { controllerId: 'installation', providerId: 'fixture', nativeSessionId: 'A' };
const authority = { version: 1, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
test('accepts only versioned enrollment handshake metadata and a complete frozen receipt', () => {
  const registered = { uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, successionEnrollment: authority };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(registered)).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, successionEnrollment: { ...authority, version: 2 } })).status).toBe('rejected');
  const freeze = { version: 1, token: 'freeze', authority, controllerId: 'installation', request: { roleId: 'role', operationId: 'operation', expectedRevision: 1, from: source }, associationRevision: 0, lineage: [source], relations: [] };
  expect(isSuccessionAssociationFreeze(freeze)).toBe(true);
  expect(isSuccessionAssociationFreeze({ ...freeze, controllerId: 'foreign' })).toBe(false);
  expect(isSuccessionAssociationFreeze({ ...freeze, lineage: [] })).toBe(false);
  expect(isSuccessionAssociationFreeze({ ...freeze, participants: [] })).toBe(false);
});


test('relation identity is scoped by its full reader reference across providers', () => {
  const relation={relationId:'same-id',kind:'side',readerRef:{...source,nativeSessionId:'side'},sourceRef:source,linked:true,revision:0};
  const freeze={version:1,token:'freeze',authority,controllerId:'installation',request:{roleId:'role',operationId:'operation',expectedRevision:1,from:source},associationRevision:0,lineage:[source],relations:[relation,{...relation,readerRef:{...relation.readerRef,providerId:'other'},sourceRef:{...source,providerId:'other'}}]};
  expect(isSuccessionAssociationFreeze(freeze)).toBe(true);
  expect(isSuccessionAssociationFreeze({...freeze,relations:[relation,relation]})).toBe(false);
});

const legacy = { version: 1 as const, token: 'freeze', authority: { ...authority, version: 1 as const }, controllerId: 'installation', request: { roleId: 'role', operationId: 'operation', expectedRevision: 1, from: source }, associationRevision: 0, lineage: [source], relations: [] };
test('v2 freezes require an immutable positive safe byte ceiling while v1 keeps its exact key', () => {
  const bounded = { ...legacy, version: 2 as const, maxProjectionBytes: 42000 };
  expect(isSuccessionAssociationFreeze(bounded)).toBe(true);
  for (const maxProjectionBytes of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42000']) {
    expect(isSuccessionAssociationFreeze({ ...bounded, maxProjectionBytes })).toBe(false);
  }
  expect(isSuccessionAssociationFreeze({ ...legacy, maxProjectionBytes: 42000 })).toBe(false);
  expect(successionFreezeKey(legacy)).toBe(String.raw`[1,"freeze","[1,\"https://relay.example\",\"https://issuer.example\",\"tenant\",\"owner\"]","installation","operation","role",1,"[\"installation\",\"fixture\",\"A\"]","fixture",0,["[\"installation\",\"fixture\",\"A\"]"],[]]`);
  expect(successionFreezeKey(bounded)).not.toBe(successionFreezeKey({ ...bounded, maxProjectionBytes: 42001 }));
});

test('feature v2 acknowledgment keeps authority v1 and requires authority in the strict registered envelope', () => {
  const registered = { uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, successionEnrollment: authority, successionEnrollmentVersion: 2 };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(registered)).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, successionEnrollmentVersion: 1 })).status).toBe('rejected');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, successionEnrollment: undefined })).status).toBe('rejected');
});
