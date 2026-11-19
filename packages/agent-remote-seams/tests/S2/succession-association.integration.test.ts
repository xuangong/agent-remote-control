/** S2, The Controller's succession service against the Relay's relation edits and cold grants: what a freeze fences, and what a restart recovers. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import { expect, test } from 'vitest';
import { successionHostFixture as fixture, ref } from '@orchardworks/agent-remote-controller/succession-host-testing';
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
