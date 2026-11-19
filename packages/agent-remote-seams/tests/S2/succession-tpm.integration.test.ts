/** S2, A TPM session and the Relay's association admission: an unknown or completed TPM keeps its admission and is enrolled without a browser binding. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { successionHostFixture as fixture, TpmStore, ref } from '@orchardworks/agent-remote-controller/succession-host-testing';
import { enrollmentTransport } from './support/succession-relay.js';
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
