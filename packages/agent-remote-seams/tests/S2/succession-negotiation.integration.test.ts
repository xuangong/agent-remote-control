/** S2, What the Controller and the Relay negotiate before a handoff: projection ceiling, legacy peers, retries and committed-output invariants. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import { expect, test } from 'vitest';
import { successionHostFixture as fixture } from '@orchardworks/agent-remote-controller/succession-host-testing';
import { enrollmentTransport } from './support/succession-relay.js';
test('negotiated v2 saves an exact ceiling and unsupported producer certification refuses before create', async () => {
  const f=await fixture(false,true), transport=await enrollmentTransport(f);
  try {
    f.unbounded();
    const response=await transport.action('prepare',{operationId:'unbounded',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});
    expect(response.status).toBe(409); expect(f.creates()).toBe(0);
    expect(transport.saved().associations!.freezes[0]!.receipt).toMatchObject({version:2,maxProjectionBytes:2*1024*1024});
    expect((await transport.action('cancel',{operationId:'unbounded'})).status).toBe(200);
    expect((await transport.action('status',{operationId:'unbounded'})).status).toBe(200);
    expect(f.creates()).toBe(0);
  } finally {await transport.close();await f.close();}
},10000);

test.each([{noAllowance:true},{legacyRelay:true}])('new Host retains ordinary connection when preparation cannot be negotiated or admitted: %j', async options => {
  const f=await fixture(false,true), transport=await enrollmentTransport(f,undefined,options);
  try {
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/catalog`,{providerId:'fixture'})).status).toBeLessThan(500);
    expect((await transport.action('prepare',{operationId:'unavailable',providerId:'fixture',nativeSessionId:'A',expectedRevision:1})).status).toBe(409);
    expect(f.creates()).toBe(0);expect(transport.saved().associations!.freezes).toEqual([]);
    if(options.legacyRelay){
      const response=await transport.enrollmentRpc({action:'describe',providerId:'fixture',nativeSessionId:'A'});
      expect(JSON.parse(response.body)).toMatchObject({code:'succession_enrollment_unavailable'});
      expect(response.status).toBe(403);
    }
  } finally {await transport.close();await f.close();}
},10000);

test('old Host on upgraded Relay is legacy-recovery-only and gets no strict v2 acknowledgment field', async () => {
  const f=await fixture(false,true), transport=await enrollmentTransport(f,undefined,{legacyHost:true});
  try {
    const response=await transport.action('prepare',{operationId:'old-new',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'succession_preparation_unavailable'});
    expect(f.creates()).toBe(0);expect(transport.saved().associations!.freezes).toEqual([]);
  } finally {await transport.close();await f.close();}
},10000);

test('saved bounded recovery is explicitly unavailable on an old Relay while ordinary connection and records remain intact',async()=>{
  const options={legacyRelay:false},f=await fixture(false,true),transport=await enrollmentTransport(f,undefined,options);
  try{
    const input={operationId:'retained',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',input)).status).toBe(200);
    const freeze=structuredClone(transport.saved().associations!.freezes[0]!.receipt);
    options.legacyRelay=true;await transport.restart();
    expect((await transport.action('status',{operationId:input.operationId})).status).toBe(409);
    const ordinary=await transport.request(`/v1/remote/hosts/${transport.hostId}/attach`,{providerId:'fixture',nativeSessionId:'A'});expect(ordinary.status).toBe(200);
    expect(transport.saved().associations!.freezes[0]!.receipt).toEqual(freeze);expect(f.creates()).toBe(1);
    options.legacyRelay=false;await transport.restart();
    expect((await transport.action('status',{operationId:input.operationId})).status).toBe(200);expect(f.creates()).toBe(1);
  }finally{await transport.close();await f.close();}
},10000);
