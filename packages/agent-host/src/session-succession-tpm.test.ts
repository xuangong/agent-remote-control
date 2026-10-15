import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { NativeSessionRef, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import type { RemoteHostSessionLease } from '@orchardworks/agent-remote-relay';
import { SessionSuccessionService } from './session-succession-service.js';
import { successionTpmRouting } from './session-succession-tpm.js';
const roots: string[] = [];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const ref=(nativeSessionId:string,providerId='first'):NativeSessionRef=>({controllerId:'host',providerId,nativeSessionId});
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'succession-tpm-routing-'))); roots.push(root);
  const acquired: NativeSessionRef[]=[];
  let released=0, denied=false; let onAuthorize = () => {};
  const queries: AgentHistoryQuery[]=[];
  const legacyEntries: Array<{seq:number;item:{type:'user_message';text:string}}> = [];
  const legacyRequests: unknown[]=[];
  const entry: ProjectedTimelineEntry={providerId:'first',item:{type:'user_message',text:'Original task'},timestamp:'2026-10-10T00:00:00Z',
    seqStart:1,seqEnd:1,sourceSeqRanges:[{start:1,end:1}],collapsed:[],resources:[]};
  const service=new SessionSuccessionService(root,'host',{
    supports:async()=>true,
    inspect:async()=>({cwd:root,idle:true,managed:true,pendingInputs:0,inFlightInputs:0,pendingInteractions:0,activeChildren:0,boundary:{epoch:'e',seq:1}}),
    createIdle:async(_source,_operation,providerId)=>ref('B',providerId),
    captureTimeline:async()=>({entries:[entry],boundary:{epoch:'e',seq:1},capturedAt:'2026-10-10T00:00:00Z'}),
    authorizeRead:async()=>{onAuthorize();if(denied)throw new Error('Access revoked');},
    readHistory:async (source,query)=>{queries.push(query);return {entries:[{id:'message',turnId:'turn',role:'user',text:source.nativeSessionId,textOffset:0,totalChars:1}],...(!query.cursor ? {nextCursor:'native-next'} : {})};},
    reconcileDelivery:async()=>undefined,
  });
  await service.ready;
  await service.createRole({id:'role',revision:1,origin:ref('A'),current:ref('A'),workspace:{controllerId:'host',canonicalCwd:root}});
  const routing=successionTpmRouting(service,'host',async target=>{
    acquired.push(target);
    return {agent:{fetchTimeline:(request:unknown)=>{legacyRequests.push(request);return {payload:{entries:legacyEntries,nextCursor:{epoch:'legacy',seq:99},hasMore:true}};},snapshot:()=>({payload:{persistence:{opaque:'top-secret'},runtimeInfo:{sessionId:target.nativeSessionId,providerId:target.providerId,persistence:{opaque:'secret'}}}})},release:()=>{released++;}} as unknown as RemoteHostSessionLease;
  });
  const commit=async()=>{
    const request={operationId:'handoff',roleId:'role',expectedRevision:1,from:ref('A'),targetProviderId:'second'};
    expect((await service.prepare(request)).phase).toBe('ready');await service.commit('handoff',1);
  };
  return {service,routing,commit,acquired,queries,legacyEntries,legacyRequests,onAuthorize:(callback:()=>void)=>{onAuthorize=callback;},released:()=>released,deny:()=>{denied=true;}};
}
test('TPM reads pending context across providers and old history cursors retain their actual source',async()=>{
  const f=await fixture(),binding=await f.routing.bind('first','A');
  const initial=await f.routing.read!(binding,{}) as {sourceContext:string};
  await f.commit();
  expect(f.routing.resolve(binding)).toEqual({target:ref('B','second'),roleRevision:2});
  expect(await f.routing.bind('first','A')).toEqual(binding);
  expect(()=>f.routing.assertCurrent(binding,ref('A'),1)).toThrow(/changed/);
  const current=await f.routing.read!(binding,{});
  expect(current).toMatchObject({sourceRef:ref('B','second'),sourceRepresentation:'attachment',entries:[{text:'Original task'}],state:{runtimeInfo:{sessionId:'B'}}});
  expect(JSON.stringify(current)).not.toContain('secret');
  expect(await f.routing.read!(binding,{sourceContext:initial.sourceContext})).toMatchObject({sourceRef:ref('A'),sourceRepresentation:'native',entries:[{text:'A'}]});
  expect(f.acquired).toEqual([ref('A'),ref('B','second'),ref('A')]);expect(f.released()).toBe(3);
});
test('TPM contextual reads recheck access and refuse forged or unpinned legacy targets',async()=>{
  const f=await fixture(),binding=await f.routing.bind('first','A');await f.commit();
  await expect(f.routing.read!(binding,{cursor:{epoch:'e',seq:1}})).rejects.toThrow(/explicit sourceRef/);
  await expect(f.routing.read!(binding,{cursor:{epoch:'e',seq:1},sourceRef:ref('foreign')})).rejects.toThrow(/authorized/);
  f.deny();await expect(f.routing.read!(binding,{})).rejects.toThrow('Access revoked');
  expect(f.acquired).toEqual([]);
});

test('legacy TPM reads filter each page and bound serialized UTF-8 entries without changing cursors',async()=>{
  const f=await fixture(),binding=await f.routing.bind('first','A');
  f.legacyEntries.push({seq:1,item:{type:'user_message',text:'MATCH '+ '中'.repeat(20000)}},
    {seq:2,item:{type:'user_message',text:'unrelated'}},{seq:3,item:{type:'user_message',text:'match retained'}});
  await f.commit();
  const cursor={epoch:'legacy',seq:0};
  const result=await f.routing.read!(binding,{cursor,sourceRef:ref('A'),query:'match',limit:3}) as any;
  expect(result.page.entries.map((entry:any)=>entry.seq)).toEqual([3]);
  expect(result.state).toEqual({runtimeInfo:{sessionId:'A',providerId:'first'}});
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(result).toMatchObject({sourceRef:ref('A'),truncated:true,searchScope:'returned_page',page:{nextCursor:{epoch:'legacy',seq:99},hasMore:true}});
  expect(Buffer.byteLength(JSON.stringify(result.page.entries),'utf8')).toBeLessThan(48000);
  expect(f.legacyRequests[0]).toMatchObject({cursor,limit:3});
  const absent=await f.routing.read!(binding,{cursor,sourceRef:ref('A'),query:'absent'}) as any;
  expect(absent.page.entries).toEqual([]);expect(absent.truncated).toBe(false);
  expect(f.released()).toBe(2);
});

test('signed TPM continuation inherits omitted query fields and rejects explicit changes',async()=>{
  const f=await fixture(),binding=await f.routing.bind('first','A');
  const first=await f.routing.read!(binding,{limit:2,query:'needle'}) as {nextCursor:string};
  await f.routing.read!(binding,{cursor:first.nextCursor});
  expect(f.queries).toEqual([{limit:2,query:'needle'},{limit:2,query:'needle',cursor:'native-next'}]);
  await expect(f.routing.read!(binding,{cursor:first.nextCursor,limit:3})).rejects.toThrow(/query cannot change/);
  await expect(f.routing.read!(binding,{cursor:first.nextCursor,query:'different'})).rejects.toThrow(/query cannot change/);
  const bounded=await f.routing.read!(binding,{}) as {nextCursor:string};
  await expect(f.routing.read!(binding,{cursor:bounded.nextCursor,limit:100})).rejects.toThrow(/query cannot change/);
});


test('a retired TPM reader cannot start a native role-history read after asynchronous authorization', async () => {
  const f = await fixture(), binding = await f.routing.bind('first', 'A');
  let current = true; f.onAuthorize(() => { current = false; });
  await expect(f.routing.read!(binding, {}, () => { if (!current) throw new Error('TPM attachment retired'); })).rejects.toThrow('retired');
  expect(f.queries).toEqual([]); expect(f.acquired).toEqual([]);
});
