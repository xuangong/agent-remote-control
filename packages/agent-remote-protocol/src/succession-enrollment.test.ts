import { expect, test } from 'vitest';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { isSuccessionAssociationFreeze } from './succession-enrollment.js';
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
