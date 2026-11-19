/** S2, The Controller's succession service against the Relay's relation edits and cold grants: what a freeze fences, and what a restart recovers. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { successionHostFixture as fixture, SessionSuccessionStore, SessionSuccessionCoordinator, SessionSuccessionBoundary, Native, ref, deferredBoundary } from '@orchardworks/agent-remote-controller/succession-host-testing';
import { enrollmentTransport, coldAssociations } from './support/succession-relay.js';
test('cold complete grants enroll only linked direct readers and preserve immutable provenance',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
    const input={operationId:'cold',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    const state=f.stateFiles.roles.json('state.json');
    expect(state.roles[0].participants.map((item:{before:{nativeSessionId:string}})=>item.before.nativeSessionId).sort()).toEqual(['ask','side']);
    const before=transport.saved().bindings;
    const update={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0};
    await expect(transport.broker.updateSessionRelation('owner',update)).rejects.toThrow(/reserved/);
    expect((await transport.action('commit',{operationId:'cold'}))!.status).toBe(200);
    await expect(transport.broker.updateSessionRelation('owner',update)).rejects.toThrow(/operation identity/);
    expect(transport.saved().bindings).toEqual(before);
    expect(f.sessions.size).toBe(2);
  }finally{await transport.close();await f.close();}
});

test('cancelling the first reservation restores ordinary relationship updates',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f,coldAssociations());
  try {
    const input={operationId:'cancel-first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(409);
    expect((await transport.action('cancel',{operationId:input.operationId}))!.status).toBe(200);
    await transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0});
    expect(transport.saved().bindings.find(item=>item.nativeSessionId==='side')!.sourceRelation!.linked).toBe(false);
  }finally{await transport.close();await f.close();}
});


test('lost source creation response recovers its original durable result without native replay',async()=>{
  const f=await fixture(false,true,undefined,false,false,false,false);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial,{rpcTimeoutMs:200});// the dropped response is answered by the RPC timeout

  try {
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000002',sourceNativeSessionId:'A',conversationKind:'side'};
    f.beforeSourceCreate(async () => {
      expect(transport.saved().associations!.admissions).toHaveLength(1);
      const hostState = f.stateFiles!.roles.json('state.json');
      expect(hostState.associationAdmissions[0]).toMatchObject({ source: ref('A'), sourceReader: true,
        sourceWitness: { version: 1, operationId: input.operationId, scope: JSON.stringify([transport.authority.origin.replace('http:', 'ws:'), transport.hostId, 'controller']) } });
      expect(hostState.associationResults).toEqual([]);
    });
    transport.dropCreationResponse();
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(504);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    const hostCompleted = f.stateFiles!.roles.json('state.json');
    expect(hostCompleted.associationAdmissions).toEqual([]); expect(hostCompleted.associationResults[0]).toMatchObject({ source: ref('A'), reader: ref('source-1'), operationId: input.operationId });
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'blocked-reader',expectedRevision:1}))!.status).toBe(409);
    await transport.restart(f.restart);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{...input,model:'changed'}))!.status).toBe(409);
    const grant=f.grants.pop()!;
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(409);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    f.grants.push(grant);
    const recovered=await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{conversationKind:'side',sourceNativeSessionId:'A',operationId:'00000000-0000-4000-8000-000000000002',providerId:'fixture'});
    expect(recovered!.status,JSON.stringify(await recovered!.clone().json())).toBe(200);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toEqual([]);
    expect(transport.saved().bindings.find(item=>item.nativeSessionId==='source-1')!.sourceRelation).toMatchObject({id:'00000000-0000-4000-8000-000000000002',sourceNativeSessionId:'A',kind:'side'});
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'known-reader',expectedRevision:1}))!.status).toBe(200);
  }finally{await transport.close();await f.close();}
});


test('broker binding persistence failure recovers from the Host result after broker restart',async()=>{
  const f=await fixture(false,true);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial);
  try {
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000003',sourceNativeSessionId:'A',conversationKind:'side'};
    transport.failBinding(true);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(503);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    transport.failBinding(false);await transport.restart();
    const recovered=await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input);
    expect(recovered!.status,JSON.stringify(await recovered!.clone().json())).toBe(200);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toEqual([]);
  }finally{await transport.close();await f.close();}
});

test('native source creation and succession freeze have symmetric admission fences',async()=>{
  const f=await fixture(false,true);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});const reached=new Promise<void>(resolve=>{entered=resolve;});
  try {
    f.beforeSourceCreate(async()=>{entered();await gate;});
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000004',sourceNativeSessionId:'A',conversationKind:'side'};
    const creating=transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input);await reached;
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'racing-reader',expectedRevision:1}))!.status).toBe(409);
    expect(transport.saved().associations!.freezes).toHaveLength(0);
    release();expect((await creating)!.status).toBe(200);
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'frozen-reader',expectedRevision:1}))!.status).toBe(200);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{...input,operationId:'00000000-0000-4000-8000-000000000005'}))!.status).toBe(409);
    const direct=await f.host.control({method:'POST',path:'/remote/create',sessionId:'bypass',body:JSON.stringify({providerId:'fixture',sourceNativeSessionId:'A',operationId:'00000000-0000-4000-8000-000000000006'})});
    expect(direct.status,direct.body).toBe(400);expect(JSON.parse(direct.body!).code).toBe('succession_admission_closed');expect(f.sourceCreates()).toBe(1);
  }finally{release();await transport.close();await f.close();}
});


test('an unknown native creation without a result witness stays frozen and is never recreated',async()=>{
  const f=await fixture(false,true);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial);
  try {
    f.loseSourceCreation();
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000007',sourceNativeSessionId:'A',conversationKind:'side'};
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBeGreaterThanOrEqual(400);
    await transport.restart();
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(409);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    const restored=await f.roleStore();
    const state=f.stateFiles.roles.json('state.json');
    expect(state.associationAdmissions).toHaveLength(1);expect(state.associationResults).toEqual([]);
  }finally{await transport.close();await f.close();}
});


test('trusted postcommit unlink and relink reconcile cold direct readers and keep nested Ask fixed', async () => {
  const f = await fixture(false, true); const transport = await enrollmentTransport(f, coldAssociations());
  try {
    f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
    expect((await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    expect((await transport.action('commit',{operationId:'relations'}))!.status).toBe(200);
    const original = structuredClone(f.grants);
    const input = { hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'unlink-side',expectedRoleRevision:2 };
    const result = await transport.broker.updateSessionRelation('owner', input);
    expect(result).toMatchObject({operation:{phase:'committed',reservation:{operationId:'unlink-side'}}});
    expect(await transport.broker.updateSessionRelation('owner', input)).toEqual(result);
    const state = f.stateFiles.roles.json('state.json');
    expect(state.roles[0].participants.map((row:{after:{nativeSessionId:string}})=>row.after.nativeSessionId)).toEqual(['ask']);
    expect(state.roles[0].relationChanges![0]!.phase).toBe('released');
    expect(f.grants).toEqual(original); expect(f.sessions.size).toBe(2);
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation).toMatchObject({id:'side-relation',sourceNativeSessionId:'A',linked:false,revision:1});
    await transport.broker.updateSessionRelation('owner',{...input,operationId:'relink-side',linked:true,expectedRevision:1});
    expect(f.stateFiles.roles.json('state.json').roles[0].participants.map((row:{after:{nativeSessionId:string}})=>row.after.nativeSessionId).sort()).toEqual(['ask','side']);
    expect(f.grants).toEqual(original);
  } finally { await transport.close(); await f.close(); }
});

test.each(['relation_reserve','relation_apply','relation_release'])('lost %s response keeps exact operation recoverable across both restarts', async lostAction => {
  const f = await fixture(false, true); const initial = coldAssociations(); initial.bindings = initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));
  const transport = await enrollmentTransport(f, initial);
  try {
    f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});
    await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}); await transport.action('commit',{operationId:'relations'});
    let lost = false; transport.beforeControl(async input => { if(input.action===lostAction&&!lost){lost=true;throw new Error('Response was lost after durable Host write');} });
    const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'recover-edit',expectedRoleRevision:2};
    await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow();
    expect(transport.saved().associations!.relationChanges![0]!.phase).not.toBe('committed');
    const metadataCommitted = transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.revision===1;
    expect(metadataCommitted).toBe(lostAction!=='relation_reserve');
    expect(transport.broker.sessionRelations('owner')[0]).toMatchObject({source:{nativeSessionId:'A'},navigationSource:{hostId:transport.hostId,nativeSessionId:'B'}});
    const competing=await transport.action('prepare',{operationId:'blocked',providerId:'fixture',nativeSessionId:'B',expectedRevision:2});expect(competing!.status).toBe(409);
    transport.beforeControl(async()=>{}); await transport.restart(f.restart);
    expect(await transport.broker.resetSessionRelationChange('owner',input)).toMatchObject({operation:{phase:'committed'}});
    expect(transport.saved().associations!.relationResets).toEqual([]);
    expect(transport.broker.sessionRelations('owner')[0]!.navigationSource).toBeUndefined();
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.revision).toBe(1);
    const state=f.stateFiles.roles.json('state.json');
    expect(state.roles[0].associationRevision).toBe(2);expect(state.roles[0].participants).toEqual([]);expect(state.roles[0].relationChanges![0]!.phase).toBe('released');
    expect(f.creates()).toBe(1);expect(f.sourceCreates()).toBe(0);
  } finally {await transport.close();await f.close();}
});

test('metadata persistence failure after Host reserve remains recoverable without false success', async () => {
  const f=await fixture(false,true), initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
  try {
    f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});
    await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'relations'});
    const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'failed-metadata',expectedRoleRevision:2};
    transport.beforeControl(async value=>{if(value.action==='relation_reserve')transport.failBinding(true);});
    await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow(/storage/);
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.linked).toBe(true);
    expect(f.stateFiles.roles.json('state.json').roles[0].relationChanges![0]!.phase).toBe('reserved');
    transport.failBinding(false);transport.beforeControl(async()=>{});await transport.restart(f.restart);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'failed-metadata'})).toMatchObject({operation:{phase:'committed'}});
  } finally {await transport.close();await f.close();}
});

test('missing durable grant rejects reserve and retains the exact Broker edit for later reconcile', async () => {
  const f=await fixture(false,true), initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
  try {
    const grant={nativeSessionId:'side',sourceNativeSessionId:'A'};f.grants.push(grant);
    await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'relations'});
    f.grants.splice(0);
    const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'missing-grant',expectedRoleRevision:2};
    await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow(/native grant/);
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.linked).toBe(true);
    expect(transport.saved().associations!.relationChanges![0]!.phase).toBe('reserved');
    expect(()=>transport.broker.sessionRelationChangeStatus('viewer',{hostId:transport.hostId,operationId:'missing-grant'})).toThrow();
    f.grants.push(grant);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'missing-grant'})).toMatchObject({operation:{phase:'committed'}});
  } finally {await transport.close();await f.close();}
});

test('a current-B native reader stays fixed until the next B-to-C frozen enrollment',async()=>{
  const f=await fixture(false,true),transport=await enrollmentTransport(f);
  try {
    await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
    await transport.request(`/v1/remote/hosts/${transport.hostId}/attach`,{providerId:'fixture',nativeSessionId:'B'});
    const response=await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{providerId:'fixture',sourceNativeSessionId:'B',conversationKind:'side',conversationId:'current-b-side',operationId:'00000000-0000-4000-8000-000000000021'});
    expect(response!.status).toBe(200);
    const reader=transport.saved().bindings.find(row=>row.sourceRelation?.id==='00000000-0000-4000-8000-000000000021')!;
    expect(reader.sourceRelation!.nativeSourceRef).toEqual(ref('B'));
    expect(f.stateFiles.roles.json('state.json').roles[0].participants).toEqual([]);
    expect(transport.broker.sessionRelations('owner')[0]).toMatchObject({nativeSourceRef:ref('B'),sourceBinding:{kind:'fixed',source:ref('B')},source:{nativeSessionId:'B'},hostLocator:{hostId:transport.hostId,controllerId:'controller'}});
    expect((await transport.action('prepare',{operationId:'second',providerId:'fixture',nativeSessionId:'B',expectedRevision:2}))!.status).toBe(200);
    const secondCommit = await transport.action('commit',{operationId:'second'});
    expect(await secondCommit!.json()).toMatchObject({record:{phase:'committed'},role:{revision:3}});
    expect(transport.broker.sessionRelations('owner')[0]).toMatchObject({nativeSourceRef:ref('B'),sourceBinding:{kind:'primary_role'},source:{nativeSessionId:'C'}});
    expect(f.sourceCreates()).toBe(1);expect(f.grants).toEqual([{nativeSessionId:reader.nativeSessionId,sourceNativeSessionId:'B'}]);
  }finally{await transport.close();await f.close();}
});

test('a competing edit between describe and reserve rejects before persisting a stale Host clock',async()=>{
  const f=await fixture(false,true),transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
    await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let first=true;
    transport.beforeControl(async input=>{if(input.action==='describe'&&first){first=false;enter();await gate;}});
    const side={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'slow-edit',expectedRoleRevision:2};
    const slow=transport.broker.updateSessionRelation('owner',side);void slow.catch(()=>{});await entered;
    await transport.broker.updateSessionRelation('owner',{...side,nativeSessionId:'unlinked',id:'unlinked-relation',linked:true,operationId:'fast-edit'});
    release();await expect(slow).rejects.toThrow(/changed|catalog/);
    expect(transport.saved().associations!.relationChanges.map(row=>row.reservation.operationId)).toEqual(['fast-edit']);
    expect(await transport.broker.updateSessionRelation('owner',side)).toMatchObject({operation:{phase:'committed'}});
  }finally{await transport.close();await f.close();}
});

test('concurrent exact same-ID relation describes join the saved operation before catalog drift checks',async()=>{
 const f=await fixture(false,true),initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
 try{
  f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
  let entered!:()=>void,release!:()=>void,count=0;const described=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  transport.beforeControl(async input=>{if(input.action==='describe'){count++;if(count===2)entered();await gate;}});
  const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'same-edit',expectedRoleRevision:2};
  const a=transport.broker.updateSessionRelation('owner',input),b=transport.broker.updateSessionRelation('owner',input);await described;release();
  const results=await Promise.all([a,b]);expect(results[0]).toEqual(results[1]);expect(transport.saved().associations!.relationChanges).toHaveLength(1);expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.revision).toBe(1);
 }finally{await transport.close();await f.close();}
});


test('durable exact pre-effect reset fences a delayed absent operation before reserve and after restart',async()=>{
 const f=await fixture(false,true),initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
 let release!:()=>void;
 try{
  f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
  let entered!:()=>void;const described=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let first=true,reserves=0;
  transport.beforeControl(async input=>{if(input.action==='relation_reserve')reserves++;if(input.action==='describe'&&first){first=false;entered();await gate;}});
  const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'reset-old-edit',expectedRoleRevision:2};
  const slow=transport.broker.updateSessionRelation('owner',input);void slow.catch(()=>{});await described;
  expect(()=>transport.broker.sessionRelationChangeStatus('owner',input)).toThrow(/No pending/);
  await transport.action('prepare',{operationId:'second',providerId:'fixture',nativeSessionId:'B',expectedRevision:2});await transport.action('commit',{operationId:'second'});
  const reset=await transport.broker.resetSessionRelationChange('owner',input);expect(reset).toMatchObject({reset:{phase:'pre_effect',intent:{operationId:input.operationId}}});
  await expect(transport.broker.resetSessionRelationChange('other',input)).rejects.toThrow(/owner|access/);
  await expect(transport.broker.resetSessionRelationChange('owner',{...input,linked:true})).rejects.toThrow(/identity/);
  release();await expect(slow).rejects.toThrow(/reset/);expect(reserves).toBe(0);expect(transport.saved().associations!.relationChanges).toEqual([]);
  transport.beforeControl(async()=>{});await transport.restart(f.restart);
  await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow(/reset/);
  expect(await transport.broker.resetSessionRelationChange('owner',input)).toEqual(reset);
  await transport.broker.updateSessionRelation('owner',{...input,operationId:'fresh-edit',expectedRoleRevision:3});
  expect(transport.saved().associations!.relationChanges).toHaveLength(1);
  expect(await transport.broker.resetSessionRelationChange('owner',{...input,operationId:'fresh-edit',expectedRoleRevision:3})).toMatchObject({operation:{phase:'committed'}});
 }finally{release?.();await transport.close();await f.close();}
});


test('relation persistence admission precedes async store publication and blocks a reader handoff', async () => {
  const f = await fixture(false, true, async (root, files) => {
    const store = new SessionSuccessionStore(join(root,'roles'), files.roles); await store.ready;
    await store.createRole({id:'reader-role',revision:1,origin:ref('side'),current:ref('side'),workspace:{controllerId:'controller',canonicalCwd:root}});
  });
  f.sessions.set('side',new Native('side',f.root));
  const transport = await enrollmentTransport(f,coldAssociations()), gate=deferredBoundary(),entered=deferredBoundary();
  const original=SessionSuccessionStore.prototype.reserveRelationChange;
  const spy=vi.spyOn(SessionSuccessionStore.prototype,'reserveRelationChange').mockImplementation(async function(this:SessionSuccessionStore,reservation,generation){
    if(reservation.operationId==='persisting-relation'){entered.resolve();await gate.promise;}
    return original.call(this,reservation,generation);
  });
  let changing: Promise<unknown> | undefined, coordinator: SessionSuccessionCoordinator | undefined;
  const prepare=SessionSuccessionCoordinator.prototype.prepareEnrolled;
  const prepareSpy=vi.spyOn(SessionSuccessionCoordinator.prototype,'prepareEnrolled').mockImplementation(function(this:SessionSuccessionCoordinator,...args){coordinator=this;return prepare.apply(this,args);});
  try {
    f.grants.push(...['side','ask','unlinked'].map(nativeSessionId=>({nativeSessionId,sourceNativeSessionId:'A'})),{nativeSessionId:'nested',sourceNativeSessionId:'side'});
    await transport.action('prepare',{operationId:'initial',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});
    await transport.action('commit',{operationId:'initial'});
    changing=transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'persisting-relation',expectedRoleRevision:2});
    await entered.promise;
    const before=f.stateFiles.roles.text('state.json');
    expect(JSON.parse(before).roles.find((row:{role:{current:{nativeSessionId:string}}})=>row.role.current.nativeSessionId==='B').relationChanges??[]).toEqual([]);
    expect(await coordinator!.prepare({operationId:'reader-during-write',roleId:'reader-role',expectedRevision:1,from:ref('side')})).toMatchObject({phase:'rejected'});
    expect(f.creates()).toBe(1); expect(f.sourceCreates()).toBe(0);
    gate.resolve(); await expect(changing).rejects.toThrow(/may have reached/);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'persisting-relation'})).toMatchObject({operation:{phase:'committed'}});
    expect(f.stateFiles.roles.json('state.json').roles.find((row:{role:{current:{nativeSessionId:string}}})=>row.role.current.nativeSessionId==='B').relationChanges![0]!.phase).toBe('released');
    expect((await coordinator!.prepare({operationId:'reader-after-write',roleId:'reader-role',expectedRevision:1,from:ref('side')})).phase).toBe('ready');
  } finally { gate.resolve();await changing?.catch(()=>undefined);spy.mockRestore();prepareSpy.mockRestore();await transport.close();await f.close(); }
},10000);

test.each(['A','B','side'])('fresh relation reserve refuses transient %s and preserves exact concurrent durable identity',async reserved=>{
  let boundary:SessionSuccessionBoundary|undefined;
  const install=SessionSuccessionCoordinator.prototype.setAdmission;
  const installSpy=vi.spyOn(SessionSuccessionCoordinator.prototype,'setAdmission').mockImplementation(function(this:SessionSuccessionCoordinator,admission){boundary=admission as SessionSuccessionBoundary;install.call(this,admission);});
  const f=await fixture(false,true),transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...['side','ask','unlinked'].map(nativeSessionId=>({nativeSessionId,sourceNativeSessionId:'A'})),{nativeSessionId:'nested',sourceNativeSessionId:'side'});
    await transport.action('prepare',{operationId:'initial',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'initial'});
    const grant=f.grants.shift()!;
    await expect(transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'blocked-relation',expectedRoleRevision:2})).rejects.toThrow(/native grant/);
    f.grants.unshift(grant);
    const reservation=transport.saved().associations!.relationChanges![0]!.reservation;
    f.sessions.set('C',new Native('C',f.root));await f.attach('C');
    boundary!.reserve('fixture-fence',ref('C'));boundary!.registerCandidate('fixture-fence',ref(reserved));
    const before=f.stateFiles.roles.text('state.json');
    const blocked=await transport.enrollmentRpc({action:'relation_reserve',reservation});
    expect(blocked.status,blocked.body).toBe(409);expect(JSON.parse(blocked.body).error).toMatch(/handoff/);
    expect(f.stateFiles.roles.text('state.json')).toBe(before);
    expect(f.creates()).toBe(1);expect(f.sourceCreates()).toBe(0);
    boundary!.releaseReservation('fixture-fence');
    const exact=await Promise.all([transport.enrollmentRpc({action:'relation_reserve',reservation}),transport.enrollmentRpc({action:'relation_reserve',reservation})]);
    expect(exact.map(row=>row.status)).toEqual([200,200]);expect(JSON.parse(exact[0].body)).toEqual(JSON.parse(exact[1].body));
    expect(f.stateFiles.roles.json('state.json').roles[0].relationChanges).toHaveLength(1);
    const changed=await transport.enrollmentRpc({action:'relation_reserve',reservation:{...reservation,linked:true}});
    expect(changed.status).toBe(409);expect(JSON.parse(changed.body).error).toMatch(/identity conflict/);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'blocked-relation'})).toMatchObject({operation:{phase:'committed'}});
    expect(f.grants[0]).toEqual(grant);
  }finally{boundary?.releaseReservation('fixture-fence');installSpy.mockRestore();await transport.close();await f.close();}
},10000);

test('fresh relation reserve rejects a restored persistent old-source reservation without a transient fence',async()=>{
  const f=await fixture(false,true),transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...['side','ask','unlinked'].map(nativeSessionId=>({nativeSessionId,sourceNativeSessionId:'A'})),{nativeSessionId:'nested',sourceNativeSessionId:'side'});
    await transport.action('prepare',{operationId:'initial',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'initial'});
    const grant=f.grants.shift()!;
    await expect(transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'restored-block',expectedRoleRevision:2})).rejects.toThrow(/native grant/);
    f.grants.unshift(grant);const reservation=transport.saved().associations!.relationChanges![0]!.reservation;
    await transport.restart(async()=>{
      const store=await f.roleStore();
      await store.createRole({id:'old-source-role',revision:1,origin:ref('A'),current:ref('A'),workspace:{controllerId:'controller',canonicalCwd:f.root}});
      await store.begin({operationId:'durable-old-source',roleId:'old-source-role',expectedRevision:1,from:ref('A')});
      await f.restart();
    });
    await f.host.control({method:'GET',path:'/remote/workspaces?providerId=fixture'});
    const before=f.stateFiles.roles.text('state.json');
    const blocked=await transport.enrollmentRpc({action:'relation_reserve',reservation});
    expect(blocked.status,blocked.body).toBe(409);expect(JSON.parse(blocked.body).error).toMatch(/reserved for handoff/);
    expect(f.stateFiles.roles.text('state.json')).toBe(before);
    expect(f.creates()).toBe(1);expect(f.sourceCreates()).toBe(0);
  }finally{await transport.close();await f.close();}
},10000);
