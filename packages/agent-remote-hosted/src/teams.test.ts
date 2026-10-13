import { expect, it } from 'vitest';
import type { Team, TeamSeat } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { PortableTeamResourceStore, type TeamResourceStorage } from './team-resources.js';
import { createHash } from 'node:crypto';
function fixture(create?: (seat:TeamSeat)=>Promise<TeamSeat['member']>, lifetime?: {now:()=>number;ttl:number}) {
  const rows=new Map<string,Uint8Array>();const storage:TeamResourceStorage={async get(key){return rows.get(key);},async put(key,value){rows.set(key,value);},async delete(key){rows.delete(key);},async list(prefix){return [...rows.keys()].filter(key=>key.startsWith(prefix));}};
  const resources=new PortableTeamResourceStore({storage,...(lifetime?{now:lifetime.now,draftTtlMs:lifetime.ttl}:{})});
  let state:Team[]=[], now=100;
  const calls:TeamSeat[]=[];
  const ports:ConstructorParameters<typeof TeamBroker>[0]={resources,resourceDraftTtlMs:lifetime?.ttl,read:()=>state,now:lifetime?.now??(()=>++now),assertHost:()=>{},change:async update=>{const draft=structuredClone(state);const result=structuredClone(update(draft));state=draft;return result;},
    createSeat:async(_,seat)=>{calls.push(seat);return create ? create(seat) : {...seat.member,nativeSessionId:`native-${seat.member.id}`,creation:'ready',activity:'idle'};}};
  const broker=new TeamBroker(ports);
  return {broker,calls,restart:()=>new TeamBroker({...ports,resources:new PortableTeamResourceStore({storage,...(lifetime?{now:lifetime.now,draftTtlMs:lifetime.ttl}:{})})})};
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
  const stopping=await broker.action({teamId:team.id,action:'archive'});expect(stopping.status).toBe('archiving');expect(stopping.messages.every(message => message.status === 'canceled')).toBe(true);
  await expect(broker.hostCall('mac',{action:'send',teamId:team.id,memberId:leader.id,to:worker.id,operationId:'new',text:'Again'})).rejects.toThrow('not active');
  await broker.hostCall('mac',{action:'presence',teamId:team.id,memberId:leader.id,activity:'idle'});
  expect(broker.list()[0]!.status).toBe('archiving');
  await broker.hostCall('win',{action:'presence',teamId:team.id,memberId:worker.id,activity:'idle'});
  expect(broker.list()[0]!.status).toBe('archived');
  await broker.action({teamId:team.id,action:'restore'});expect(broker.list()[0]!.messages[0]!.status).toBe('canceled');
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
  await broker.hostCall('mac',{teamId:team.id,memberId:leader.id,action:'send',to:worker.id,operationId:'send',text:'Inspect',resources:[kept.resourceId]});
  now=11;
  await expect(broker.hostCall('mac',{action:'resource_metadata',teamId:team.id,memberId:leader.id,resourceId:draft.resourceId})).rejects.toThrow('access');
  expect(await broker.hostCall('win',{action:'resource_metadata',teamId:team.id,memberId:worker.id,resourceId:kept.resourceId})).toMatchObject({sha256});
  const replacement=await upload('replacement');
  expect(broker.list()[0]!.resourceUploads?.map(item=>item.resource.resourceId)).toEqual([kept.resourceId,replacement.resourceId]);
});
