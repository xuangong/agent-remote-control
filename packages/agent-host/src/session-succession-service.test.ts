import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionService, type SessionSuccessionPorts } from './session-succession-service.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'succession-service-'))); roots.push(root);
 let created = 0, captures = 0, denied = false;
 const ports: SessionSuccessionPorts = {
  supports: async () => true,
  inspect: async () => ({cwd:root,idle:true,managed:true,pendingInputs:0,inFlightInputs:0,pendingInteractions:0,activeChildren:0,boundary:{epoch:'e',seq:1}}),
  createIdle: async (_source, _operation, provider) => ({...ref(String.fromCharCode(66 + created++)),providerId:provider}),
  captureTimeline: async () => { captures++; return {entries:[{item:{type:'user_message',text:'old work'}}] as never,boundary:{epoch:'e',seq:1},capturedAt:'2026-10-10T00:00:00Z'}; },
  authorizeRead: async () => { if (denied) throw new Error('access revoked'); },
  readHistory: async () => ({entries:[]}),
  reconcileDelivery: async () => undefined,
 };
 const service = new SessionSuccessionService(join(root,'state'),'host',ports); await service.ready;
 await service.createRole({id:'role',revision:1,origin:ref('A'),current:ref('A'),workspace:{controllerId:'host',canonicalCwd:root}});
 return {root,ports,service,created:()=>created,captures:()=>captures,deny:()=>{denied=true;}};
}
const request = {operationId:'op',roleId:'role',expectedRevision:1,from:ref('A')};
test('assembles durable context before readiness and persists a cursor key across restart',async()=>{
 const f=await fixture(); expect((await f.service.prepare(request)).phase).toBe('ready');
 expect(f.created()).toBe(1); expect(f.captures()).toBe(1);
 expect(f.service.contexts.read('op').text).toContain('old work');
 await f.service.commit('op',1);
 const saved=await readFile(join(f.root,'state','source-cursor.key'));
 const restored=new SessionSuccessionService(join(f.root,'state'),'host',f.ports); await restored.ready;
 expect(await readFile(join(f.root,'state','source-cursor.key'))).toEqual(saved); expect(saved.length).toBe(32);
 expect(restored.store.read('role').role.current).toEqual(ref('B'));
});
test('preserves pending raw rows across B to C without recapturing wrapped messages',async()=>{
 const f=await fixture(); await f.service.prepare(request); await f.service.commit('op',1);
 const text=f.service.contexts.read('op').text;
 await f.service.prepare({...request,operationId:'next',expectedRevision:2,from:ref('B')});
 expect(f.service.contexts.read('next').text).toBe(text); expect(f.captures()).toBe(1);
});
test('rejects unsupported creation and refuses optimistic materialization without native proof',async()=>{
 const f=await fixture(); f.ports.supports=async()=>false;
 expect((await f.service.prepare(request)).phase).toBe('rejected'); expect(f.created()).toBe(0);
});

test('reads inherited raw rows with original provenance and rechecks workspace access',async()=>{
 const f=await fixture();
 await f.service.store.setParticipants('role',1,0,[{relationId:'ask',kind:'ask',before:ref('Q'),after:ref('Q')}]);
 await f.service.prepare(request); await f.service.commit('op',1);
 const bindings=f.service.bindings('fixture');
 const first=await bindings.read('Q','A',{},f.ports.readHistory as never);
 expect(first.sourceRepresentation).toBe('attachment');
 await f.service.prepare({...request,operationId:'next',expectedRevision:2,from:ref('B')}); await f.service.commit('next',2);
 const inherited=await bindings.read('Q','A',{},f.ports.readHistory as never);
 expect(inherited).toMatchObject({sourceRef:ref('C'),sourceProvenance:{source:ref('B'),inheritedFrom:{operationId:'op',source:ref('A')}}});
 expect(inherited.entries[0]!.text).toBe('old work');
 expect((await bindings.read('Q','A',{sourceContext:first.sourceContext},f.ports.readHistory as never)).sourceRef).toEqual(ref('B'));
 f.deny(); await expect(bindings.read('Q','A',{},f.ports.readHistory as never)).rejects.toThrow('access revoked');
 const restored=new SessionSuccessionService(join(f.root,'state'),'host',f.ports);await restored.ready;
 expect(restored.contexts.read('next').inheritedFrom).toMatchObject({operationId:'op',source:ref('A')});
});
test('requires adapter-native proof to materialize queued context',async()=>{
 const f=await fixture(); await f.service.prepare(request); await f.service.commit('op',1);
 await f.service.contexts.begin('op',{operationId:'first',roleId:'role',roleRevision:2,target:ref('B'),text:'new'});
 await f.service.contexts.settle('op','first','accepted',{disposition:'queued'});
 expect(await f.service.reconcileFirstInput('op')).toBe(false);expect(f.service.contexts.read('op').state).toBe('accepted');
 f.ports.reconcileDelivery=async()=>({outcome:'materialized',nativeEvidence:'native-history-id'});
 expect(await f.service.reconcileFirstInput('op')).toBe(true);expect(f.service.contexts.read('op').state).toBe('materialized');
});

test('refuses a corrupt persisted cursor key rather than replacing historical cursor authentication',async()=>{
 const f=await fixture();const {writeFile}=await import('node:fs/promises');
 await writeFile(join(f.root,'state','source-cursor.key'),'invalid');
 const restored=new SessionSuccessionService(join(f.root,'state'),'host',f.ports);
 await expect(restored.ready).rejects.toThrow('signing key');
 expect(await readFile(join(f.root,'state','source-cursor.key'),'utf8')).toBe('invalid');
});

test('description reuses native quiescence and bounded support without reserving or creating', async () => {
 const f=await fixture(), role=f.service.store.read('role').role;
 f.ports.supportsBoundedProjection=async(_source,target)=>target==='fixture';
 const targets=[{providerId:'fixture',displayName:'Fixture'},{providerId:'other',displayName:'Other'}];
 expect(await f.service.describe(role,ref('A'),targets)).toMatchObject({targets:[targets[0]],eligibility:{status:'ready'}});
 f.ports.inspect=async()=>({cwd:f.root,idle:false,managed:true,pendingInputs:0,inFlightInputs:0,pendingInteractions:0,activeChildren:0,boundary:{epoch:'e',seq:1}});
 expect(await f.service.describe(role,ref('A'),targets)).toMatchObject({targets:[targets[0]],eligibility:{status:'blocked',code:'succession_not_quiescent'}});
 expect(await f.service.describe(role,ref('old'),targets)).toMatchObject({eligibility:{status:'unavailable',code:'session_superseded'}});
 expect(f.created()).toBe(0);expect(f.captures()).toBe(0);expect(f.service.store.read('role').operations).toEqual([]);
});
