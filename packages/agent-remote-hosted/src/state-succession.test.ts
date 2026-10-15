import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { migrateBrokerAssociations, validBrokerAssociations } from './succession-associations.js';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
const auth={origin:'https://relay.example',issuer:'https://issuer.example',secret:'test-secret'};
const tenant=()=>({subject:'owner',namespace:createHash('sha256').update(JSON.stringify([auth.issuer,'owner'])).digest('hex'),broker:{keys:[],hosts:[],bindings:[],creations:[],associations:{version:4 as const,relationResets:[],revision:0,admissions:[],freezes:[],relationChanges:[]}}});

test('association persistence upgrades version 2 atomically and rejects a downgraded writer format',async()=>{
  let saved:HostedRelayState|undefined;
  const state=createRelayState(auth,{initial:emptyRelayState(auth),commit:async value=>{saved=structuredClone(value);}},()=>{},()=>{});
  await state.mutate(draft=>{draft.tenants.push(tenant());});
  expect(saved!.version).toBe(11);
  expect(validateRelayState(saved,auth).tenants[0]!.broker.associations).toBeDefined();
  expect(()=>validateRelayState({...saved,version:2},auth)).toThrow(/unsupported/);
  const restored=createRelayState(auth,{initial:saved,commit:async()=>{}},()=>{},()=>{});
  expect(restored.read().version).toBe(11);
});

test('failed association persistence publishes neither version upgrade nor reservation',async()=>{
  let failed=0,published=0;
  const state=createRelayState(auth,{commit:async()=>{throw new Error('disk unavailable');}},()=>{failed++;},()=>{published++;});
  await expect(state.mutate(draft=>{draft.tenants.push(tenant());})).rejects.toThrow(/disk/);
  expect(state.read().version).toBe(2);expect(state.read().tenants).toEqual([]);
  expect(failed).toBe(1);expect(published).toBe(0);
  await expect(state.mutate(()=>{})).rejects.toThrow(/unavailable/);
});

test('migrates association version 1 explicitly and rejects disguised relation records',async()=>{
  const legacy=emptyRelayState(auth);legacy.version=3;
  const item=tenant();(item.broker.associations as {version:number}).version=1;delete (item.broker.associations as {relationChanges?:unknown}).relationChanges;delete (item.broker.associations as {relationResets?:unknown}).relationResets;
  legacy.tenants.push(item);
  let saved:HostedRelayState|undefined;
  const restored=createRelayState(auth,{initial:legacy,commit:async value=>{saved=structuredClone(value);}},()=>{},()=>{});
  await restored.mutate(()=>{});
  expect(saved!.version).toBe(11);expect(saved!.tenants[0]!.broker.associations).toMatchObject({version:6,relationChanges:[],relationResets:[]});
  const disguised=structuredClone(legacy);(disguised.tenants[0]!.broker.associations as unknown as {relationChanges:unknown}).relationChanges=[];
  expect(()=>validateRelayState(disguised,auth)).toThrow();
  expect(()=>validateRelayState({...saved,version:3},auth)).toThrow();
  expect(()=>validateRelayState({...saved,version:4},auth)).toThrow();
});


test('association v2 migrates required arrays but rejects disguised or absent reset evidence',()=>{
 const legacy={version:2,revision:0,admissions:[],freezes:[],relationChanges:[]};
 expect(migrateBrokerAssociations(legacy)).toMatchObject({version:6,relationResets:[]});
 expect(()=>migrateBrokerAssociations({...legacy,relationResets:[]})).toThrow();
 expect(()=>migrateBrokerAssociations({...legacy,relationChanges:null})).toThrow();
 expect(()=>migrateBrokerAssociations({...legacy,version:3})).toThrow();
 const intent={version:1 as const,operationId:'edit',authority:{version:1 as const,origin:auth.origin,issuer:auth.issuer,namespace:'tenant',ownerSubject:'owner'},hostId:'host',controllerId:'controller',readerRef:{controllerId:'controller',providerId:'fixture',nativeSessionId:'side'},sourceRef:{controllerId:'controller',providerId:'fixture',nativeSessionId:'A'},relationId:'side',linked:false,expectedRelationRevision:0,expectedRoleRevision:2};
 const state={...legacy,version:6,relationResets:[{version:1,phase:'pre_effect',intent}]};
 expect(validBrokerAssociations(state)).toBe(true);
 expect(validBrokerAssociations({...state,relationResets:[...state.relationResets,...state.relationResets]})).toBe(false);
 expect(validBrokerAssociations({...state,relationResets:Array.from({length:1025},(_,index)=>({version:1,phase:'pre_effect',intent:{...intent,operationId:String(index)}}))})).toBe(false);
 expect(validBrokerAssociations({...state,relationResets:[{version:1,phase:'pre_effect',intent:{...intent,readerRef:{...intent.readerRef,controllerId:'foreign'}}}]})).toBe(false);
 expect(validBrokerAssociations({...state,relationChanges:null})).toBe(false);
});

test('bounded allowance semantics fence association v4 and outer Relay v8 writers', async () => {
  let saved: HostedRelayState | undefined;
  const state = createRelayState(auth, { commit: async value => { saved = structuredClone(value); } }, () => {}, () => {});
  await state.mutate(draft => { draft.tenants.push(tenant()); });
  expect(saved!.version).toBe(11);
  expect(saved!.tenants[0]!.broker.associations!.version).toBe(6);
  expect(() => validateRelayState({ ...saved, version: 8 }, auth)).toThrow();
  const source = { controllerId: 'controller', providerId: 'fixture', nativeSessionId: 'A' };
  const bounded = { version: 2, maxProjectionBytes: 50000, token: 'token', authority: { version: 1, origin: auth.origin, issuer: auth.issuer, namespace: 'tenant', ownerSubject: 'owner' }, controllerId: 'controller', request: { operationId: 'op', roleId: 'role', from: source, expectedRevision: 1 }, associationRevision: 0, lineage: [source], relations: [] };
  expect(() => migrateBrokerAssociations({ version: 4, revision: 0, relationChanges: [], relationResets: [], admissions: [], freezes: [{ hostId: 'host', receipt: bounded }] })).toThrow();
});


test('v11 preserves optional accounting provenance and rejects downgraded prefix state', async () => {
  const legacy = emptyRelayState(auth); legacy.version = 9; legacy.tenants.push(tenant());
  let saved: HostedRelayState | undefined;
  const state = createRelayState(auth, { initial: legacy, commit: async value => { saved = value; } }, () => {}, () => {});
  await state.mutate(() => {});
  expect(saved).toMatchObject({ version: 11 }); expect(saved).not.toHaveProperty('successionAccounting');
  expect(createRelayState(auth, { initial: saved, commit: async () => {} }, () => {}, () => {}).read()).toEqual(saved);
  expect(() => createRelayState(auth, { initial: { ...legacy, version: 10 }, commit: async () => {} }, () => {}, () => {})).toThrow(/encoding|accounting/i);
  expect(() => validateRelayState({ ...legacy, successionAccounting: true }, auth)).toThrow();
  const source = { controllerId: 'controller', providerId: 'fixture', nativeSessionId: 'A' };
  saved!.tenants[0]!.broker.associations!.freezes.push({ hostId: 'host', receipt: { version: 3, token: 'token', maxProjectionBytes: 1, authority: { version: 1, origin: auth.origin, issuer: auth.issuer, namespace: saved!.tenants[0]!.namespace, ownerSubject: 'owner' }, controllerId: 'controller', request: { operationId: 'prefix', roleId: 'role', expectedRevision: 1, from: source, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } }, associationRevision: 0, lineage: [source], relations: [] }, cancelOnly: true });
  expect(() => validateRelayState(saved, auth)).toThrow();
  expect(validateRelayState({ ...saved, successionAccounting: true }, auth)).toBeDefined();
  expect(() => createRelayState(auth, { initial: { ...saved, successionAccounting: true }, commit: async () => {} }, () => {}, () => {})).toThrow(/encoding|accounting/i);
  const associations = saved!.tenants[0]!.broker.associations!;
  for (const change of [(row: any) => { row.receipt.version = 2; }, (row: any) => { delete row.receipt.request.preparation; }, (row: any) => { row.receipt.maxProjectionBytes = 2; }, (row: any) => { row.released = 'committed'; }]) {
    const invalid = structuredClone(associations); change(invalid.freezes[0]); expect(validBrokerAssociations(invalid)).toBe(false);
  }
  expect(() => migrateBrokerAssociations({ ...associations, version: 5 })).toThrow(/Legacy/);
});
