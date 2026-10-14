import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import type { AgentSession, AgentRuntimeInfo, AgentCapabilities, AgentSessionExtensions, AgentMessageOptions, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createRemoteHostBroker } from '../../agent-remote-lab/src/server/remote-host-broker.js';
import { createAgentHost, type AgentHostDirectory } from './host.js';
import { PortableTeamResourceStore } from '../../agent-remote-hosted/src/team-resources.js';
import { createHash } from 'node:crypto';

class NativeSession implements AgentSession {
  capabilities: AgentCapabilities = {history:true,sendMessage:true,queueMessage:false,steer:false,cancel:false,readResource:false,interactions:{question:false,toolApproval:false,planApproval:false}};
  sent:string[]=[]; failReceipt=false; queued=false; voidReceipt=false; acceptance?:AgentMessageOptions['onAcceptance']; status:'idle'|'running'='idle'; closed=false; sequence=0;
  private events:ProviderStreamItem[]=[{type:'history_boundary'}]; private wake?:()=>void;
  constructor(readonly id:string,readonly cwd:string){}
  async *observe(){while(!this.closed){if(this.events.length)yield this.events.shift()!;else await new Promise<void>(resolve=>{this.wake=resolve;});}}
  async runtimeInfo():Promise<AgentRuntimeInfo>{return {providerId:'fixture',sessionId:this.id,cwd:this.cwd,status:this.status,persistence:{providerId:'fixture',sessionId:this.id,opaque:'{}'}};}
  async sendMessage(text:string, options?:AgentMessageOptions){this.acceptance=options?.onAcceptance;this.sent.push(text);this.status='running';this.emit({type:'turn_started',provider:'fixture',turnId:'turn'});this.emit({type:'runtime_updated',provider:'fixture',runtimeInfo:await this.runtimeInfo(),activeTurnId:'turn'});if(this.failReceipt)throw new Error('Native receipt lost');if(this.voidReceipt)return;return {disposition:this.queued ? 'queued' as const : 'started' as const};}
  emit(event:any){this.events.push({type:'observation',sourceKey:String(++this.sequence),delivery:'live',occurredAt:Date.now(),event});this.wake?.();}
  async finish(){if(this.queued){this.acceptance?.({disposition:'started'});this.queued=false;}this.status='idle';this.emit({type:'turn_completed',provider:'fixture',turnId:'turn'});this.emit({type:'runtime_updated',provider:'fixture',runtimeInfo:await this.runtimeInfo(),activeTurnId:null});}
  async respondToInteraction(){}
  async dispose(){this.closed=true;this.wake?.();}
}
it('registers two real Host uplinks, injects scoped tools, delivers both ways without a browser and archives after native idle',async()=>{
  const root=await mkdtemp(join(tmpdir(),'arc-team-'));
  const resourceRows=new Map<string,Uint8Array>();const teamResources=new PortableTeamResourceStore({storage:{async get(key){return resourceRows.get(key);},async put(key,value){resourceRows.set(key,value);},async delete(key){resourceRows.delete(key);},async list(prefix){return [...resourceRows.keys()].filter(key=>key.startsWith(prefix));}}});
  const server=createServer(), broker=createRemoteHostBroker({teamResources,origin:'http://127.0.0.1:6175',ownerSubject:'owner',principalSubject:()=> 'owner'});
  broker.install(server);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{signal:AbortSignal.timeout(5000),...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(`${response.status}: ${JSON.stringify(value)}`);return value;};
  const hosts:Array<ReturnType<typeof createAgentHost>>=[];
  async function host(name:string){
    const sessions=new Map<string,NativeSession>(), extensions=new Map<string,AgentSessionExtensions>();
    const directory:AgentHostDirectory={providerId:'fixture',list:()=>[],workspaces:()=>[],
      async create(input){const id=`${name}-${sessions.size}`;sessions.set(id,new NativeSession(id,input.cwd ?? root));extensions.set(id,input);return id;},
      async open(id,options){if(options?.extensions)extensions.set(id,options.extensions);let session=sessions.get(id);if(!session||session.closed){session=new NativeSession(id,root);sessions.set(id,session);}return session;},
      async close(){await Promise.all([...sessions.values()].map(session=>session.dispose()));}};
    let key=(await request('/v1/remote/pairings',{})).key;
    const start=()=>createAgentHost({installationId:name,name,team:{stateDirectory:join(root,name),tickMs:20},registrations:[{directory,adapter:{descriptor:{providerId:'fixture',displayName:'Fixture',sessionExtensions:{instructions:true,tools:true}},async createSession(){throw new Error('Use directory');},async resumeSession(){throw new Error('Use directory');}}}],uplink:{url:base.replace('http:','ws:')+'/ws/remote-host',remoteKey:key,onCredential:async value=>{key=value;}}});
    let instance=start();
    hosts.push(instance);return {instance,sessions,extensions,id:(await instance.ready).hostId,async restart(){await instance.close();instance=start();hosts.push(instance);await instance.ready;}};
  }
  try{
    const mac=await host('mac'),win=await host('win');
    const team=await request('/v1/remote/teams/create',{operationId:'create-team',source:{hostId:mac.id,providerId:'fixture',nativeSessionId:'source',title:'Main project'}});
    expect(team.members[0].creation).toBe('ready');const leader=team.members[0];
    expect(mac.extensions.get('source')).toBeUndefined();
    expect(mac.extensions.get(leader.nativeSessionId)?.instructions).toContain('implement directly');
    const updated=await request('/v1/remote/teams/action',{teamId:team.id,action:'add_member',operationId:'windows',hostId:win.id,providerId:'fixture',name:'Windows diagnosis',cwd:root,responsibility:'Inspect logs only'});
    const member=updated.members[1];expect(member.creation).toBe('ready');
    await expect.poll(()=>mac.sessions.get(leader.nativeSessionId)?.sent.length,{timeout:5000}).toBe(1);
    expect(mac.sessions.get(leader.nativeSessionId)?.sent[0]).toContain('member registered');
    await mac.sessions.get(leader.nativeSessionId)!.finish();
    const call=async(target:typeof mac,nativeId:string,name:string,args:unknown)=>JSON.parse(await target.extensions.get(nativeId)!.tools!.find(tool=>tool.name===name)!.execute(args));
    expect(win.extensions.get(member.nativeSessionId)?.tools?.some(tool=>tool.name==='describe_team_member')).toBe(false);
    win.sessions.get(member.nativeSessionId)!.voidReceipt=true;
    const fixtureBytes=process.env.TEAM_RESOURCE_FIXTURE_PATH ? await readFile(process.env.TEAM_RESOURCE_FIXTURE_PATH) : Buffer.alloc(4*1024*1024+32768,93),fixturePath=join(root,'fixture.zip');await writeFile(fixturePath,fixtureBytes);
    const resource=await call(mac,leader.nativeSessionId,'upload_team_resource',{path:fixturePath,operationId:'fixture-upload'});
    expect(resource.sha256).toBe(createHash('sha256').update(fixtureBytes).digest('hex'));
    await expect(call(win,member.nativeSessionId,'download_team_resource',{resourceId:resource.resourceId})).rejects.toThrow('access');
    const task={to:member.id,operationId:'diagnose-1',text:'Read service logs and report the failing component.',resources:[resource.resourceId]};
    await call(mac,leader.nativeSessionId,'send_team_message',task);
    await expect.poll(()=>win.sessions.get(member.nativeSessionId)?.sent.length,{timeout:5000}).toBe(1);
    await call(mac,leader.nativeSessionId,'send_team_message',task);
    expect(win.sessions.get(member.nativeSessionId)?.sent).toHaveLength(1);
    expect(win.sessions.get(member.nativeSessionId)?.sent[0]).toContain('[resource #1]');
    const local=await call(win,member.nativeSessionId,'download_team_resource',{resourceId:resource.resourceId});expect(await readFile(local.localPath)).toEqual(fixtureBytes);
    const reportPath=join(root,'report.json');await writeFile(reportPath,JSON.stringify({sha256:resource.sha256,verified:true}));
    const reportResource=await call(win,member.nativeSessionId,'upload_team_resource',{path:reportPath,operationId:'report-upload'});
    expect(mac.sessions.get('source')?.sent).toHaveLength(0);
    await expect.poll(async()=> (await request('/v1/remote/teams')).teams[0].messages.some((message:any)=>message.text===task.text),{timeout:5000}).toBe(false);
    expect((await call(mac,leader.nativeSessionId,'read_team',{})).receipts).toEqual(expect.arrayContaining([expect.objectContaining({to:member.id,status:'accepted'})]));
    await call(win,member.nativeSessionId,'send_team_message',{to:leader.id,operationId:'result-1',text:'Evidence: the service is disabled.',resources:[reportResource.resourceId]});
    await expect.poll(()=>mac.sessions.get(leader.nativeSessionId)?.sent.length,{timeout:5000}).toBe(2);
    const returned=await call(mac,leader.nativeSessionId,'download_team_resource',{resourceId:reportResource.resourceId});expect(JSON.parse(await readFile(returned.localPath,'utf8'))).toEqual({sha256:resource.sha256,verified:true});
    await win.sessions.get(member.nativeSessionId)!.finish();
    win.sessions.get(member.nativeSessionId)!.failReceipt=true;
    await call(mac,leader.nativeSessionId,'send_team_message',{...task,operationId:'uncertain-task'});
    await expect.poll(async()=> (await request('/v1/remote/teams')).teams[0].messages.find((message:any)=>message.text===task.text&&message.status==='unknown')?.status,{timeout:5000}).toBe('unknown');
    await win.restart();
    await expect.poll(()=>win.sessions.get(member.nativeSessionId)?.closed,{timeout:5000}).toBe(false);
    expect(win.sessions.get(member.nativeSessionId)?.sent).toHaveLength(0);
    const uncertain=(await request('/v1/remote/teams')).teams[0].messages.find((message:any)=>message.status==='unknown');
    await request('/v1/remote/teams/action',{teamId:team.id,action:'resolve_message',messageId:uncertain.id,outcome:'accepted'});
    const winSession=win.sessions.get(member.nativeSessionId)!;winSession.voidReceipt=false;winSession.queued=true;
    await call(mac,leader.nativeSessionId,'send_team_message',{...task,operationId:'queued-final',text:'Final queued check'});
    await expect.poll(async()=> (await request('/v1/remote/teams')).teams[0].messages.find((message:any)=>message.text==='Final queued check')?.acceptance,{timeout:5000}).toBe('queued');
    let stopping=await request('/v1/remote/teams/action',{teamId:team.id,action:'archive'});expect(stopping.status).toBe('archiving');
    await expect(call(mac,leader.nativeSessionId,'send_team_message',{...task,operationId:'too-late'})).rejects.toThrow('not active');
    await win.sessions.get(member.nativeSessionId)!.finish();await mac.sessions.get(leader.nativeSessionId)!.finish();
    await expect.poll(async()=> (await request('/v1/remote/teams')).teams[0].status,{timeout:5000}).toBe('archived');
  }finally{await Promise.all(hosts.map(host=>host.close()));await broker.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
},20000);
