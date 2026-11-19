/** S2, The Controller's succession service against the Relay's association state: a handoff derived from broker enrollment, frozen, committed, cancelled and replayed. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, test } from 'vitest';
import { successionHostFixture as fixture, Native, EvidenceNative, ref, sendOverWebSocket, handoffRequest as request } from '@orchardworks/agent-remote-controller/succession-host-testing';
import { enrollmentTransport, coldAssociations } from './support/succession-relay.js';
test('authenticated broker enrollment derives a role, freezes associations and commits over a real uplink',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  try {
    const input={operationId:'trusted-handoff',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',{...input,authority:transport.authority}))!.status).toBe(400);
    expect((await transport.action('prepare',input,'viewer'))!.status).toBe(403);
    expect((await f.host.control({method:'POST',path:'/remote/succession/enrollment',body:JSON.stringify({action:'describe',providerId:'fixture',nativeSessionId:'A'})})).status).toBe(403);
    const prepared=await transport.action('prepare',input);const ready=await prepared!.json();
    expect(ready,JSON.stringify(ready)).toMatchObject({record:{phase:'ready'},role:{origin:ref('A'),workspace:{canonicalCwd:f.root}}});
    expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
    expect(transport.saved().associations?.freezes).toHaveLength(1);
    expect(transport.saved().associations?.freezes[0]?.released).toBeUndefined();
    const committed=await (await transport.action('commit',{operationId:input.operationId}))!.json();
    expect(committed).toMatchObject({record:{phase:'committed'},role:{current:ref('B'),revision:2},locator:{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'B'}});
    expect(transport.saved().associations?.freezes[0]).toMatchObject({released:'committed',projection:{role:{current:ref('B')}}});
    const state=f.stateFiles.roles.json('state.json');
    expect(state).toMatchObject({version:8,roles:[{associationAuthority:transport.authority,enrollments:[{request:{operationId:input.operationId}}]}]});
  } finally {await transport.close();await f.close();}
});

test('public description validates authority and source, exposes blocking facts and never creates a candidate', async () => {
  const f=await fixture(false,true), transport=await enrollmentTransport(f);
  const source={providerId:'fixture',nativeSessionId:'A'};
  try {
    expect((await transport.action('describe',source,'viewer')).status).toBe(403);
    expect((await transport.action('describe',{...source,ready:true})).status).toBe(400);
    expect((await transport.action('describe',{providerId:'fixture'})).status).toBe(400);
    expect(await (await transport.action('describe',source)).json()).toMatchObject({role:{current:ref('A'),revision:1},targets:[{providerId:'fixture',displayName:'Fixture'}],eligibility:{status:'ready'}});
    f.busy('A');
    expect(await (await transport.action('describe',source)).json()).toMatchObject({targets:[{providerId:'fixture'}],eligibility:{status:'blocked',code:'succession_not_quiescent'}});
    expect(f.creates()).toBe(0);expect(transport.saved().associations?.freezes ?? []).toEqual([]);
    f.busy('');
    const operation={...source,operationId:'described-handoff',expectedRevision:1};
    expect((await transport.action('prepare',operation)).status).toBe(200);
    expect((await transport.action('commit',{operationId:operation.operationId})).status).toBe(200);
    expect(await (await transport.action('describe',source)).json()).toMatchObject({role:{current:ref('B'),revision:2},eligibility:{status:'unavailable',code:'session_superseded'}});
    expect(f.creates()).toBe(1);
  } finally {await transport.close();await f.close();}
});

test('public context status reads durable Host state and requires native materialization across reconnect', async () => {
  const f = await fixture(false, true, undefined, false, true), transport = await enrollmentTransport(f);
  const input = { operationId: 'handoff', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 };
  const status = async () => await (await transport.action('status', { operationId: input.operationId, includeContext: true })).json();
  try {
    expect((await transport.action('prepare', input)).status).toBe(200);
    expect((await transport.action('commit', { operationId: input.operationId })).status).toBe(200);
    expect(await status()).toMatchObject({ context: { operationId: 'handoff', target: ref('B'), state: 'pending' } });
    await transport.restart(f.restart);
    expect(await status()).toMatchObject({ context: { target: ref('B'), state: 'pending' } });
    const attached = await f.attach('B'), b = f.sessions.get('B') as EvidenceNative;
    await sendOverWebSocket(f, attached.agentId, 'Continue once', '00000000-0000-4000-8000-000000009201');
    expect(await status()).toMatchObject({ context: { state: 'accepted' } });
    expect(b.dispatches).toBe(1);
    b.materialized = true;
    expect(await status()).toMatchObject({ context: { operationId: 'handoff', target: ref('B'), state: 'materialized' } });
    expect(b.dispatches).toBe(1);
    expect(await status()).toMatchObject({ context: { state: 'materialized' } });
  } finally { await transport.close(); await f.close(); }
}, 15000);

test('real HTTP and WebSocket cancel a blocked create without activating its late candidate', async () => {
  const f = await fixture(false, true), transport = await enrollmentTransport(f);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  f.beforeIdleCreate(async () => { enter(); await blocked; });
  const input = { operationId: 'cancel-blocked', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 };
  const preparing = transport.action('prepare', input);
  try {
    await entered;
    const a = await f.attach('A');
    expect((await sendOverWebSocket(f, a.agentId, 'blocked input', '00000000-0000-4000-8000-000000000080')).type).toBe('protocol_error');
    const cancelled = await transport.action('cancel', { operationId: input.operationId });
    expect(await cancelled.json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect(transport.saved().associations!.freezes[0]!.released).toBe('cancelled');
    release(); expect(await (await preparing).json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect((await sendOverWebSocket(f, a.agentId, 'continue A', '00000000-0000-4000-8000-000000000081')).type).toBe('command_acknowledged');
    expect(f.sessions.get('B')!.sent).toEqual([]);
    expect(await (await transport.action('reconcile', { operationId: input.operationId })).json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect(await (await transport.action('prepare', input)).json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect(f.creates()).toBe(1);
    const contexts = f.stateFiles.contexts.json('context.json');
    expect(contexts.attachments).toEqual([]); expect(contexts.preparations).toHaveLength(1);
    const roles = f.stateFiles.roles.json('state.json');
    expect(roles.roles[0].localPreparations[0].orphanCandidate).toEqual(ref('B'));
  } finally { release(); await preparing.catch(() => undefined); await transport.close(); await f.close(); }
});


test('old operation replay preserves A to B to C',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  const store=async()=>{const value=await f.roleStore();return value;};
  try {
    const input={operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    expect((await transport.action('commit',{operationId:'first'}))!.status).toBe(200);
    const released=await store();
    expect(released.read(released.all()[0]!.role.id).releasedEnrollments).toHaveLength(1);
    const projection=structuredClone(transport.saved().associations!.freezes[0]!.projection);
    const second = await transport.action('prepare',{...input,operationId:'second',nativeSessionId:'B',expectedRevision:2});
    expect(await second!.json()).toMatchObject({record:{phase:'ready'}});
    const secondCommit = await transport.action('commit',{operationId:'second'});
    expect(await secondCommit!.json()).toMatchObject({record:{phase:'committed'},role:{revision:3}});
    const replay=await transport.action('status',{operationId:'first'});
    expect(replay!.status).toBe(200);
    expect(await replay!.json()).toMatchObject({record:{operationId:'first',committedRevision:2},role:{revision:2,current:ref('B')},locator:{nativeSessionId:'B'}});
    expect(transport.saved().associations!.freezes[0]!.projection).toEqual(projection);
    const current = await store(); expect(current.all()[0]!.role).toMatchObject({revision:3,current:ref('C')});
  }finally{await transport.close();await f.close();}
});


test('broker persistence failure keeps a committed Host decision fenced across restart',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  try {
    expect((await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    transport.failProjection(true);
    expect((await transport.action('commit',{operationId:'first'}))!.status).toBe(503);
    const blocked=await f.roleStore();
    expect(blocked.operation('first').phase).toBe('committed');
    await expect(blocked.admitAssociation('new-reader','fingerprint',ref('B'))).rejects.toThrow(/reserved/);
    expect(transport.saved().associations!.freezes[0]!.released).toBeUndefined();
    expect(blocked.all()[0]!.releasedEnrollments).toBeUndefined();
    transport.failProjection(false);await transport.restart(f.restart);
    let contextReadAfterProjection=false;
    transport.beforeControl(async input=>{if((input as {includeContext?:boolean}).includeContext)contextReadAfterProjection=transport.saved().associations!.freezes[0]!.released==='committed';});
    const response=await transport.action('status',{operationId:'first',includeContext:true});
    expect(response.status).toBe(200);
    const recovered=await response.json();
    expect(recovered).toMatchObject({record:{phase:'committed'},context:{operationId:'first',target:ref('B'),state:'pending'}});
    expect(contextReadAfterProjection).toBe(true);
    expect(transport.saved().associations!.freezes[0]!.released).toBe('committed');
    expect(transport.saved().associations!.freezes[0]!.projection).toEqual({version:1,role:recovered.role,receipt:recovered.record});
    expect(await (await transport.action('status',{operationId:'first'})).json()).not.toHaveProperty('context');
    const released=await f.roleStore();
    expect(released.all()[0]!.releasedEnrollments).toHaveLength(1);
    expect(f.creates()).toBe(1);
  }finally{await transport.close();await f.close();}
});


test('pre-begin validation failure can be durably cancelled without late preparation effects',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  try {
    const input={operationId:'missing-grant-relation',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    f.grants.push({nativeSessionId:'cold-side',sourceNativeSessionId:'A'});
    expect((await transport.action('prepare',input))!.status).toBe(409);
    expect(transport.saved().associations!.freezes[0]!.released).toBeUndefined();
    const cancelled=await transport.action('cancel',{operationId:input.operationId});
    expect(cancelled!.status).toBe(200);
    expect(await cancelled!.json()).toMatchObject({record:{phase:'cancelled'}});
    f.grants.length=0;
    expect(await (await transport.action('prepare',input))!.json()).toMatchObject({record:{phase:'cancelled'}});
    expect(f.creates()).toBe(0);
    const restored=await f.roleStore();
    expect(restored.operation(input.operationId).phase).toBe('cancelled');
    expect(restored.all()[0]!.releasedEnrollments).toHaveLength(1);
  }finally{await transport.close();await f.close();}
});

test('cancellation serializes ahead of a delayed pre-begin grant snapshot',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  let resume!:()=>void;let entered!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{resume=resolve;});
  try {
    f.beforeGrants(async()=>{entered();await gate;});
    const input={operationId:'delayed-prepare',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    const preparing=transport.action('prepare',input);await reached;
    expect((await transport.action('cancel',{operationId:input.operationId}))!.status).toBe(200);
    resume();
    expect(await (await preparing)!.json()).toMatchObject({record:{phase:'cancelled'}});
    expect(f.creates()).toBe(0);
  }finally{resume();await transport.close();await f.close();}
});


test.each(['source','revision','provider'] as const)('concurrent different %s cannot reuse one frozen operation identity',async conflict=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let describes=0,prepares=0;
  try {
    f.sessions.set('X',new Native('X',f.root));
    transport.beforeControl(async input=>{if(input.action==='describe'){if(++describes===2)release();await gate;}if(input.action==='prepare')prepares++;});
    const input={operationId:'same-operation',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    const changed=conflict==='source'?{nativeSessionId:'X'}:conflict==='revision'?{expectedRevision:2}:{targetProviderId:'other'};
    const results=await Promise.all([transport.action('prepare',input),transport.action('prepare',{...input,...changed})]);
    expect(results.map(result=>result!.status).sort()).toEqual([200,409]);
    expect(prepares).toBe(1);
    const selected=transport.saved().associations!.freezes[0]!.receipt.request;
    expect(f.creates()).toBe(selected.targetProviderId==='other'?0:1);
  }finally{release();await transport.close();await f.close();}
});


test('past and future expected revisions fail before any broker freeze or Host preparation',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);let prepares=0;
  try {
    transport.beforeControl(async input=>{if(input.action==='prepare')prepares++;});
    const input={operationId:'future',providerId:'fixture',nativeSessionId:'A',expectedRevision:2};
    expect((await transport.action('prepare',input))!.status).toBe(409);
    expect(transport.saved().associations!.freezes).toHaveLength(0);expect(prepares).toBe(0);
    expect((await transport.action('prepare',{...input,operationId:'valid-first',expectedRevision:1}))!.status).toBe(200);
    expect((await transport.action('commit',{operationId:'valid-first'}))!.status).toBe(200);
    expect((await transport.action('prepare',{...input,operationId:'past',nativeSessionId:'B',expectedRevision:1}))!.status).toBe(409);
    expect(transport.saved().associations!.freezes).toHaveLength(1);expect(prepares).toBe(1);
    expect((await transport.action('prepare',{...input,operationId:'valid-second',nativeSessionId:'B'}))!.status).toBe(200);
    expect(prepares).toBe(2);
  }finally{await transport.close();await f.close();}
});


test.each([{installationId:'foreign'},{enrollment:false}])('mismatched Controller or unnegotiated peer fails before native creation: %j',async options=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f,undefined,options);
  try {
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'forbidden-peer',expectedRevision:1}))!.status).toBe(409);
    expect(f.creates()).toBe(0);expect(transport.saved().associations!.freezes).toEqual([]);
  }finally{await transport.close();await f.close();}
});

test('replacing the association authority never takes over a previously bound role',async()=>{
  const f=await fixture(false,true);let transport=await enrollmentTransport(f);
  try {
    const input={providerId:'fixture',nativeSessionId:'A',operationId:'bound-role',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    expect((await transport.action('cancel',{operationId:input.operationId}))!.status).toBe(200);
    await transport.close();transport=await enrollmentTransport(f);
    expect((await transport.action('prepare',{...input,operationId:'replacement-authority'}))!.status).toBe(409);
    expect(f.creates()).toBe(1);expect(transport.saved().associations!.freezes).toEqual([]);
  }finally{await transport.close();await f.close();}
});


test('a full Host and broker restart safely rejects a known candidate when capture cannot be revalidated',async()=>{
  const f=await fixture(false,true);f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
  const transport=await enrollmentTransport(f,coldAssociations());
  try {
    const input={providerId:'fixture',nativeSessionId:'A',operationId:'restart-frozen',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    const receipt=structuredClone(transport.saved().associations!.freezes[0]!.receipt);
    await transport.restart(f.restart);
    const restored=await (await transport.action('status',{operationId:input.operationId}))!.json();
    expect(restored.record.phase).toBe('unknown');
    expect(transport.saved().associations!.freezes[0]!.receipt).toEqual(receipt);
    expect(transport.saved().associations!.freezes[0]!.released).toBeUndefined();
    const blocked=await f.host.control({method:'POST',path:'/remote/create',sessionId:'blocked-restart',body:JSON.stringify({providerId:'fixture',sourceNativeSessionId:'A',operationId:'00000000-0000-4000-8000-000000000007'})});
    expect(blocked.status).toBe(400);expect(f.sourceCreates()).toBe(0);
    const reconciled=await transport.action('reconcile',{operationId:input.operationId});
    expect(reconciled!.status).toBe(200);
    expect(await reconciled!.json()).toMatchObject({record:{phase:'rejected',to:ref('B'),failureCode:'succession_boundary_changed'}});
    expect((await (await transport.action('status',{operationId:input.operationId}))!.json()).record.phase).toBe('rejected');
    expect(transport.saved().associations!.freezes[0]!.released).toBe('rejected');
    expect(f.creates()).toBe(1);
  }finally{await transport.close();await f.close();}
});


test('pre-role retained queued input blocks enrolled first enablement', async () => {
  const f = await fixture(false, true); const transport = await enrollmentTransport(f);
  try {
    const a = await f.attach('A');
    expect((await sendOverWebSocket(f, a.agentId, 'queued before role', '00000000-0000-4000-8000-000000000109')).type).toBe('command_acknowledged');
    const result = await transport.action('prepare', { providerId: 'fixture', nativeSessionId: 'A', operationId: 'first-role', expectedRevision: 1 });
    expect(result!.status).toBe(200); expect((await result!.json()).record.phase).toBe('rejected'); expect(f.creates()).toBe(0);
  } finally { await transport.close(); await f.close(); }
}, 10000);

test('real uplink authorizes snapshot provenance on its source provider and retains both create identities', async () => {
  const f = await fixture(false, true, undefined, true), transport = await enrollmentTransport(f);
  const path = `/v1/remote/hosts/${transport.hostId}/create`;
  try {
    await transport.request(`/v1/remote/hosts/${transport.hostId}/attach`, { providerId:'fixture', nativeSessionId:'A' });
    const input = { providerId:'fixture', operationId:'00000000-0000-4000-8000-000000000201', creationSource:{providerId:'other',nativeSessionId:'other-A'} };
    expect((await transport.request(path, input)).status).toBe(403);
    expect(f.snapshotConfigurations).toEqual([]);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/attach`, {providerId:'other',nativeSessionId:'other-A'})).status).toBe(200);
    const created = await transport.request(path, input); expect(created.status, await created.clone().text()).toBe(200);
    const result = await created.json();
    expect(await (await transport.request(path, input)).json()).toEqual(result);
    expect(f.snapshotConfigurations).toHaveLength(1);
    expect(f.snapshotConfigurations[0]).not.toHaveProperty('creationSource');
    expect(f.snapshotConfigurations[0]).not.toHaveProperty('sourceNativeSessionId');
    expect(f.snapshotConfigurations[0]).not.toHaveProperty('tools');
    expect(f.grants).toEqual([]);
    expect(transport.saved().bindings.find(row=>row.agentId===result.agentId)).not.toHaveProperty('sourceRelation');
    expect((await transport.request(path, {...input,creationSource:{providerId:'fixture',nativeSessionId:'A'}})).status).toBe(409);
    await transport.restart();
    expect(await (await transport.request(path, input)).json()).toEqual(result);
    expect((await transport.request(path, {...input,creationSource:{providerId:'fixture',nativeSessionId:'A'}})).status).toBe(409);
    expect(f.snapshotConfigurations).toHaveLength(1);
    for (const bad of [ {...input.creationSource,controllerId:'other-host'}, {...input.creationSource,hostId:'other-host'}, {...input.creationSource,nativeSessionId:' other-A'} ]) {
      expect((await transport.request(path, {...input,operationId:crypto.randomUUID(),creationSource:bad})).status).toBe(400);
    }
    expect((await transport.request(path, {...input,operationId:crypto.randomUUID(),sourceNativeSessionId:'A'})).status).toBe(400);
  } finally { await transport.close(); await f.close(); }
}, 10000);
