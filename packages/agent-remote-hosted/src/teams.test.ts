import { expect, it } from 'vitest';
import type { Team, TeamSeat } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { createHostBroker } from './broker.js';
import { validSavedTeam, deliveryFingerprint, trimTeamDeliveryReceipts, type SavedTeam } from './team-delivery.js';
import { isTeam } from '@orchardworks/agent-remote-protocol';
import { PortableTeamResourceStore, type TeamResourceStorage } from './team-resources.js';
import { createHash } from 'node:crypto';
function fixture(create?: (seat:TeamSeat)=>Promise<TeamSeat['member']>, lifetime?: {now:()=>number;ttl:number}) {
  const rows=new Map<string,Uint8Array>();const storage:TeamResourceStorage={async get(key){return rows.get(key);},async put(key,value){rows.set(key,value);},async delete(key){rows.delete(key);},async list(prefix){return [...rows.keys()].filter(key=>key.startsWith(prefix));}};
  const resources=new PortableTeamResourceStore({storage,...(lifetime?{now:lifetime.now,draftTtlMs:lifetime.ttl}:{})});
  let state:SavedTeam[]=[], now=100;
  const calls:TeamSeat[]=[];
  const ports:ConstructorParameters<typeof TeamBroker>[0]={resolveSession:(hostId,providerId,nativeSessionId)=>({controllerId:hostId,providerId,nativeSessionId}),resources,resourceDraftTtlMs:lifetime?.ttl,read:()=>state,now:lifetime?.now??(()=>++now),assertHost:()=>{},change:async update=>{const draft=structuredClone(state);const result=structuredClone(update(draft));state=draft;return result;},
    createSeat:async(_,seat)=>{calls.push(seat);return create ? create(seat) : {...seat.member,nativeSessionId:`native-${seat.member.id}`,creation:'ready',activity:'idle'};}};
  const broker=new TeamBroker(ports);
  return {broker,calls,ports,snapshot:()=>structuredClone(state),seed:(saved:SavedTeam[])=>{state=structuredClone(saved);},restart:()=>new TeamBroker({...ports,resources:new PortableTeamResourceStore({storage,...(lifetime?{now:lifetime.now,draftTtlMs:lifetime.ttl}:{})})})};
}
const source={hostId:'mac',providerId:'codex',nativeSessionId:'main',title:'Project'};
async function group(f=fixture()) {
  let team=await f.broker.create({operationId:'create',source});
  team=await f.broker.action({teamId:team.id,action:'add_member',operationId:'win-worker',hostId:'win',providerId:'claude',cwd:'C:\\project',name:'Windows verification',responsibility:'Diagnose only'});
  return {...f,team,leader:team.members[0]!,worker:team.members[1]!};
}
it('reserves stable member identities and prevents duplicate creation',async()=>{
  const f=fixture(); const a=await f.broker.create({operationId:'create',source}),b=await f.broker.create({operationId:'create',source});
  expect(a.id).toBe(b.id);expect(f.calls).toHaveLength(1);
  await expect(f.broker.create({operationId:'create',source:{...source,nativeSessionId:'other'}})).rejects.toThrow('different');
});
it('restricts tool calls to exact registered Host and leader/member relationships',async()=>{
  const {broker,team,leader,worker}=await group();
  await expect(broker.hostCall('intruder',{action:'read',teamId:team.id,memberId:worker.id})).rejects.toThrow('registered');
  await expect(broker.hostCall('win',{action:'describe_member',teamId:team.id,memberId:worker.id,target:leader.id,responsibility:'override'})).rejects.toThrow('Leader');
  await expect(broker.hostCall('win',{action:'send',teamId:team.id,memberId:worker.id,to:worker.id,operationId:'self',text:'bad'})).rejects.toThrow('Leader');
  const call={action:'send' as const,teamId:team.id,memberId:leader.id,to:worker.id,operationId:'diagnose',text:'Inspect service logs; return evidence.'};
  const first=await broker.hostCall('mac',call);expect(await broker.hostCall('mac',call)).toEqual(first);
  await expect(broker.hostCall('mac',{...call,text:'Deploy instead'})).rejects.toThrow('different');
  expect(await broker.hostCall('win',{action:'send',teamId:team.id,memberId:worker.id,to:leader.id,operationId:'reply',text:'Service is stopped.'})).toMatchObject({status:'queued'});
});
it('archive cancels unclaimed input and waits for fresh idle evidence from every member',async()=>{
  const {broker,team,leader,worker}=await group();
  await broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'check',text:'Inspect'});
  const stopping=await broker.action({teamId:team.id,action:'archive'});expect(stopping.status).toBe('archiving');expect(stopping.messages).toEqual([]);
  await expect(broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'new',text:'Again'})).rejects.toThrow('not active');
  await broker.hostCall('mac',{action:'presence',teamId:team.id,memberId:leader.id,activity:'idle'});
  expect(broker.list()[0]!.status).toBe('archiving');
  await broker.hostCall('win',{action:'presence',teamId:team.id,memberId:worker.id,activity:'idle'});
  expect(broker.list()[0]!.status).toBe('archived');
  await broker.action({teamId:team.id,action:'restore'});expect(broker.list()[0]!.messages).toEqual([]);
});
it('keeps unknown native delivery unresolved until explicit user settlement',async()=>{
  const {broker,team,leader,worker}=await group();
  const message=await broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'check',text:'Inspect'}) as {id:string};
  const claim={teamId:team.id,memberId:worker.id,messageId:message.id};
  await broker.hostCall('win',{action:'claim',...claim});
  await expect(broker.hostCall('win',{action:'claim',...claim})).rejects.toThrow('claimed');
  await broker.hostCall('win',{action:'settle',...claim,outcome:'unknown'});
  await broker.action({teamId:team.id,action:'archive'});
  await broker.hostCall('mac',{action:'presence',teamId:team.id,memberId:leader.id,activity:'idle'});
  await broker.hostCall('win',{action:'presence',teamId:team.id,memberId:worker.id,activity:'idle'});
  expect(broker.list()[0]!.status).toBe('archiving');
  await broker.action({teamId:team.id,action:'resolve_message',messageId:message.id,outcome:'accepted'});
  expect(broker.list()[0]!.status).toBe('archived');
});
it('retains uncertain creation rather than inventing a ready native session',async()=>{
  const f=fixture(async()=>{throw new Error('receipt lost');});const team=await f.broker.create({source,operationId:'uncertain'});
  expect(team.members[0]).toMatchObject({creation:'unknown',error:'receipt lost'});
});
it('does not archive merely because native input was accepted into a queue',async()=>{
 const {broker,team,leader,worker}=await group();
 const message=await broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'queued',text:'Inspect'}) as {id:string};
 const receipt={teamId:team.id,memberId:worker.id,messageId:message.id};
 await broker.hostCall('win',{action:'claim',...receipt});await broker.hostCall('win',{action:'settle',...receipt,outcome:'accepted',acceptance:'queued'});
 await broker.action({teamId:team.id,action:'archive'});
 await broker.hostCall('mac',{action:'presence',teamId:team.id,memberId:leader.id,activity:'idle'});
 await broker.hostCall('win',{action:'presence',teamId:team.id,memberId:worker.id,activity:'idle'});
 expect(broker.list()[0]!.status).toBe('archiving');
 await broker.hostCall('win',{action:'settle',...receipt,outcome:'accepted',acceptance:'started'});
 await broker.hostCall('win',{action:'presence',teamId:team.id,memberId:worker.id,activity:'idle'});
 expect(broker.list()[0]!.status).toBe('archived');
});

it('bounds sender-scoped message identities even for maximum-length operation IDs',async()=>{
  const {broker,team,leader,worker}=await group();
  const sent=await broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'x'.repeat(256),text:'Inspect'}) as {id:string};
  expect(sent.id.length).toBeLessThanOrEqual(256);
  expect(broker.list()[0]!.messages.find(message=>message.id===sent.id)).toBeDefined();
});
it('rechecks the sending Host lifetime at the serialized mutation boundary',async()=>{
  const {broker,team,leader,worker}=await group(); let checks=0;
  await expect(broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'revoked',text:'Inspect'},()=>{if(++checks>1)throw new Error('Host retired');})).rejects.toThrow('retired');
  expect(broker.list()[0]!.messages.some(message=>message.text==='Inspect')).toBe(false);
});

it('persists sender ownership and recipient grants without adding file bytes to Team messages',async()=>{
  const {broker,team,leader,worker,restart}=await group();
  const bytes=Buffer.alloc(180000,42),sha256=createHash('sha256').update(bytes).digest('hex'),scope={teamId:team.id,memberId:leader.id,operationId:'zip'};
  await broker.hostCall('mac',{...scope,action:'resource_begin',name:'diagnostic.zip',mediaType:'application/zip',byteLength:bytes.length,sha256});
  for(let offset=0;offset<bytes.length;offset+=32768)await broker.hostCall('mac',{...scope,action:'resource_chunk',offset,contentBase64:bytes.subarray(offset,offset+32768).toString('base64')});
  const finished=await broker.hostCall('mac',{...scope,action:'resource_finish'}) as {resource:{resourceId:string}};
  const resourceId=finished.resource.resourceId;
  const read={teamId:team.id,memberId:worker.id,resourceId,action:'resource_metadata' as const};
  await expect(broker.hostCall('win',read)).rejects.toThrow('access');
  const sent=await broker.hostCall('mac',{...scope,action:'send',to:worker.id,text:'Check [resource #1].',resources:[resourceId]});
  expect(await broker.hostCall('mac',{...scope,action:'send',to:worker.id,text:'Check [resource #1].',resources:[resourceId]})).toEqual(sent);
  expect(await broker.hostCall('win',read)).toMatchObject({resourceId,sha256,byteLength:bytes.length});
  const target={teamId:team.id,memberId:worker.id,messageId:(sent as {id:string}).id};
  await broker.hostCall('win',{action:'claim',...target});
  await broker.hostCall('win',{action:'settle',...target,outcome:'accepted',acceptance:'started'});
  expect(broker.list()[0]!.messages.some(item=>item.id===target.messageId)).toBe(false);
  const restored=restart();expect(await restored.hostCall('win',read)).toMatchObject({resourceId,sha256});
  await expect(restored.hostCall('intruder',read)).rejects.toThrow('registered');
  const other=await restored.create({operationId:'other-team',source});
  await expect(restored.hostCall('mac',{action:'resource_metadata',teamId:other.id,memberId:other.members[0]!.id,resourceId})).rejects.toThrow('access');
  expect(JSON.stringify(broker.list())).not.toContain(bytes.toString('base64'));
  expect(Buffer.byteLength(JSON.stringify(broker.list()))).toBeLessThan(10000);
  await expect(broker.hostCall('mac',{...scope,action:'send',to:worker.id,text:'Check [resource #1].',resources:['other']})).rejects.toThrow();
  const returned=await broker.hostCall('win',{teamId:team.id,memberId:worker.id,action:'send',to:leader.id,operationId:'return',text:'Verified',resources:[resourceId]});
  expect(returned).toMatchObject({resources:[{resourceId}]});
});

it('expires completed unsent resources while retaining sent files and reclaiming draft manifest slots',async()=>{
  let now=0;const {broker,team,leader,worker}=await group(fixture(undefined,{now:()=>now,ttl:10}));
  const bytes=Buffer.from('fixture'),sha256=createHash('sha256').update(bytes).digest('hex');
  const upload=async(operationId:string)=>{
    const scope={teamId:team.id,memberId:leader.id,operationId};
    await broker.hostCall('mac',{...scope,action:'resource_begin',name:'fixture.zip',mediaType:'application/zip',byteLength:bytes.length,sha256});
    await broker.hostCall('mac',{...scope,action:'resource_chunk',offset:0,contentBase64:bytes.toString('base64')});
    return (await broker.hostCall('mac',{...scope,action:'resource_finish'}) as {resource:{resourceId:string}}).resource;
  };
  const kept=await upload('kept'),draft=await upload('draft');
  const sent=await broker.hostCall('mac',{teamId:team.id,memberId:leader.id,action:'send',to:worker.id,operationId:'send',text:'Inspect',resources:[kept.resourceId]}) as {id:string};
  const target={teamId:team.id,memberId:worker.id,messageId:sent.id};
  await broker.hostCall('win',{action:'claim',...target});
  await broker.hostCall('win',{action:'settle',...target,outcome:'accepted',acceptance:'started'});
  now=25*60*60*1000;
  await broker.hostCall('win',{action:'presence',teamId:team.id,memberId:worker.id,activity:'idle'});
  expect((await broker.hostCall('mac',{action:'read',teamId:team.id,memberId:leader.id}) as {receipts:unknown[]}).receipts).toEqual([]);
  await expect(broker.hostCall('mac',{action:'resource_metadata',teamId:team.id,memberId:leader.id,resourceId:draft.resourceId})).rejects.toThrow('access');
  expect(await broker.hostCall('win',{action:'resource_metadata',teamId:team.id,memberId:worker.id,resourceId:kept.resourceId})).toMatchObject({sha256});
  const replacement=await upload('replacement');
  expect(broker.list()[0]!.resourceUploads?.map(item=>item.resource.resourceId)).toEqual([kept.resourceId,replacement.resourceId]);
});


it('releases both count and byte capacity after successful or rejected delivery', async () => {
  const {broker,team,leader,worker,snapshot}=await group();
  for (let i=0;i<220;i++) {
    const message=await broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:`delivery-${i}`,text:'x'.repeat(8000)}) as {id:string};
    const target={teamId:team.id,memberId:worker.id,messageId:message.id};
    await broker.hostCall('win',{action:'claim',...target});
    await broker.hostCall('win',{action:'settle',...target,outcome:i%2?'rejected':'accepted',...(i%2?{error:'Native refused input.'}:{acceptance:'started' as const})});
    expect(broker.list()[0]!.messages.some(item=>item.id===message.id)).toBe(false);
  }
  expect(validSavedTeam(snapshot()[0])).toBe(true);
  expect(isTeam(broker.list()[0])).toBe(true);
  expect(JSON.stringify(snapshot()).length).toBeLessThan(36000);
  expect(broker.list()[0]!.messages).toHaveLength(1); // The unclaimed member registration remains.
});

it('deduplicates settled sends and late receipts across a broker restart without retaining the body',async()=>{
  const {broker,team,leader,worker,restart,snapshot}=await group();
  const input={action:'send' as const,teamId:team.id,memberId:leader.id,to:worker.id,operationId:'settled',text:'A private delivery body.'};
  const message=await broker.hostCall('mac',input) as {id:string};
  const target={teamId:team.id,memberId:worker.id,messageId:message.id};
  await broker.hostCall('win',{action:'claim',...target});
  await broker.hostCall('win',{action:'settle',...target,outcome:'rejected',error:'Permission denied.'});
  expect(JSON.stringify(snapshot())).not.toContain(input.text);
  const restored=restart();
  expect(await restored.hostCall('mac',input)).toMatchObject({id:message.id,status:'rejected',error:'Permission denied.'});
  expect(await restored.hostCall('win',{action:'settle',...target,outcome:'rejected'})).toMatchObject({id:message.id,status:'rejected'});
  await expect(restored.hostCall('mac',{...input,text:'Different task'})).rejects.toThrow('different');
  await expect(restored.hostCall('mac',{action:'settle',...target,memberId:leader.id,outcome:'accepted'})).rejects.toThrow('addressed');
  expect(restored.list()[0]!.messages.some(item=>item.id===message.id)).toBe(false);
});

it('reclaims legacy settled history before admitting new messages while preserving uncertain input',async()=>{
  const {broker,team,leader,worker,seed,restart,snapshot}=await group();
  const legacy=snapshot()[0]!;
  legacy.messages=Array.from({length:199},(_,i)=>({id:`old-${i}`,from:leader.id,to:worker.id,text:'old completed input',status:i%2?'rejected' as const:'accepted' as const,...(i%2?{}:{acceptance:'started' as const}),createdAt:1}));
  legacy.messages.push({id:'uncertain',from:leader.id,to:worker.id,text:'Keep this input',status:'unknown',createdAt:2});
  seed([legacy]);
  const restored=restart();
  expect(await restored.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'new',text:'New work'})).toMatchObject({status:'queued'});
  expect(restored.list()[0]!.messages.map(item=>item.text)).toEqual(['Keep this input','New work']);
  await restored.action({action:'resolve_message',teamId:team.id,messageId:'uncertain',outcome:'rejected'});
  expect(restored.list()[0]!.messages).toHaveLength(1);
});


it('still bounds unresolved backlog and releases a slot after explicit failed settlement',async()=>{
  const {team,leader,worker,seed,restart,snapshot}=await group();
  const stored=snapshot()[0]!;
  stored.messages=Array.from({length:200},(_,i)=>({id:`pending-${i}`,from:leader.id,to:worker.id,text:'Inspect',status:i%2?'unknown' as const:'accepted' as const,...(i%2?{}:{acceptance:'queued' as const}),createdAt:1}));
  seed([stored]);
  const broker=restart(),input={action:'send' as const,teamId:team.id,memberId:leader.id,to:worker.id,operationId:'new',text:'New work'};
  await expect(broker.hostCall('mac',input)).rejects.toThrow('capacity');
  expect(broker.list()[0]!.messages).toHaveLength(200);
  await broker.action({action:'resolve_message',teamId:team.id,messageId:'pending-1',outcome:'rejected'});
  expect(await broker.hostCall('mac',input)).toMatchObject({status:'queued'});
  expect(broker.list()[0]!.messages).toHaveLength(200);
});


it('compacts old settled bodies on broker restore before any client or Host request',async()=>{
  const {leader,worker,snapshot}=await group();
  const team=snapshot()[0]!;
  team.messages=[{id:'old',from:leader.id,to:worker.id,text:'Legacy settled body',status:'rejected',createdAt:1},
    {id:'unknown',from:leader.id,to:worker.id,text:'Uncertain input',status:'unknown',createdAt:2}];
  const broker=createHostBroker({origin:'https://relay.example',initialState:{keys:[],hosts:[],bindings:[],creations:[],teams:[team]}});
  try {
    const saved=broker.snapshot().teams![0]!;
    expect(saved.messages.map(message=>message.id)).toEqual(['unknown']);
    expect(JSON.stringify(saved)).not.toContain('Legacy settled body');
    expect(validSavedTeam(saved)).toBe(true);
  } finally { await broker.close(); }
});


it('evicts retry receipts under shared storage pressure without discarding queued work',async()=>{
  const {broker:mailbox,team,leader,worker,snapshot}=await group();
  const sent=await mailbox.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'failure',text:'Inspect'}) as {id:string};
  const target={teamId:team.id,memberId:worker.id,messageId:sent.id};
  await mailbox.hostCall('win',{action:'claim',...target});
  await mailbox.hostCall('win',{action:'settle',...target,outcome:'rejected',error:'e'.repeat(2000)});
  const teams=Array.from({length:32},(_,i)=>({...structuredClone(snapshot()[0]!),id:`team-${i}`,messages:Array.from({length:4},(_,j)=>({id:`pending-${j}`,from:leader.id,to:worker.id,text:'x',status:'queued' as const,createdAt:1}))}));
  const maximum=2*1024*1024;
  let remaining=maximum-32-Buffer.byteLength(JSON.stringify(teams));
  for(const team of teams)for(const message of team.messages){const extra=Math.min(15999,remaining);message.text+='x'.repeat(extra);remaining-=extra;}
  expect(remaining).toBe(0);
  const broker=createHostBroker({origin:'https://relay.example',now:()=>1000,initialState:{keys:[],hosts:[{id:'mac',installationId:'mac',name:'Mac',providers:[{providerId:'codex',displayName:'Codex'}],legacyDsh:false}],bindings:[],creations:[],teams}});
  try {
    const response=await broker.handleRequest(new Request('https://relay.example/v1/remote/teams/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'rename',teamId:'team-0',title:'n'.repeat(256)})}));
    expect(response?.status).toBe(200);
    const stored=broker.snapshot().teams!;
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(maximum);
    expect(stored.reduce((count,team)=>count+team.messages.length,0)).toBe(128);
    expect(stored.reduce((count,team)=>count+(team.deliveryReceipts?.length??0),0)).toBeLessThan(32);
  } finally { await broker.close(); }
});


it('projects every Team response through the current recipient and pins claim evidence across compaction', async () => {
  const f = await group(); const anchor = f.worker.nativeSessionId!;
  const recipient = { controllerId: 'controller-win', providerId: f.worker.providerId, nativeSessionId: 'B' };
  f.ports.resolveSession = (hostId, providerId, nativeSessionId) => ({ controllerId: `controller-${hostId}`, providerId, nativeSessionId: nativeSessionId === anchor ? recipient.nativeSessionId : nativeSessionId });
  const sent = await f.broker.hostCall('mac', { action: 'send', teamId: f.team.id, memberId: f.leader.id, to: f.worker.id, operationId: 'prefix', text: 'Inspect once' }) as any;
  const claim = { teamId: f.team.id, memberId: f.worker.id, messageId: sent.id };
  for (const result of [f.broker.list()[0], await f.broker.hostCall('win', { action: 'read', teamId: f.team.id, memberId: f.worker.id }), await f.broker.action({ action: 'rename', teamId: f.team.id, title: 'Renamed' }), await f.broker.action({ action: 'retry_creation', teamId: f.team.id, memberId: f.worker.id })] as Team[]) expect(result.members[1]!.nativeSessionId).toBe('B');
  expect(f.snapshot()[0]!.members[1]!.nativeSessionId).toBe(anchor);
  await expect(f.broker.hostCall('win', { action: 'claim', ...claim })).rejects.toThrow(/recipient|moved/);
  await expect(f.broker.hostCall('win', { action: 'claim', ...claim, expectedNativeSessionId: anchor })).rejects.toThrow(/recipient/);
  const claimed = await f.broker.hostCall('win', { action: 'claim', ...claim, expectedNativeSessionId: 'B' });
  expect(claimed).toMatchObject({ status: 'dispatching', resolvedTarget: recipient });
  expect(f.broker.hasUnsettledRecipient(recipient)).toBe(true);
  await expect(f.broker.hostCall('win', { action: 'settle', ...claim, outcome: 'accepted', resolvedTarget: { ...recipient, nativeSessionId: 'other' } })).rejects.toThrow(/recipient/);
  await f.broker.hostCall('win', { action: 'settle', ...claim, outcome: 'accepted', acceptance: 'queued', resolvedTarget: recipient });
  expect(f.broker.hasUnsettledRecipient(recipient)).toBe(true);
  await f.broker.hostCall('win', { action: 'settle', ...claim, outcome: 'accepted', acceptance: 'started', resolvedTarget: recipient });
  expect(f.broker.hasUnsettledRecipient(recipient)).toBe(false);
  recipient.nativeSessionId = 'C';
  const restarted = f.restart();
  expect(validSavedTeam(f.snapshot()[0])).toBe(true);
  expect(await restarted.hostCall('mac', { action: 'send', teamId: f.team.id, memberId: f.leader.id, to: f.worker.id, operationId: 'prefix', text: 'Inspect once' })).toMatchObject({ status: 'accepted', resolvedTarget: { ...recipient, nativeSessionId: 'B' } });
  f.ports.resolveSession = () => { throw new Error('Generic succession unavailable'); };
  expect(f.broker.list()[0]!.members[1]!.nativeSessionId).toBeUndefined();
  expect(isTeam(f.broker.list()[0])).toBe(true);
  expect(validSavedTeam(f.broker.list()[0])).toBe(false);
  const queued = await f.broker.hostCall('mac', {action:'send',teamId:f.team.id,memberId:f.leader.id,to:f.worker.id,operationId:'unavailable',text:'Wait'}) as any;
  await expect(f.broker.hostCall('win', {action:'claim',teamId:f.team.id,memberId:f.worker.id,messageId:queued.id,expectedNativeSessionId:'C'})).rejects.toThrow('unavailable');
  expect(f.snapshot()[0]!.messages.find(message => message.id === queued.id)!.status).toBe('queued');
});


it('reserves bounded recipient evidence before admitting a queue that can later be claimed', async () => {
  const f = await group();
  const nativeSessionId = '\u0000'.repeat(512);
  f.ports.resolveSession = (_host, providerId) => ({ controllerId: '\u0000'.repeat(512), providerId, nativeSessionId });
  const ids: string[] = [];
  for (let index = 0; index < 30; index++) {
    try { const result = await f.broker.hostCall('mac', {action:'send',teamId:f.team.id,memberId:f.leader.id,to:f.worker.id,operationId:`bounded-${index}`,text:'x'.repeat(16000)}) as any; ids.push(result.id); }
    catch { break; }
  }
  expect(ids.length).toBeGreaterThan(0);
  for (const messageId of ids) {
    await f.broker.hostCall('win', {action:'claim',teamId:f.team.id,memberId:f.worker.id,messageId,expectedNativeSessionId:nativeSessionId});
    expect(Buffer.byteLength(JSON.stringify(f.snapshot()[0]!.messages))).toBeLessThanOrEqual(128 * 1024);
  }
});


it('limits legacy unresolved recipient blockers to the owning Controller when its anchor route is unavailable', async () => {
  const f = await group();
  const state = f.snapshot();
  state[0]!.messages.push({ id: 'legacy', from: f.leader.id, to: f.worker.id, text: 'Unknown effect', status: 'unknown', createdAt: 1 });
  f.seed(state);
  f.ports.resolveSession = (hostId, providerId, nativeSessionId) => {
    if (nativeSessionId === f.worker.nativeSessionId) throw new Error('Unavailable legacy route');
    return { controllerId: hostId, providerId, nativeSessionId };
  };
  expect(f.broker.hasUnsettledRecipient({ controllerId: 'other', providerId: 'claude', nativeSessionId: 'other-session' })).toBe(false);
  expect(f.broker.hasUnsettledRecipient({ controllerId: 'win', providerId: 'claude', nativeSessionId: 'current-session' })).toBe(true);
});


it.each(['accepted', 'rejected'] as const)('explicitly resolves accepted input without disposition as %s after restart', async outcome => {
  const f = await group();
  const input = { action: 'send' as const, teamId: f.team.id, memberId: f.leader.id, to: f.worker.id, operationId: 'no-disposition', text: 'Inspect once' };
  const sent = await f.broker.hostCall('mac', input) as { id: string };
  const target = { teamId: f.team.id, memberId: f.worker.id, messageId: sent.id };
  const claimed = await f.broker.hostCall('win', { action: 'claim', ...target }) as { resolvedTarget: import('@orchardworks/agent-remote-protocol').NativeSessionRef };
  await f.broker.hostCall('win', { action: 'settle', ...target, outcome: 'accepted' });
  const restored = f.restart();
  expect(restored.hasUnsettledRecipient(claimed.resolvedTarget)).toBe(true);
  expect(await restored.hostCall('mac', input)).toMatchObject({ id: sent.id, status: 'accepted', resolvedTarget: claimed.resolvedTarget });
  await restored.action({ action: 'archive', teamId: f.team.id });
  await restored.hostCall('mac', { action: 'presence', teamId: f.team.id, memberId: f.leader.id, activity: 'idle' });
  await restored.hostCall('win', { action: 'presence', teamId: f.team.id, memberId: f.worker.id, activity: 'idle' });
  expect(restored.list()[0]!.status).toBe('archiving');
  await restored.action({ action: 'resolve_message', teamId: f.team.id, messageId: sent.id, outcome });
  expect(restored.hasUnsettledRecipient(claimed.resolvedTarget)).toBe(false);
  expect(restored.list()[0]!.status).toBe('archived');
  const receipt = f.snapshot()[0]!.deliveryReceipts!.find(item => item.id === sent.id)!;
  expect(receipt).toMatchObject({ status: outcome, resolvedTarget: claimed.resolvedTarget });
  expect(receipt.acceptance).toBe(outcome === 'accepted' ? 'handled' : undefined);
  expect(f.restart().hasUnsettledRecipient(claimed.resolvedTarget)).toBe(false);
});

it('retains legacy compact uncertainty through expiry, count and shared storage pressure', async () => {
  let now = 1;
  const f = await group(fixture(undefined, { now: () => now, ttl: 10 }));
  const team = f.snapshot()[0]!;
  team.messages = [];
  const receipt = { id: 'legacy', from: f.leader.id, to: f.worker.id, status: 'accepted' as const, createdAt: 1, settledAt: 1, fingerprint: deliveryFingerprint({ to: f.worker.id, text: 'Original private body' }) };
  team.deliveryReceipts = [receipt];
  expect(validSavedTeam(team)).toBe(true);
  expect(validSavedTeam({ ...team, unresolvedReceipts: [{ id: receipt.id, from: receipt.from, to: receipt.to, status: receipt.status, createdAt: receipt.createdAt }] })).toBe(false);
  f.seed([team]); now = 25 * 60 * 60 * 1000;
  const restored = f.restart();
  for (let index = 0; index < 205; index++) {
    const sent = await restored.hostCall('mac', { action: 'send', teamId: team.id, memberId: f.leader.id, to: f.worker.id, operationId: `settled-${index}`, text: 'Unrelated input' }) as { id: string };
    const target = { teamId: team.id, memberId: f.worker.id, messageId: sent.id };
    await restored.hostCall('win', { action: 'claim', ...target });
    await restored.hostCall('win', { action: 'settle', ...target, outcome: 'rejected' });
  }
  const saved = f.snapshot();
  expect(saved[0]!.deliveryReceipts!.find(item => item.id === receipt.id)).toEqual(receipt);
  expect(saved[0]!.deliveryReceipts!.length).toBeLessThan(200);
  trimTeamDeliveryReceipts(saved, 1);
  expect(saved[0]!.deliveryReceipts).toEqual([receipt]);
  expect(validSavedTeam(saved[0])).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('Original private body');
});

it('requires recipient-aware participants before replacing a Team role and retains legacy unresolved evidence', async () => {
  const f = await group(); let supported = false;
  f.ports.assertRecipientSupport = hostId => { if (hostId === 'win' && !supported) throw new Error('Update the Controller'); };
  const target = { controllerId: 'win', providerId: 'claude', nativeSessionId: f.worker.nativeSessionId! };
  expect(() => f.broker.assertReplacementSupported(target, 'win')).toThrow('Update the Controller');
  supported = true; expect(() => f.broker.assertReplacementSupported(target, 'win')).not.toThrow();
  const saved = f.snapshot();
  saved[0]!.deliveryReceipts = [{ id: 'legacy', from: f.leader.id, to: f.worker.id, status: 'accepted', createdAt: 1, settledAt: 1, fingerprint: deliveryFingerprint({ to: f.worker.id, text: 'Old input' }) }];
  f.seed(saved); const restarted = f.restart();
  expect(restarted.hasUnsettledRecipient(target)).toBe(true);
  expect(() => restarted.list(false)).toThrow('Update the Controller');
  expect(restarted.hasUnsettledRecipient(target)).toBe(true);
  expect(f.snapshot()[0]!.deliveryReceipts).toEqual(saved[0]!.deliveryReceipts);
}, 10000);
