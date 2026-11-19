/** S2, A TPM session and the Relay's association admission: an unknown or completed TPM keeps its admission and is enrolled without a browser binding. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { successionHostFixture as fixture, SessionSuccessionStore, TpmStore, ref } from '@orchardworks/agent-remote-controller/succession-host-testing';
import { enrollmentTransport } from './support/succession-relay.js';
test.each([false,true])('unknown TPM creation retains exact admission and paused work without browser bindings (existing role %s)',async(existingRole)=>{
  const f=await fixture(true,true,existingRole?async (root,files)=>{const store=new SessionSuccessionStore(join(root,'roles'),files.roles);await store.ready;await store.ensureRole(ref('A'),root);}:undefined);const transport=await enrollmentTransport(f);
  const roles=async()=>f.stateFiles.roles.json('state.json');
  try {
    f.loseTpmCreation(true);
    const created=await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'unknown-tpm'})});
    expect(created.status).toBe(409);
    const workPath=(await f.stateFiles.tpm.list()).find(path=>path.endsWith('.json'))!;
    const record=f.stateFiles.tpm.json(workPath);
    expect(record.creation).toBe('unknown');
    expect((await roles()).associationAdmissions).toHaveLength(1);
    expect((await transport.action('prepare',{operationId:'blocked-tpm',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(409);
    expect((await transport.action('cancel',{operationId:'blocked-tpm'}))!.status).toBe(200);
    const current=async()=>JSON.parse((await f.host.control({method:'GET',path:`/remote/tpm/work?id=${record.work.id}`})).body);
    await expect.poll(async()=>(await current()).mainBinding?.kind).toBe('primary_role');
    let paused:Awaited<ReturnType<typeof f.host.control>>|undefined;
    for(let attempt=0;attempt<4;attempt++){
      const latest=await current();
      paused=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:latest.id,revision:latest.revision,action:'pause',operationId:`pause-tpm-${attempt}`})});
      if(paused.status===200)break;
      expect(paused.status).toBe(409);expect(JSON.parse(paused.body).error).toBe('TPM work changed. Refresh before applying this change.');
    }
    expect(paused!.status,paused!.body).toBe(200);
    const recovered=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:record.work.id,revision:JSON.parse(paused!.body).revision,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'recover-tpm'})});
    expect(recovered.status,recovered.body).toBe(200);
    expect((await roles()).associationAdmissions).toEqual([]);
    const accepted=JSON.parse(recovered.body);
    expect((await transport.action('prepare',{operationId:'enroll-tpm',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    expect((await roles()).roles[0].participants).toEqual([{relationId:`tpm:${accepted.id}`,kind:'tpm',before:ref('tpm-1'),after:ref('tpm-1')}]);
    const persisted=f.stateFiles.tpm.json(workPath);
    expect(persisted.work).toMatchObject({id:accepted.id,tpmNativeSessionId:'tpm-1',paused:true});
    expect(transport.saved().bindings).toEqual([]);
    expect(f.tpmConfigurations).toHaveLength(1);
  }finally{await transport.close();await f.close();}
});


test('completed persisted TPM is enrolled without attaching its native session',async()=>{
  const f=await fixture(true,true,async (root,files)=>{
    const store=new TpmStore(join(root,'tpm'),files.tpm);await store.ready;
    await store.insert({version:1,createKey:'completed-key',createFingerprint:'completed-fingerprint',creation:'accepted',requirement:'Done',dirty:false,lastReviewAt:0,actions:{},work:{
      id:'completed-work',revision:1,title:'Completed work',providerId:'fixture',mainNativeSessionId:'A',tpmNativeSessionId:'cold-tpm',phase:'completed',waiting:'none',paused:false,summary:'Done',nextAction:'',document:'Approved plan',acceptance:'Accepted',evidence:['verified'],createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z',nextCheckAt:0,outbox:[],
    }});
  });const transport=await enrollmentTransport(f);
  try {
    expect((await transport.action('prepare',{operationId:'completed-work-handoff',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    const state=f.stateFiles.roles.json('state.json');
    expect(state.roles[0].participants).toEqual([{relationId:'tpm:completed-work',kind:'tpm',before:ref('cold-tpm'),after:ref('cold-tpm')}]);
    expect(f.sessions.has('cold-tpm')).toBe(false);expect(transport.saved().bindings).toEqual([]);
    const work=f.stateFiles.tpm.json('completed-work.json').work;
    expect(work).toMatchObject({phase:'completed',document:'Approved plan',evidence:['verified']});
  }finally{await transport.close();await f.close();}
});
