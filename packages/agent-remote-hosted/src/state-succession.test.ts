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
  expect(saved!.version).toBe(6);
  expect(validateRelayState(saved,auth).tenants[0]!.broker.associations).toBeDefined();
  expect(()=>validateRelayState({...saved,version:2},auth)).toThrow(/unsupported/);
  const restored=createRelayState(auth,{initial:saved,commit:async()=>{}},()=>{},()=>{});
  expect(restored.read().version).toBe(6);
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
  expect(saved!.version).toBe(6);expect(saved!.tenants[0]!.broker.associations).toMatchObject({version:4,relationChanges:[],relationResets:[]});
  const disguised=structuredClone(legacy);(disguised.tenants[0]!.broker.associations as unknown as {relationChanges:unknown}).relationChanges=[];
  expect(()=>validateRelayState(disguised,auth)).toThrow();
  expect(()=>validateRelayState({...saved,version:3},auth)).toThrow();
  expect(()=>validateRelayState({...saved,version:4},auth)).toThrow();
});


test('association v2 migrates required arrays but rejects disguised or absent reset evidence',()=>{
 const legacy={version:2,revision:0,admissions:[],freezes:[],relationChanges:[]};
 expect(migrateBrokerAssociations(legacy)).toMatchObject({version:4,relationResets:[]});
 expect(()=>migrateBrokerAssociations({...legacy,relationResets:[]})).toThrow();
 expect(()=>migrateBrokerAssociations({...legacy,relationChanges:null})).toThrow();
 expect(()=>migrateBrokerAssociations({...legacy,version:3})).toThrow();
 const intent={version:1 as const,operationId:'edit',authority:{version:1 as const,origin:auth.origin,issuer:auth.issuer,namespace:'tenant',ownerSubject:'owner'},hostId:'host',controllerId:'controller',readerRef:{controllerId:'controller',providerId:'fixture',nativeSessionId:'side'},sourceRef:{controllerId:'controller',providerId:'fixture',nativeSessionId:'A'},relationId:'side',linked:false,expectedRelationRevision:0,expectedRoleRevision:2};
 const state={...legacy,version:4,relationResets:[{version:1,phase:'pre_effect',intent}]};
 expect(validBrokerAssociations(state)).toBe(true);
 expect(validBrokerAssociations({...state,relationResets:[...state.relationResets,...state.relationResets]})).toBe(false);
 expect(validBrokerAssociations({...state,relationResets:Array.from({length:1025},(_,index)=>({version:1,phase:'pre_effect',intent:{...intent,operationId:String(index)}}))})).toBe(false);
 expect(validBrokerAssociations({...state,relationResets:[{version:1,phase:'pre_effect',intent:{...intent,readerRef:{...intent.readerRef,controllerId:'foreign'}}}]})).toBe(false);
 expect(validBrokerAssociations({...state,relationChanges:null})).toBe(false);
});
