import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
const auth={origin:'https://relay.example',issuer:'https://issuer.example',secret:'test-secret'};
const tenant=()=>({subject:'owner',namespace:createHash('sha256').update(JSON.stringify([auth.issuer,'owner'])).digest('hex'),broker:{keys:[],hosts:[],bindings:[],creations:[],associations:{version:1 as const,revision:0,admissions:[],freezes:[]}}});

test('association persistence upgrades version 2 atomically and rejects a downgraded writer format',async()=>{
  let saved:HostedRelayState|undefined;
  const state=createRelayState(auth,{initial:emptyRelayState(auth),commit:async value=>{saved=structuredClone(value);}},()=>{},()=>{});
  await state.mutate(draft=>{draft.tenants.push(tenant());});
  expect(saved!.version).toBe(3);
  expect(validateRelayState(saved,auth).tenants[0]!.broker.associations).toBeDefined();
  expect(()=>validateRelayState({...saved,version:2},auth)).toThrow(/unsupported/);
  const restored=createRelayState(auth,{initial:saved,commit:async()=>{}},()=>{},()=>{});
  expect(restored.read().version).toBe(3);
});

test('failed association persistence publishes neither version upgrade nor reservation',async()=>{
  let failed=0,published=0;
  const state=createRelayState(auth,{commit:async()=>{throw new Error('disk unavailable');}},()=>{failed++;},()=>{published++;});
  await expect(state.mutate(draft=>{draft.tenants.push(tenant());})).rejects.toThrow(/disk/);
  expect(state.read().version).toBe(2);expect(state.read().tenants).toEqual([]);
  expect(failed).toBe(1);expect(published).toBe(0);
  await expect(state.mutate(()=>{})).rejects.toThrow(/unavailable/);
});
