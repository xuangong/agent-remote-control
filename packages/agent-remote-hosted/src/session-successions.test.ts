import { expect, test } from 'vitest';
import { createSessionSuccessions } from './session-successions.js';
import { createRelayState } from './state.js';
const ref=(nativeSessionId:string)=>({controllerId:'host',providerId:'codex',nativeSessionId});
const workspace={controllerId:'host',canonicalCwd:'/workspace'};
const projection=(revision=2)=>({version:1 as const,role:{id:'role',revision,origin:ref('A'),current:ref(revision===2?'B':'C'),workspace},receipt:{operationId:`op-${revision}`,roleId:'role',expectedRevision:revision-1,from:ref(revision===2?'A':'B'),to:ref(revision===2?'B':'C'),phase:'committed' as const,committedRevision:revision,startedAt:'now',updatedAt:'now',prepared:{operationId:`op-${revision}`,roleId:'role',expectedRevision:revision-1,from:ref(revision===2?'A':'B'),to:ref(revision===2?'B':'C'),workspace,associationRevision:0,participants:[],capture:{epoch:'e',seq:1,capturedAt:'now'}}}});
const auth={origin:'https://relay.example',issuer:'https://gateway.example',secret:'s'.repeat(32)};
test('requires an authenticated owning Host and filters replay by both actual addresses',async()=>{
 const state=createRelayState(auth,undefined,()=>{},()=>{});let denied=false;
 const store=createSessionSuccessions(state,(host,controller,subject)=>host===controller&&subject==='owner',()=>!denied);
 await expect(store.save('owner','browser',projection())).rejects.toThrow(/owner/);
 await store.save('owner','host',projection());await store.save('owner','host',projection());
 expect(store.list('owner','role',1)).toHaveLength(1);denied=true;expect(store.list('owner','role',1)).toEqual([]);expect(store.list('other','role',1)).toEqual([]);
});
test('replays contiguous revisions without reverting stale events and rejects conflicting receipts',async()=>{
 const state=createRelayState(auth,undefined,()=>{},()=>{});const store=createSessionSuccessions(state,()=>true,()=>true);
 await expect(store.save('owner','host',projection(3))).rejects.toThrow(/lineage/);
 await store.save('owner','host',projection());await store.save('owner','host',projection(3));await store.save('owner','host',projection());
 expect(store.list('owner','role',1).map(value=>value.role.revision)).toEqual([2,3]);
 await expect(store.save('owner','host',{...projection(),role:{...projection().role,current:ref('wrong')}})).rejects.toThrow();
});
test('storage failure does not publish a projection',async()=>{
 const state=createRelayState(auth,{commit:async()=>{throw new Error('disk');}},()=>{},()=>{});const store=createSessionSuccessions(state,()=>true,()=>true);
 await expect(store.save('owner','host',projection())).rejects.toThrow('disk');expect(store.list('owner','role')).toEqual([]);
});

test('restores committed lineage and refuses access to an unreadable predecessor',async()=>{
 let persisted:unknown;
 const state=createRelayState(auth,{commit:async snapshot=>{persisted=structuredClone(snapshot);}},()=>{},()=>{});
 const store=createSessionSuccessions(state,()=>true,()=>true);await store.save('owner','host',projection());
 const restored=createRelayState(auth,{initial:persisted,commit:async()=>{}},()=>{},()=>{});
 expect(createSessionSuccessions(restored,()=>true,()=>true).list('owner','role')).toHaveLength(1);
 const hidden=createSessionSuccessions(restored,()=>true,(_subject,source)=>source.nativeSessionId!=='A');
 expect(hidden.list('owner','role')).toEqual([]);
});
