import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AGENT_NATIVE_EVIDENCE_REASONS, type AgentEmptyCreationResult } from '@orchardworks/agent-provider-sdk';
import { expect, test, vi } from 'vitest';
import { successionHostFixture as fixture, SessionSuccessionStore, Native, EvidenceNative, PromptNative, ref, sendOverWebSocket, deferredBoundary, handoffRequest as request, nativePrefixRequest } from './succession-host-testing.js';
test.each([undefined, 'started'] as const)('prepared first WebSocket input acknowledges exact submitted text with native acceptance %s', async disposition => {
 const f=await fixture(false,false,undefined,false,true);
 try {
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  await f.control('commit',{operationId:'handoff',expectedRevision:1});
  const b=f.sessions.get('B') as EvidenceNative;
  const dispatch=b.nativeEvidence.dispatchInput;
  b.nativeEvidence.dispatchInput=async witness=>{await dispatch(witness);return disposition ? {disposition} : undefined;};
  const attached=await f.attach('B'), operationId='00000000-0000-4000-8000-000000009221';
  const ack=await sendOverWebSocket(f,attached.agentId,'Continue 原文\r\n',operationId);
  expect(b.sent[0]).toContain('quoted conversation history');
  expect(b.sent[0]).toContain('Continue 原文\r\n');
  expect(ack).toMatchObject({type:'command_acknowledged',payload:{submittedTextSha256:createHash('sha256').update(b.sent[0]!).digest('hex')}});
  if (ack.type !== 'command_acknowledged') throw new Error('Missing input acknowledgement');
  expect(ack.payload.inputAcceptance).toEqual(disposition ? {disposition} : undefined);
  expect(await sendOverWebSocket(f,attached.agentId,'Continue 原文\r\n',operationId)).toMatchObject(ack);
  expect(b.dispatches).toBe(1);
 } finally {await f.close();}
});
test.each([false,true])('Host native evidence dispatch and independent readback preserve uncertainty, lost response %s',async lost=>{
 const f=await fixture(false,false,undefined,false,true,true);
 try{
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  expect(f.creates()).toBe(0);expect(f.evidenceCreates()).toBe(1);
  expect(f.creationOptions).toContainEqual({status:'created',handle:{providerId:'fixture',sessionId:'B',opaque:'original complete handle'}});
  expect((await f.control('commit',{operationId:'handoff',expectedRevision:1})).payload.phase).toBe('committed');
  const b=f.sessions.get('B') as EvidenceNative;b.dispatchFailure=lost;
  const attached=await f.attach('B'),id='00000000-0000-4000-8000-000000000901';
  const sent=await sendOverWebSocket(f,attached.agentId,'continue',id);
  expect(sent.type).toBe(lost?'protocol_error':'command_acknowledged');expect(b.dispatches).toBe(1);expect(b.preparations).toBe(1);
  const before=f.stateFiles.contexts.text('context.json');
  expect(JSON.parse(before).attachments[0].deliveries[0].preparedInput.witness.inputId).toBe('U-1');
  const captures=b.captures;
  expect((await f.control('reconcile',{operationId:'handoff'})).payload.materialized).toBe(false);
  expect(f.stateFiles.contexts.text('context.json')).toBe(before);
  b.materialized=true;
  expect((await f.control('reconcile',{operationId:'handoff'})).payload.materialized).toBe(true);
  expect(b.captures).toBe(captures);expect(b.inspections).toBe(2);expect(b.dispatches).toBe(1);
  await sendOverWebSocket(f,attached.agentId,'continue',id);expect(b.dispatches).toBe(1);expect(b.preparations).toBe(1);
  b.unresolved=false;
  expect((await f.control('prepare',{...request,operationId:'next',expectedRevision:2,from:ref('B')})).payload.phase).toBe('rejected');
  expect(f.evidenceCreates()).toBe(1);
 }finally{await f.close();}
});
test('Host refuses a known-rejected creation before candidate workspace reads or open',async()=>{
 const f=await fixture(false,false,undefined,false,true);
 try{
  f.creationResult({status:'known_rejected',handle:{providerId:'fixture',sessionId:'B',opaque:'recovery only'},code:'native_evidence_stale',reason:AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_stale});
  expect((await f.control('prepare',request)).payload.phase).toBe('rejected');
  expect(f.creationOptions).not.toContainEqual(expect.objectContaining({status:'known_rejected'}));
  expect((await f.attach('B')).error).toBeDefined();
  expect(f.creationOptions).toEqual([undefined]);
  expect(f.workspaceReads).not.toContain('B');
 }finally{await f.close();}
});
test.each(['known_rejected', 'created'] as const)('Host preserves cancelled late %s creation evidence during explicit attach and restore', async status => {
 const f = await fixture(false, false, undefined, false, true, true);
 let release = () => {}; let entered = false;
 let running: ReturnType<typeof f.control> | undefined;
 const gate = new Promise<void>(resolve => { release = resolve; });
 try {
  const handle = { providerId: 'fixture', sessionId: 'B', opaque: 'original cancelled creation handle' };
  const outcome: AgentEmptyCreationResult = status === 'created' ? { status, handle } : {
   status, handle, code: 'native_evidence_stale', reason: AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_stale,
  };
  f.creationResult(outcome);
  f.beforeIdleCreate(async () => { entered = true; await gate; });
  running = f.control('prepare', request);
  await expect.poll(() => entered, { timeout: 1500 }).toBe(true);
  expect((await f.control('cancel', { operationId: 'handoff' })).payload.phase).toBe('cancelled');
  release();
  expect((await running).payload.phase).toBe('cancelled');

  const savedRoles = f.stateFiles.roles.text('state.json');
  const savedContext = f.stateFiles.contexts.text('context.json');
  const state = JSON.parse(savedRoles).roles[0];
  expect(state.role).toMatchObject({ current: ref('A'), revision: 1 });
  expect(state.operations[0].phase).toBe('cancelled');
  expect(state.operations[0].to).toBeUndefined();
  expect(state.localPreparations[0].orphanCandidate).toEqual(ref('B'));
  expect(state.localPreparations[0].nativeCreation.outcome).toEqual(outcome);
  expect(JSON.parse(savedContext).attachments).toEqual([]);
  f.sessions.set('ordinary', new Native('ordinary', f.root));

  for (const restored of [false, true]) {
   if (restored) await f.restart();
   const b = f.sessions.get('B')!;
   const runtimeInfo = b.runtimeInfo.bind(b);
   const persistence = { providerId: 'fixture', sessionId: 'B', opaque: 'ordinary runtime handle' };
   b.runtimeInfo = async () => ({ ...await runtimeInfo(), persistence });
   const openCount = f.creationOptions.length, readCount = f.workspaceReads.length;
   const attached = await f.host.control({ method: 'POST', path: '/remote/attach', sessionId: 'B',
    body: JSON.stringify({ providerId: 'fixture', nativeSessionId: 'B' }) });
   if (status === 'known_rejected') {
    expect(attached.status).toBeGreaterThanOrEqual(400);
    expect(f.workspaceReads.slice(readCount)).not.toContain('B');
    expect(f.creationOptions.slice(openCount)).toEqual([]);
   } else {
    expect(attached.status).toBe(200);
    expect(JSON.parse(attached.body)).toMatchObject({ nativeSessionId: 'B' });
    expect(f.creationOptions.slice(openCount)).toEqual([outcome]);
    expect((await b.runtimeInfo() as { persistence?: unknown }).persistence).toEqual(persistence);
   }
   const ordinaryOpenCount = f.creationOptions.length;
   expect((await f.attach('ordinary')).nativeSessionId).toBe('ordinary');
   expect(f.creationOptions.slice(ordinaryOpenCount)).toEqual([undefined]);
   expect(f.stateFiles.roles.text('state.json')).toBe(savedRoles);
   expect(f.stateFiles.contexts.text('context.json')).toBe(savedContext);
   expect([...f.sessions.values()].flatMap(session => session.sent)).toEqual([]);
   expect(f.evidenceCreates()).toBe(1);
   expect(f.creates()).toBe(0);
  }
 } finally { release(); await running?.catch(() => undefined); await f.close(); }
});
test('Host reopens the saved creation handle after restart without replaying creation',async()=>{
 const f=await fixture(false,false,undefined,false,true);
 try{
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  const original=f.creationOptions.find(Boolean);await f.restart();
  expect((await f.attach('B')).agentId).toBeTruthy();
  expect(f.creationOptions.at(-1)).toEqual(original);expect(f.evidenceCreates()).toBe(1);expect(f.creates()).toBe(0);
 }finally{await f.close();}
});
test('Host refuses an unavailable evidence channel instead of dispatching through ordinary input',async()=>{
 const f=await fixture(false,false,undefined,false,true);
 try{
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  expect((await f.control('commit',{operationId:'handoff',expectedRevision:1})).payload.phase).toBe('committed');
  const b=f.sessions.get('B') as EvidenceNative;
  b.nativeEvidence.availability=()=>({status:'unavailable',code:'native_evidence_unavailable',reason:AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_unavailable});
  const attached=await f.attach('B');
  expect((await sendOverWebSocket(f,attached.agentId,'continue','00000000-0000-4000-8000-000000000902')).type).toBe('protocol_error');
  expect(b.sent).toEqual([]);expect(b.preparations).toBe(0);
 }finally{await f.close();}
});
test('Host retains the source token across candidate reads and refuses stale facts at final commit',async()=>{
 const f=await fixture(false,false,undefined,false,true);
 try{
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  const a=f.sessions.get('A') as EvidenceNative, b=f.sessions.get('B') as EvidenceNative;
  f.beforeNativeInspect(async id=>{if(id==='B')a.epoch++;});
  expect((await f.control('commit',{operationId:'handoff',expectedRevision:1})).status).toBe(409);
  expect(a.captures).toBeGreaterThan(0);expect(b.captures).toBeGreaterThan(0);
  expect(f.stateFiles.roles.json('state.json').roles[0].role.current).toEqual(ref('A'));
 }finally{await f.close();}
});
test('Host rejects a replaced projection with the same native B even when tokens claim current',async()=>{
 const f=await fixture(false,false,undefined,false,true);let proceed!:()=>void;
 try{
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  const old=await f.attach('B'),b=f.sessions.get('B') as EvidenceNative; b.nativeEvidence.isCurrent=()=>true;
  let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{proceed=resolve;});
  f.beforeNativeInspect(async id=>{if(id==='B'){enter();await gate;}});
  const committing=f.control('commit',{operationId:'handoff',expectedRevision:1});
  await entered;await f.host.relay.closeAgent(old.agentId);expect((await f.attach('B')).agentId).toBe(old.agentId);
  proceed();expect((await committing).status).toBe(409);
 }finally{proceed?.();await f.close();}
});
test.each(['commit', 'partial-acquisition'] as const)('Host releases actual native leases after %s',async phase=>{
 const f=await fixture(false,false,undefined,false,true);let proceed:()=>void=()=>{};let spy:ReturnType<typeof vi.spyOn>|undefined;
 try{
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  const a=f.sessions.get('A') as EvidenceNative,b=f.sessions.get('B') as EvidenceNative;
  if(phase==='partial-acquisition') {
   b.beforeCapture=()=>{throw new Error('candidate evidence capture failed');};
   expect((await f.control('commit',{operationId:'handoff',expectedRevision:1})).status).toBe(409);
   f.allowIdleRelease();
  } else {
   let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{proceed=resolve;});
   const original=SessionSuccessionStore.prototype.commit;
   spy=vi.spyOn(SessionSuccessionStore.prototype,'commit').mockImplementation(async function(...args){enter();await gate;return original.apply(this,args);});
   const committing=f.control('commit',{operationId:'handoff',expectedRevision:1});
   await entered;f.allowIdleRelease();await new Promise(resolve=>setTimeout(resolve,75));
   expect(a.disposals).toBe(0);expect(b.disposals).toBe(0);
   proceed();expect((await committing).payload.phase).toBe('committed');
  }
  await expect.poll(()=>a.disposals,{timeout:1000}).toBe(1);await expect.poll(()=>b.disposals,{timeout:1000}).toBe(1);
 }finally{proceed();spy?.mockRestore();await f.close();}
});
test('Host independent evidence readback rechecks the protected attachment workspace',async()=>{
 const f=await fixture(false,false,undefined,false,true,true);
 try{
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  expect((await f.control('commit',{operationId:'handoff',expectedRevision:1})).payload.phase).toBe('committed');
  const attached=await f.attach('B'),b=f.sessions.get('B') as EvidenceNative;
  await sendOverWebSocket(f,attached.agentId,'continue','00000000-0000-4000-8000-000000000903');
  const before=f.stateFiles.contexts.text('context.json');
  b.runtimeInfo=async()=>({providerId:'fixture',sessionId:'B',status:'idle',cwd:'/'});
  expect((await f.control('reconcile',{operationId:'handoff'})).status).not.toBe(200);
  expect(b.inspections).toBe(0);expect(b.dispatches).toBe(1);
  expect(f.stateFiles.contexts.text('context.json')).toBe(before);
 }finally{await f.close();}
});
test('real Host prepares and commits without execution then dispatches its first WebSocket input',async()=>{
 const f=await fixture();try{
 const prepared=await f.control('prepare',request);expect(prepared).toMatchObject({status:200,payload:{phase:'ready',to:ref('B')}});
 expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
 expect(await f.control('commit',{operationId:'handoff',expectedRevision:1})).toMatchObject({status:200,payload:{phase:'committed'}});
 const attached=await f.attach('B');
 const ack=await sendOverWebSocket(f,attached.agentId,'continue','00000000-0000-4000-8000-000000000001');expect(ack).toMatchObject({type:'command_acknowledged',payload:{inputAcceptance:{disposition:'queued'}}});
 expect(f.sessions.get('B')!.sent[0]).toContain('quoted conversation history');expect(f.sessions.get('B')!.sent[0]).toContain('continue');expect(f.sessions.get('B')!.sent[0]).toContain('Original requirement');
 expect(await f.control('reconcile',{operationId:'handoff'})).toMatchObject({status:200,payload:{materialized:false}});
 }finally{await f.close();}
});
test('unsupported pair and a busy source fail before idle candidate creation',async()=>{
 const f=await fixture();try{f.unsupported();expect((await f.control('prepare',request)).payload.phase).toBe('rejected');expect(f.creates()).toBe(0);}finally{await f.close();}
 const g=await fixture();try{g.busy('A');expect((await g.control('prepare',request)).payload.phase).toBe('rejected');expect(g.creates()).toBe(0);}finally{await g.close();}
});
test('a busy candidate prevents readiness and later source work prevents commit',async()=>{
 const f=await fixture();try{f.busy('B');expect((await f.control('prepare',request)).payload.phase).toBe('rejected');expect(f.creates()).toBe(1);expect(f.sessions.get('B')!.sent).toEqual([]);}finally{await f.close();}
 const g=await fixture();try{expect((await g.control('prepare',request)).payload.phase).toBe('ready');g.busy('A');expect((await g.control('commit',{operationId:'handoff',expectedRevision:1})).status).toBe(409);}finally{await g.close();}
});

test('real Host TPM first postcommit main input consumes durable context once and preserves its own session',async()=>{
  const f=await fixture(true);
  try {
    const created=await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'create-tpm',requirement:'Track the original requirement'})});
    expect(created.status).toBe(200);
    const work=JSON.parse(created.body) as TpmWork;
    const current=async()=>JSON.parse((await f.host.control({method:'GET',path:`/remote/tpm/work?id=${work.id}`})).body) as TpmWork;
    await expect.poll(async()=>(await current()).outbox?.[0]?.status).toBe('accepted');
    const tpmId=work.tpmNativeSessionId!; const tools=f.tpmConfigurations[0]!.tools!;
    const call=async(name:string,input:unknown)=>JSON.parse(await tools.find(tool=>tool.name===name)!.execute(input));
    const todo=(await current()).todo!;
    await call('update_todo_step',{revision:todo.revision,stepId:todo.steps[0]!.id,status:'in_progress',note:'Clarifying the approved work'});
    expect(await f.control('prepare',request)).toMatchObject({status:200,payload:{phase:'ready',to:ref('B')}});
        const context=async()=>f.stateFiles.contexts.json('context.json').attachments[0];
    const captured=await context();
    expect(captured).toMatchObject({state:'pending',target:ref('B'),roleRevision:2,deliveries:[]});
    expect(captured.text).toContain('Original requirement');
    expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
    expect(await f.control('commit',{operationId:'handoff',expectedRevision:1})).toMatchObject({status:200,payload:{phase:'committed'}});
    expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
    const input={operationId:'postcommit-consultation',todoStepId:todo.steps[0]!.id,purpose:'consultation',text:'Assess the next concrete step'};
    const intent=await call('send_main_message',input);
    await expect.poll(async()=>(await current()).outbox?.find(item=>item.id===intent.id)?.status).not.toMatch(/^(prepared|dispatching)$/);
    const observed=await current(); const settled=observed.outbox!.find(item=>item.id===intent.id)!;
    expect(settled.status,JSON.stringify({error:settled.error,health:observed.health})).toBe('accepted');
    const sent=f.sessions.get('B')!.sent;
    expect(sent).toHaveLength(1);expect(sent[0]).toContain('quoted conversation history');
    expect(sent[0]).toContain(captured.text);expect(sent[0]).toContain(input.text);
    const persisted=f.stateFiles.tpm.json(`${work.id}.json`);
    expect(persisted.work.tpmNativeSessionId).toBe(tpmId);
    expect(persisted.work.outbox.find((item:{id:string})=>item.id===intent.id)).toMatchObject({status:'accepted',resolvedTarget:ref('B'),roleRevision:2});
    const executionHash=createHash('sha256').update(JSON.stringify(['host:tpm',intent.id])).digest('hex');
    const executionId=`${executionHash.slice(0,8)}-${executionHash.slice(8,12)}-8${executionHash.slice(13,16)}-${((parseInt(executionHash[16]!,16)&3)|8).toString(16)}${executionHash.slice(17,20)}-${executionHash.slice(20,32)}`;
    expect(await context()).toMatchObject({state:'accepted',deliveries:[{operationId:createHash('sha256').update(JSON.stringify(['host:tpm',executionId])).digest('hex'),target:ref('B'),roleRevision:2,includesContext:true}]});
    expect(await call('send_main_message',input)).toMatchObject({id:intent.id,status:'accepted'});
    expect(f.sessions.get('B')!.sent).toHaveLength(1);expect(f.sessions.get('A')!.sent).toEqual([]);
    expect(f.tpmConfigurations).toHaveLength(1);expect((await current()).tpmNativeSessionId).toBe(tpmId);
  } finally { await f.close(); }
});

test('a revision-rejected TPM recovery cannot leave an unresolved association admission',async()=>{
  const f=await fixture(true,true,async (root,files)=>{const store=new SessionSuccessionStore(join(root,'roles'),files.roles);await store.ready;await store.ensureRole(ref('A'),root);});
  try {
    f.loseTpmCreation(true);
    expect((await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'stale-recovery-create'})})).status).toBe(409);
    const path=(await f.stateFiles.tpm.list()).find(path=>path.endsWith('.json'))!;
    const {work}=f.stateFiles.tpm.json(path);
    const stale=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:work.id,revision:work.revision-1,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'stale-recovery'})});
    expect(stale.status).toBe(409);expect(JSON.parse(stale.body).error).toMatch(/work changed/);
    const state=f.stateFiles.roles.json('state.json');
    expect(state.associationAdmissions).toHaveLength(1);
    const recovered=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:work.id,revision:work.revision,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'correct-recovery'})});
    expect(recovered.status,recovered.body).toBe(200);
    expect(f.stateFiles.roles.json('state.json').associationAdmissions).toEqual([]);
  }finally{await f.close();}
});


test('a TPM recovery failure after native access retains its unresolved admission',async()=>{
  const f=await fixture(true,true,async (root,files)=>{const store=new SessionSuccessionStore(join(root,'roles'),files.roles);await store.ready;await store.ensureRole(ref('A'),root);});
  try {
    f.loseTpmCreation(true);
    expect((await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'unknown-recovery-create'})})).status).toBe(409);
    const path=(await f.stateFiles.tpm.list()).find(path=>path.endsWith('.json'))!;
    const {work}=f.stateFiles.tpm.json(path);
    let inspections=0;f.sessions.get('tpm-1')!.runtimeInfo=async()=>{inspections++;throw new Error('Native recovery outcome is unavailable.');};
    const body=JSON.stringify({id:work.id,revision:work.revision,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'unknown-recovery'});
    expect((await f.host.control({method:'POST',path:'/remote/tpm/action',body})).status).toBe(409);
    expect(f.stateFiles.roles.json('state.json').associationAdmissions).toHaveLength(2);
    const repeated=await f.host.control({method:'POST',path:'/remote/tpm/action',body});
    expect(repeated.status).toBe(409);expect(JSON.parse(repeated.body).error).toMatch(/unresolved/);expect(inspections).toBe(1);
  }finally{await f.close();}
});

test('real WebSocket validation admission blocks first handoff and is released after rejection', async () => {
  const f = await fixture(); let finish!: () => void; let entered!: () => void;
  const validation = new Promise<void>(resolve => { finish = resolve; }); const waiting = new Promise<void>(resolve => { entered = resolve; });
  try {
    const attached = await f.attach('A'); const agent = f.host.relay.requireAgent(attached.agentId);
    agent.validateMessageContent = async () => { entered(); await validation; throw new Error('Invalid image preparation'); };
    const send = sendOverWebSocket(f, attached.agentId, 'blocked validation', '00000000-0000-4000-8000-000000000091', 'owner', true);
    await waiting;
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
    finish(); expect((await send).type).toBe('protocol_error');
    expect(f.sessions.get('A')!.sent).toEqual([]);
    expect((await f.control('prepare', { ...request, operationId: 'after-validation' })).payload.phase).toBe('ready');
  } finally { finish(); await f.close(); }
}, 10000);

test('retained queued input blocks first enablement for an existing role', async () => {
  const f = await fixture();
  try {
    const attached = await f.attach('A');
    expect((await sendOverWebSocket(f, attached.agentId, 'queued first', '00000000-0000-4000-8000-000000000092')).type).toBe('command_acknowledged');
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
  } finally { await f.close(); }
}, 10000);



test('source reservation precedes store begin and exact retries join while unrelated WebSocket writes remain available', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  const original = SessionSuccessionStore.prototype.begin;
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'begin').mockImplementation(async function (input, local) {
    if (input.operationId === 'begin-reservation') { entered.resolve(); await gate.promise; }
    return original.call(this, input, local);
  });
  try {
    const a = await f.attach('A'); f.sessions.set('C', new Native('C', f.root)); const c = await f.attach('C');
    const input = { ...request, operationId: 'begin-reservation' };
    const preparing = f.control('prepare', input); await entered.promise;
    const retry = f.control('prepare', input);
    expect((await sendOverWebSocket(f, a.agentId, 'forbidden', '00000000-0000-4000-8000-000000000093')).type).toBe('protocol_error');
    expect((await sendOverWebSocket(f, c.agentId, 'unrelated', '00000000-0000-4000-8000-000000000094')).type).toBe('command_acknowledged');
    expect((await f.control('prepare', { ...input, operationId: 'different-attempt' })).status).toBe(409);
    expect(f.creates()).toBe(0); expect(f.sessions.get('A')!.sent).toEqual([]);
    gate.resolve(); expect((await preparing).payload.phase).toBe('ready'); expect((await retry).payload.phase).toBe('ready'); expect(f.creates()).toBe(1);
    expect((await f.control('cancel', { operationId: input.operationId })).payload.phase).toBe('cancelled');
    expect((await sendOverWebSocket(f, a.agentId, 'after cancel', '00000000-0000-4000-8000-000000000095')).type).toBe('command_acknowledged');
  } finally { gate.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('known candidate is fenced before save and cancellation cannot resurrect its reservation', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  const original = SessionSuccessionStore.prototype.saveCandidate;
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'saveCandidate').mockImplementation(async function (operationId, target) {
    entered.resolve(); await gate.promise; return original.call(this, operationId, target);
  });
  try {
    const a = await f.attach('A'); const preparing = f.control('prepare', request); await entered.promise; const b = await f.attach('B');
    for (const [agentId, id] of [[a.agentId, '96'], [b.agentId, '97']]) {
      expect((await sendOverWebSocket(f, agentId, 'forbidden before save', `00000000-0000-4000-8000-0000000000${id}`)).type).toBe('protocol_error');
    }
    const cancelling = f.control('cancel', { operationId: request.operationId }); gate.resolve();
    expect((await cancelling).payload.phase).toBe('cancelled'); await preparing;
    expect(f.sessions.get('A')!.sent).toEqual([]); expect(f.sessions.get('B')!.sent).toEqual([]);
    expect((await sendOverWebSocket(f, a.agentId, 'after cancellation', '00000000-0000-4000-8000-000000000098')).type).toBe('command_acknowledged');
    expect((await sendOverWebSocket(f, b.agentId, 'orphan', '00000000-0000-4000-8000-000000000099')).type).toBe('command_acknowledged');
    expect(f.creates()).toBe(1);
  } finally { gate.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('source and candidate remain excluded during commit publication and only committed B opens', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  const original = SessionSuccessionStore.prototype.commit;
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'commit').mockImplementation(async function (operationId, generation) {
    entered.resolve(); await gate.promise; return original.call(this, operationId, generation);
  });
  try {
    expect((await f.control('prepare', request)).payload.phase).toBe('ready');
    const a = await f.attach('A'), b = await f.attach('B'); const committing = f.control('commit', { operationId: 'handoff', expectedRevision: 1 }); await entered.promise;
    for (const [agentId, id] of [[a.agentId, '101'], [b.agentId, '102']]) expect((await sendOverWebSocket(f, agentId, 'forbidden', `00000000-0000-4000-8000-000000000${id}`)).type).toBe('protocol_error');
    gate.resolve(); expect((await committing).payload.phase).toBe('committed');
    expect((await sendOverWebSocket(f, a.agentId, 'superseded', '00000000-0000-4000-8000-000000000103')).type).toBe('protocol_error');
    expect((await sendOverWebSocket(f, b.agentId, 'continue', '00000000-0000-4000-8000-000000000104')).type).toBe('command_acknowledged');
  } finally { gate.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('native call lifetime blocks handoff while known completion survives a later local receipt failure', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  try {
    const a = await f.attach('A'); const native = f.sessions.get('A')!;
    native.sendMessage = async text => { native.sent.push(text); entered.resolve(); await gate.promise; return { disposition: 'started' }; };
    const agent = f.host.relay.requireAgent(a.agentId), original = agent.sendMessage.bind(agent);
    agent.sendMessage = async (...args) => { await original(...args); throw new Error('Local receipt readback failed'); };
    const sending = sendOverWebSocket(f, a.agentId, 'complete native once', '00000000-0000-4000-8000-000000000105'); await entered.promise;
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
    gate.resolve(); expect(await sending).toMatchObject({ type: 'protocol_error', payload: { code: 'operation_outcome_unknown' } });
    expect((await f.control('prepare', { ...request, operationId: 'known-completed' })).payload.phase).toBe('ready');
    expect(native.sent).toHaveLength(1);
  } finally { gate.resolve(); await f.close(); }
}, 10000);

test('conflicting candidate admission persists its identity, rejects preparation and never repeats create', async () => {
  const f = await fixture(); const creating = deferredBoundary(), createEntered = deferredBoundary(), validating = deferredBoundary(), validateEntered = deferredBoundary();
  f.beforeIdleCreate(async () => { createEntered.resolve(); await creating.promise; });
  try {
    const preparing = f.control('prepare', request); await createEntered.promise;
    f.sessions.set('B', new Native('B', f.root)); const b = await f.attach('B');
    const agent = f.host.relay.requireAgent(b.agentId);
    agent.validateMessageContent = async () => { validateEntered.resolve(); await validating.promise; throw new Error('Invalid content'); };
    const sending = sendOverWebSocket(f, b.agentId, 'already admitted', '00000000-0000-4000-8000-000000000106', 'owner', true); await validateEntered.promise;
    creating.resolve(); expect(await preparing).toMatchObject({ status: 200, payload: { phase: 'rejected', to: ref('B'), failureCode: 'succession_candidate_busy' } });
    expect((await f.control('prepare', request)).payload.to).toEqual(ref('B')); expect(f.creates()).toBe(1);
    validating.resolve(); expect((await sending).type).toBe('protocol_error');
  } finally { creating.resolve(); validating.resolve(); await f.close(); }
}, 10000);

test('uncertain store begin publication retains the synchronous source fence', async () => {
  const f = await fixture();
  const { SuccessionPublicationUnknown } = await import('./succession-persistence.js');
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'begin').mockImplementation(async () => { throw new SuccessionPublicationUnknown('Uncertain storage'); });
  try {
    const a = await f.attach('A'); expect((await f.control('prepare', request)).status).toBe(409);
    expect((await sendOverWebSocket(f, a.agentId, 'fenced unknown begin', '00000000-0000-4000-8000-000000000107')).type).toBe('protocol_error');
    expect(f.creates()).toBe(0); expect(f.sessions.get('A')!.sent).toEqual([]);
  } finally { spy.mockRestore(); await f.close(); }
}, 10000);


test('restored durable role with fresh empty cache still requires native queue and work coverage', async () => {
  const f = await fixture();
  try {
    f.unavailableCoverage(); await f.restart();
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
    const a = await f.attach('A');
    expect((await sendOverWebSocket(f, a.agentId, 'ordinary remains available', '00000000-0000-4000-8000-000000000108')).type).toBe('command_acknowledged');
  } finally { await f.close(); }
}, 10000);

test('bulk stop rejects all captured targets before any cancellation when one source is reserved', async () => {
  const f = await fixture();
  try {
    f.sessions.get('A')!.capabilities.cancel = true; await f.attach('A');
    const c = new Native('C', f.root); c.capabilities.cancel = true; f.sessions.set('C', c); await f.attach('C');
    expect((await f.control('prepare', request)).payload.phase).toBe('ready');
    const stopped = await f.host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: '00000000-0000-4000-8000-000000000110' }) });
    expect(stopped.status).not.toBe(200); expect(c.cancels).toBe(0); expect(f.sessions.get('A')!.cancels).toBe(0);
    expect((await f.control('cancel', { operationId: 'handoff' })).payload.phase).toBe('cancelled');
    const after = await f.host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: '00000000-0000-4000-8000-000000000111' }) });
    expect(after.status).toBe(200); expect(c.cancels).toBe(1); expect(f.sessions.get('A')!.cancels).toBe(1);
  } finally { await f.close(); }
}, 10000);

async function acceptanceTpmWork(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.host.control({ method: 'POST', path: '/remote/tpm/create', body: JSON.stringify({
    providerId: 'fixture', mainNativeSessionId: 'A', operationId: 'acceptance-tpm', requirement: 'Track one consultation',
  }) });
  expect(created.status).toBe(200); const work = JSON.parse(created.body) as TpmWork;
  const current = async () => JSON.parse((await f.host.control({ method: 'GET', path: `/remote/tpm/work?id=${work.id}` })).body) as TpmWork;
  await expect.poll(async () => (await current()).outbox?.[0]?.status).toBe('accepted');
  const tools = f.tpmConfigurations[0]!.tools!;
  const call = async (name: string, input: unknown) => JSON.parse(await tools.find(tool => tool.name === name)!.execute(input));
  const todo = (await current()).todo!;
  await call('update_todo_step', { revision: todo.revision, stepId: todo.steps[0]!.id, status: 'in_progress', note: 'Discussing the requirement' });
  const input = { operationId: 'consult-once', todoStepId: todo.steps[0]!.id, purpose: 'consultation', text: 'Assess this work once' };
  return { work, current, call, input };
}

test.each([false, true])('real Host TPM ordinary late acceptance releases the original handoff gate, lost response %s', async lost => {
  const f = await fixture(true);
  try {
    const tpm = await acceptanceTpmWork(f), a = f.sessions.get('A')!; let notify: AgentMessageOptions['onAcceptance'];
    a.sendMessage = async (text: string, options?: AgentMessageOptions) => {
      a.sent.push(text); notify = options?.onAcceptance;
      if (lost) throw new Error('Ordinary native response lost');
    };
    const receipt = await tpm.call('send_main_message', tpm.input);
    await expect.poll(async () => (await tpm.current()).outbox!.find(item => item.id === receipt.id)?.status).toBe(lost ? 'unknown' : 'accepted');
    expect((await f.control('prepare', { ...request, operationId: 'blocked' })).payload.phase).toBe('rejected');
    expect(f.creates()).toBe(0);
    notify!({ disposition: 'queued' });
    await expect.poll(async () => (await tpm.current()).outbox!.find(item => item.id === receipt.id)?.acceptance).toBe('queued');
    expect((await f.control('prepare', { ...request, operationId: 'still-queued' })).payload.phase).toBe('rejected');
    expect(f.creates()).toBe(0);
    notify!({ disposition: 'started' });
    await expect.poll(async () => (await tpm.current()).outbox!.find(item => item.id === receipt.id)?.acceptance).toBe('started');
    const persisted = f.stateFiles.tpm.json(`${tpm.work.id}.json`);
    expect(persisted.work.outbox.find((item: { id: string }) => item.id === receipt.id)).toMatchObject({ status: 'accepted', acceptance: 'started', resolvedTarget: ref('A'), roleRevision: 1 });
    expect((await f.control('prepare', request)).payload.phase).toBe('ready');
    expect(f.creates()).toBe(1); expect(a.sent).toHaveLength(1);
    expect(await tpm.call('send_main_message', tpm.input)).toMatchObject({ id: receipt.id, acceptance: 'started' });
    expect(a.sent).toHaveLength(1);
  } finally { await f.close(); }
}, 10000);

test.each([false, true])('real Host TPM prepared late execution evidence releases the next handoff gate, lost response %s', async lost => {
  const f = await fixture(true, false, undefined, false, true, true);
  try {
    const tpm = await acceptanceTpmWork(f);
    expect((await f.control('prepare', request)).payload.phase).toBe('ready');
    expect((await f.control('commit', { operationId: 'handoff', expectedRevision: 1 })).payload.phase).toBe('committed');
    const b = f.sessions.get('B') as EvidenceNative; b.dispatchFailure = lost;
    const receipt = await tpm.call('send_main_message', tpm.input);
    await expect.poll(async () => (await tpm.current()).outbox!.find(item => item.id === receipt.id)?.status).toBe(lost ? 'unknown' : 'accepted');
    expect(b.dispatches).toBe(1); expect(b.preparations).toBe(1); expect(b.sent[0]).toContain('Original requirement');
    const next = { ...request, from: ref('B'), expectedRevision: 2 };
    expect((await f.control('prepare', { ...next, operationId: 'unresolved-next' })).payload.phase).toBe('rejected');
    b.materialized = true; b.unresolved = false; let started = false;
    const inspect = b.nativeEvidence.inspectInput;
    b.nativeEvidence.inspectInput = async witness => {
      const result = await inspect(witness);
      return started && result.status === 'materialized' ? { ...result, execution: { disposition: 'started', nativeExecutionId: 'exact-R' } } : result;
    };
    expect((await f.control('reconcile', { operationId: 'handoff' })).payload.materialized).toBe(true);
    expect((await tpm.current()).outbox!.find(item => item.id === receipt.id)?.acceptance).toBeUndefined();
    expect((await f.control('prepare', { ...next, operationId: 'materialized-without-execution' })).payload.phase).toBe('rejected');
    expect(f.evidenceCreates()).toBe(1);
    started = true;
    expect((await f.control('reconcile', { operationId: 'handoff' })).payload.materialized).toBe(true);
    await expect.poll(async () => (await tpm.current()).outbox!.find(item => item.id === receipt.id)?.acceptance).toBe('started');
    const persisted = f.stateFiles.tpm.json(`${tpm.work.id}.json`);
    expect(persisted.work.outbox.find((item: { id: string }) => item.id === receipt.id)).toMatchObject({ status: 'accepted', acceptance: 'started', resolvedTarget: ref('B'), roleRevision: 2 });
    let nextCreates = 0;
    f.providerEvidence!.createEmpty = async config => {
      expect(config).toMatchObject({ cwd: f.root, selectionSourceSessionId: 'B' }); nextCreates++;
      f.sessions.set('C', new EvidenceNative('C', f.root));
      return { status: 'created', handle: { providerId: 'fixture', sessionId: 'C', opaque: 'exact C handle' } };
    };
    expect((await f.control('prepare', { ...next, operationId: 'next' })).payload.phase).toBe('ready');
    expect(nextCreates).toBe(1); expect(b.dispatches).toBe(1); expect(b.preparations).toBe(1);
    expect(await tpm.call('send_main_message', tpm.input)).toMatchObject({ id: receipt.id, acceptance: 'started' });
    expect(b.sent).toHaveLength(1); expect(f.sessions.get('C')!.sent).toEqual([]);
  } finally { await f.close(); }
}, 10000);


test('Host grants empty initialization only before input and withdraws it on cold unknown restore', async () => {
 const f=await fixture(false,false,undefined,false,true,true);
 try {
  expect((await f.control('prepare',request)).payload.phase).toBe('ready');
  expect(f.resumeOptions).toContainEqual({initializeEmpty:true});
  expect((await f.control('commit',{operationId:'handoff',expectedRevision:1})).payload.phase).toBe('committed');
  await f.restart(); await f.attach('B');
  expect(f.resumeOptions.at(-1)).toEqual({initializeEmpty:true});
  const b=f.sessions.get('B') as EvidenceNative;b.dispatchFailure=true;
  const attached=await f.attach('B');
  expect((await sendOverWebSocket(f,attached.agentId,'uncertain','00000000-0000-4000-8000-000000000945')).type).toBe('protocol_error');
  await f.restart(); await f.attach('B');
  expect(f.resumeOptions.at(-1)).toEqual({initializeEmpty:false});
  expect(f.evidenceCreates()).toBe(1);
 } finally {await f.close();}
},10000);

test('native prefix Host uses settled prompt evidence and exact committed handle through restart and normal first WebSocket input',async()=>{
 const f=await fixture(false,false,undefined,false,false,true,true);
 try {
  expect((await f.control('prepare',nativePrefixRequest)).payload.phase).toBe('ready');
  expect(f.prefixForks()).toBe(1); expect(f.prefixVerifications()).toBe(1);
  expect(f.prefixHandles).toContainEqual({providerId:'fixture',sessionId:'B',opaque:'original prefix handle'});
  expect(f.creationOptions.every(value=>value===undefined)).toBe(true);expect(f.resumeOptions.every(value=>value===undefined)).toBe(true);
  expect((f.sessions.get('B') as PromptNative).captures).toBeGreaterThan(0);
  expect((await f.control('commit',{operationId:'handoff',expectedRevision:1})).payload.phase).toBe('committed');
  await f.restart();
  expect(f.prefixForks()).toBe(1); expect((await f.control('reconcile',{operationId:'handoff'})).payload.materialized).toBe(true);
  const attached=await f.attach('B');
  expect((await sendOverWebSocket(f,attached.agentId,'edited prompt','00000000-0000-4000-8000-000000008822')).type).toBe('command_acknowledged');
  expect(f.sessions.get('B')!.sent).toEqual(['edited prompt']); expect(f.sessions.get('A')!.sent).toEqual([]);
 }finally{await f.close();}
});
test.each(['A','B'])('native prefix Host retains %s evidence across native branch readback',async id=>{
 const f=await fixture(false,false,undefined,false,false,false,true);
 try{
  f.onPrefixVerify(async()=>{(f.sessions.get(id) as PromptNative).epoch++;});
  expect((await f.control('prepare',nativePrefixRequest)).payload.phase).toBe('rejected');
  expect(f.prefixForks()).toBe(1);expect(f.prefixVerifications()).toBe(1);
  expect((f.sessions.get(id) as PromptNative).captures).toBe(1);
 }finally{await f.close();}
});

test('native prefix Host restart keeps the saved source observation and rejects a replaced timeline epoch',async()=>{
 const f=await fixture(false,false,undefined,false,false,false,true);
 try{
  expect((await f.control('prepare',nativePrefixRequest)).payload.phase).toBe('ready');
  const original=f.stateFiles.roles.json('state.json').roles[0].localPreparations[0].capture;
  await f.restart();
  expect((await f.control('reconcile',{operationId:'handoff'})).payload).toMatchObject({phase:'rejected',failureCode:'succession_boundary_changed',to:ref('B')});
  const saved=f.stateFiles.roles.json('state.json');
  expect(saved.roles[0].localPreparations[0].capture).toEqual(original);expect(saved.roles[0].role.current).toEqual(ref('A'));
  expect(f.prefixForks()).toBe(1);expect(f.prefixHandles.filter(Boolean)).toHaveLength(2);
 }finally{await f.close();}
});

