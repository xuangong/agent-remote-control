/** S2, The Controller's succession service against the Relay's association state: a handoff derived from broker enrollment, frozen, committed, cancelled and replayed. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import WebSocket from 'ws';
import { expect, test } from 'vitest';
import { successionHostFixture as fixture, ref, sendOverWebSocket, handoffRequest as request } from '@orchardworks/agent-remote-controller/succession-host-testing';
import { enrollmentTransport } from './support/succession-relay.js';
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


test.each([{installationId:'foreign'},{enrollment:false}])('mismatched Controller or unnegotiated peer fails before native creation: %j',async options=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f,undefined,options);
  try {
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'forbidden-peer',expectedRevision:1}))!.status).toBe(409);
    expect(f.creates()).toBe(0);expect(transport.saved().associations!.freezes).toEqual([]);
  }finally{await transport.close();await f.close();}
});

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
