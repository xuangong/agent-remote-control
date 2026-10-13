import { expect, it } from 'vitest';
import type { Team, TeamSeat } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
function fixture(create?: (seat:TeamSeat)=>Promise<TeamSeat['member']>) {
  let state:Team[]=[], now=100;
  const calls:TeamSeat[]=[];
  const broker=new TeamBroker({read:()=>state,now:()=>++now,assertHost:()=>{},change:async update=>{const draft=structuredClone(state);const result=structuredClone(update(draft));state=draft;return result;},
    createSeat:async(_,seat)=>{calls.push(seat);return create ? create(seat) : {...seat.member,nativeSessionId:`native-${seat.member.id}`,creation:'ready',activity:'idle'};}});
  return {broker,calls};
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
