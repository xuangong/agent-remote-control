import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage, type TpmWork } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer } from '@orchardworks/agent-remote-relay';
import type { AgentSession, AgentSessionConfig, AgentCapabilities, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime } from './host.js';
import { SessionSuccessionStore } from './session-succession-store.js';
const ref=(nativeSessionId:string)=>({controllerId:'controller',providerId:'fixture',nativeSessionId});
class Native implements AgentSession {
 capabilities:AgentCapabilities={history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,toolApproval:false,planApproval:false}};
 constructor(readonly id:string,readonly cwd:string){}
 async runtimeInfo(){return {providerId:'fixture',sessionId:this.id,status:'idle' as const,cwd:this.cwd};}
 sent:string[]=[];private stop?:()=>void;
 async *observe():AsyncIterable<ProviderStreamItem>{if(this.id==='A') yield {type:'observation',sourceKey:'history-user',occurredAt:1,delivery:'history',event:{type:'timeline',provider:'fixture',item:{type:'user_message',text:'Original requirement'}}};yield {type:'history_boundary'};await new Promise<void>(resolve=>{this.stop=resolve;});}
 async sendMessage(text:string){this.sent.push(text);return {disposition:'queued' as const};}
 async respondToInteraction(){}
 async dispose(){this.stop?.();}
}
async function fixture(enableTpm=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),'arc-succession-runtime-')));
 const store=new SessionSuccessionStore(join(root,'roles'));await store.ready;
 await store.createRole({id:'role',revision:1,origin:ref('A'),current:ref('A'),workspace:{controllerId:'controller',canonicalCwd:root}});
 const sessions=new Map([['A',new Native('A',root)]]);const tpmConfigurations:AgentSessionConfig[]=[];let creates=0,supported=true,busy='';
 const host=createAgentHostRuntime({...(enableTpm?{tpm:{stateDirectory:join(root,'tpm'),tickMs:20}}:{}),succession:{controllerId:'controller',stateDirectory:root,native:{
 supports:async()=>supported,
 inspect:async source=>({cwd:root,idle:source.nativeSessionId!==busy,managed:true,pendingInputs:0,pendingInteractions:0,activeChildren:0}),
 createIdle:async()=>{creates++;sessions.set('B',new Native('B',root));return ref('B');},reconcileDelivery:async()=>undefined,
 }},registrations:[{adapter:{descriptor:{providerId:'fixture',displayName:'Fixture',...(enableTpm?{sessionExtensions:{instructions:true,tools:true}}:{})},createSession:async()=>{throw new Error('unexpected');},resumeSession:async()=>{throw new Error('unexpected');},readSessionHistory:async()=>({entries:[]})},directory:{providerId:'fixture',list:()=>[],workspaces:()=>[],create:async config=>{if(!enableTpm)throw new Error('unexpected');tpmConfigurations.push(config);const id=`tpm-${tpmConfigurations.length}`;sessions.set(id,new Native(id,root));return id;},open:async id=>sessions.get(id)!,sessionWorkspace:async()=>root,sourceReferences:async()=>[],setSourceBindingReader:()=>{},close:async()=>{await Promise.all([...sessions.values()].map(session=>session.dispose()));}}}]});
 const server=createAgentRemoteHttpServer(host.relay,{websocketAuthorizer:{authenticate:()=>({subject:'owner'}),authorize:()=>true}});const address=await server.listen(0);
 const control=async(action:string,body:unknown)=>{const result=await host.control({method:'POST',path:`/remote/succession/${action}`,sessionId:'owner',body:JSON.stringify(body)});return {status:result.status,payload:JSON.parse(result.body)};};
 return {root,sessions,host,tpmConfigurations,control,attach:async(id:string)=>JSON.parse((await host.control({method:'POST',path:'/remote/attach',sessionId:id,body:JSON.stringify({providerId:'fixture',nativeSessionId:id})})).body),url:address.url,creates:()=>creates,unsupported:()=>{supported=false;},busy:(id:string)=>{busy=id;},close:async()=>{await server.close();await host.close();await rm(root,{recursive:true,force:true});}};
}
const request={operationId:'handoff',roleId:'role',expectedRevision:1,from:ref('A')};
/** Each send uses a fresh authenticated connection and closes it before returning. */
async function sendOverWebSocket(url: string, agentId: string, text: string, operationId: string, subject = 'owner') {
  const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events`, {
    headers: { 'x-test-subject': subject },
  });
  const messages: ServerMessage[] = [];
  const listeners = new Set<() => void>();
  socket.on('message', data => {
    messages.push(JSON.parse(data.toString()));
    for (const listener of listeners) listener();
  });
  const next = (matches: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error('Session response deadline exceeded.'));
    }, 3000);
    function check() {
      const index = messages.findIndex(matches);
      if (index < 0) return;
      clearTimeout(timer);
      listeners.delete(check);
      resolve(messages.splice(index, 1)[0]!);
    }
    listeners.add(check);
    check();
  });
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
    await next(message => message.type === 'agent_snapshot');
    const state = await next(message => message.type === 'session_control');
    if (state.type !== 'session_control') throw new Error('Missing control state');
    socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, type: 'session_control_request',
      payload: { agentId, requestId: 'control', action: 'take_over', revision: state.payload.revision },
    }));
    const granted = await next(message => message.type === 'session_control' && message.payload.requestId === 'control');
    if (granted.type !== 'session_control') throw new Error('Missing control grant');
    socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, type: 'send_message', controlToken: granted.payload.token,
      payload: { requestId: operationId, operationId, agentId, text },
    }));
    return await next(message => (message.type === 'protocol_error' || message.type === 'command_acknowledged')
      && message.payload.requestId === operationId);
  } finally {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(3000) });
    socket.terminate();
    await closed;
  }
}

test('real Host prepares and commits without execution then dispatches its first WebSocket input',async()=>{
 const f=await fixture();try{
 const prepared=await f.control('prepare',request);expect(prepared).toMatchObject({status:200,payload:{phase:'ready',to:ref('B')}});
 expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
 expect(await f.control('commit',{operationId:'handoff',expectedRevision:1})).toMatchObject({status:200,payload:{phase:'committed'}});
 const attached=await f.attach('B');
 const ack=await sendOverWebSocket(f.url,attached.agentId,'continue','00000000-0000-4000-8000-000000000001');expect(ack).toMatchObject({type:'command_acknowledged',payload:{inputAcceptance:{disposition:'queued'}}});
 expect(f.sessions.get('B')!.sent[0]).toContain('quoted conversation history');expect(f.sessions.get('B')!.sent[0]).toContain('continue');expect(f.sessions.get('B')!.sent[0]).toContain('Original requirement');
 expect(await f.control('reconcile',{operationId:'handoff'})).toMatchObject({status:200,payload:{materialized:false}});
 }finally{await f.close();}
},15000);
test('unsupported pair and a busy source fail before idle candidate creation',async()=>{
 const f=await fixture();try{f.unsupported();expect((await f.control('prepare',request)).payload.phase).toBe('rejected');expect(f.creates()).toBe(0);}finally{await f.close();}
 const g=await fixture();try{g.busy('A');expect((await g.control('prepare',request)).payload.phase).toBe('rejected');expect(g.creates()).toBe(0);}finally{await g.close();}
},15000);
test('a busy candidate prevents readiness and later source work prevents commit',async()=>{
 const f=await fixture();try{f.busy('B');expect((await f.control('prepare',request)).payload.phase).toBe('rejected');expect(f.creates()).toBe(1);expect(f.sessions.get('B')!.sent).toEqual([]);}finally{await f.close();}
 const g=await fixture();try{expect((await g.control('prepare',request)).payload.phase).toBe('ready');g.busy('A');expect((await g.control('commit',{operationId:'handoff',expectedRevision:1})).status).toBe(409);}finally{await g.close();}
},15000);

test('real Host TPM first postcommit main input consumes durable context once and preserves its own session',async()=>{
  const f=await fixture(true);
  try {
    const created=await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'create-tpm',requirement:'Track the original requirement'})});
    expect(created.status).toBe(200);
    const work=JSON.parse(created.body) as TpmWork;
    const current=async()=>JSON.parse((await f.host.control({method:'GET',path:`/remote/tpm/work?id=${work.id}`})).body) as TpmWork;
    await expect.poll(async()=>(await current()).outbox?.[0]?.status).toBe('accepted');
    const tpmId=work.tpmNativeSessionId!; const tools=f.tpmConfigurations[0]!.tools!;
    const call=async(name:string,input:unknown)=>JSON.parse(await tools.find(tool=>tool.name===name)!.execute(input));
    const todo=(await current()).todo!;
    await call('update_todo_step',{revision:todo.revision,stepId:todo.steps[0]!.id,status:'in_progress',note:'Clarifying the approved work'});
    expect(await f.control('prepare',request)).toMatchObject({status:200,payload:{phase:'ready',to:ref('B')}});
    const contextFile=join(f.root,'contexts','context.json');
    const context=async()=>JSON.parse(await readFile(contextFile,'utf8')).attachments[0];
    const captured=await context();
    expect(captured).toMatchObject({state:'pending',target:ref('B'),roleRevision:2,deliveries:[]});
    expect(captured.text).toContain('Original requirement');
    expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
    expect(await f.control('commit',{operationId:'handoff',expectedRevision:1})).toMatchObject({status:200,payload:{phase:'committed'}});
    expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
    const input={operationId:'postcommit-consultation',todoStepId:todo.steps[0]!.id,purpose:'consultation',text:'Assess the next concrete step'};
    const intent=await call('send_main_message',input);
    await expect.poll(async()=>(await current()).outbox?.find(item=>item.id===intent.id)?.status).not.toMatch(/^(prepared|dispatching)$/);
    const observed=await current(); const settled=observed.outbox!.find(item=>item.id===intent.id)!;
    expect(settled.status,JSON.stringify({error:settled.error,health:observed.health})).toBe('accepted');
    const sent=f.sessions.get('B')!.sent;
    expect(sent).toHaveLength(1);expect(sent[0]).toContain('quoted conversation history');
    expect(sent[0]).toContain(captured.text);expect(sent[0]).toContain(input.text);
    const persisted=JSON.parse(await readFile(join(f.root,'tpm',`${work.id}.json`),'utf8'));
    expect(persisted.work.tpmNativeSessionId).toBe(tpmId);
    expect(persisted.work.outbox.find((item:{id:string})=>item.id===intent.id)).toMatchObject({status:'accepted',resolvedTarget:ref('B'),roleRevision:2});
    const executionHash=createHash('sha256').update(JSON.stringify(['host:tpm',intent.id])).digest('hex');
    const executionId=`${executionHash.slice(0,8)}-${executionHash.slice(8,12)}-8${executionHash.slice(13,16)}-${((parseInt(executionHash[16]!,16)&3)|8).toString(16)}${executionHash.slice(17,20)}-${executionHash.slice(20,32)}`;
    expect(await context()).toMatchObject({state:'accepted',deliveries:[{operationId:createHash('sha256').update(JSON.stringify(['host:tpm',executionId])).digest('hex'),target:ref('B'),roleRevision:2,includesContext:true}]});
    expect(await call('send_main_message',input)).toMatchObject({id:intent.id,status:'accepted'});
    expect(f.sessions.get('B')!.sent).toHaveLength(1);expect(f.sessions.get('A')!.sent).toEqual([]);
    expect(f.tpmConfigurations).toHaveLength(1);expect((await current()).tpmNativeSessionId).toBe(tpmId);
  } finally { await f.close(); }
},15000);
