import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, test } from 'vitest';
import { parseAgentPreparedTextInput, serializeAgentPreparedTextInput, type AgentCapabilities, type AgentSession, type AgentSessionNativeEvidence, type AgentSessionConfig, type ProviderStreamItem, type AgentPreparedTextInput } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer } from '@orchardworks/agent-remote-relay';
import { createAgentHostRuntime, type AgentHostProviderRegistration } from './host.js';
import { SessionSuccessionStore } from './session-succession-store.js';
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
const providers = ['codex', 'claude', 'copilot', 'opencode'];

/** Controlled native ports exercise the actual Host capability path and WebSocket transport. */
class MatrixSession implements AgentSession {
 readonly capabilities:AgentCapabilities={history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,toolApproval:false,planApproval:false}};
 sent:string[]=[]; epoch=0; private stop?:()=>void;
 constructor(readonly providerId:string,readonly id:string,readonly cwd:string,readonly source=false) {}
 async runtimeInfo(){return {providerId:this.providerId,sessionId:this.id,cwd:this.cwd,status:'idle' as const,persistence:{providerId:this.providerId,sessionId:this.id,opaque:'owned-profile'}};}
 async *observe():AsyncIterable<ProviderStreamItem>{
  if(this.source) yield {type:'observation',sourceKey:'source-U',occurredAt:1,delivery:'history',event:{type:'timeline',provider:this.providerId,item:{type:'user_message',text:`Requirement from ${this.providerId}`}}};
  yield {type:'history_boundary'}; await new Promise<void>(resolve=>{this.stop=resolve;});
 }
 async sendMessage(text:string){this.sent.push(text);return {disposition:'started' as const};}
 async respondToInteraction(){}
 async dispose(){this.stop?.();}
 nativeEvidence:AgentSessionNativeEvidence={
  availability:()=>({status:'configured',version:2}),
  inspectReadiness:async()=>({cwd:this.cwd,idle:true,pendingInputs:0,pendingInteractions:0,activeChildren:0}),
  captureValidity:()=>({epoch:this.epoch}) as never,
  isCurrent:token=>(token as unknown as {epoch:number}).epoch===this.epoch,
  prepareInput:async parts=>{
   const text=(parts[0] as {text:string}).text;
   return parseAgentPreparedTextInput(serializeAgentPreparedTextInput({version:2,providerId:this.providerId,nativeSessionId:this.id,inputId:randomUUID(),cwd:this.cwd,
    authority:{kind:'owned-runtime',authorityId:'matrix',namespaceId:this.providerId},parts:[{type:'text',text}],content:{encoding:'utf-8',bytes:Buffer.byteLength(text),sha256:hash(text)},selections:{model:`${this.providerId}-default`}}));
  },
  dispatchInput:async witness=>{this.sent.push(witness.parts[0].text);this.epoch++;return {disposition:'started'};},
  inspectInput:async witness=>({status:'materialized',proof:{version:2,providerId:this.providerId,nativeSessionId:this.id,inputId:witness.inputId,nativeInputId:`native-${witness.inputId}`,cwd:this.cwd,authority:witness.authority,witnessSha256:hash(serializeAgentPreparedTextInput(witness)),contentSha256:witness.content.sha256,nativeSelectionsSha256:hash(JSON.stringify(witness.selections))},execution:{disposition:'started',nativeExecutionId:'turn-1'}}),
 };
}
async function sendOverWebSocket(url: string, agentId: string, text: string, operationId: string, subject = 'owner', content = false) {
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
      payload: { requestId: operationId, operationId, agentId, ...(content ? { content: [{ type: 'text', text }] } : { text }) },
    }));
    return await next(message => (message.type === 'protocol_error' || message.type === 'command_acknowledged')
      && message.payload.requestId === operationId);
  } finally {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(3000) });
    socket.terminate();
    await closed;
  }
}

test.each(providers.flatMap(source=>providers.map(target=>[source,target])))('Host routes %s to %s through the target evidence without copying foreign settings',async(sourceProvider,targetProvider)=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'arc-succession-matrix-')));
 const from={controllerId:'matrix',providerId:sourceProvider,nativeSessionId:'source'};
 const store=new SessionSuccessionStore(join(root,'roles'));await store.ready;
 await store.createRole({id:'role',revision:1,origin:from,current:from,workspace:{controllerId:'matrix',canonicalCwd:root}});
 const sessions=new Map<string,MatrixSession>(), creations:Array<{providerId:string;config:unknown}>=[];
 const key=(providerId:string,id:string)=>`${providerId}:${id}`;
 sessions.set(key(sourceProvider,'source'),new MatrixSession(sourceProvider,'source',root,true));
 const registrations:AgentHostProviderRegistration[]=providers.map(providerId=>({
  adapter:{descriptor:{providerId,displayName:providerId},createSession:async()=>{throw new Error('ordinary create');},resumeSession:async()=>{throw new Error('ordinary resume');},readSessionHistory:async()=>({entries:[]}),
   nativeEvidence:{availability:()=>({status:'configured',version:2}),createEmpty:async config=>{
    creations.push({providerId,config});const session=new MatrixSession(providerId,config.sessionId,root);sessions.set(key(providerId,config.sessionId),session);
    return {status:'created',handle:(await session.runtimeInfo()).persistence};
   }}},
  directory:{providerId,supportsSourceReferences:true,list:()=>[],workspaces:()=>[],create:async()=>{throw new Error('ordinary directory create');},open:async(id,options)=>{
   const session=sessions.get(key(providerId,id));if(!session)throw new Error('missing');
   if(id!=='source')expect(options?.nativeCreation).toEqual({status:'created',handle:(await session.runtimeInfo()).persistence});return session;
  },sessionWorkspace:async()=>root,sourceReferences:async()=>[],setSourceBindingReader:()=>{},close:async()=>{for(const session of sessions.values())if(session.providerId===providerId)await session.dispose();}},
 }));
 const host=createAgentHostRuntime({registrations,succession:{controllerId:'matrix',stateDirectory:root},executionPolicy:{defaultWorkspace:root,allowedWorkspaceRoots:[root],lockPermissions:false}});
 const server=createAgentRemoteHttpServer(host.relay,{websocketAuthorizer:{authenticate:()=>({subject:'owner'}),authorize:()=>true}});
 try {
  const {url}=await server.listen(0);
  const control=async(action:string,body:unknown)=>{const result=await host.control({method:'POST',path:`/remote/succession/${action}`,sessionId:'owner',body:JSON.stringify(body)});return JSON.parse(result.body);};
  const prepared=await control('prepare',{operationId:'handoff',roleId:'role',expectedRevision:1,from,targetProviderId:targetProvider});
  expect(prepared.phase,JSON.stringify(prepared)).toBe('ready');
  expect(creations).toHaveLength(1);expect(creations[0]?.providerId).toBe(targetProvider);
  expect(creations[0]?.config).toEqual({sessionId:prepared.to.nativeSessionId,cwd:root,...(sourceProvider===targetProvider?{selectionSourceSessionId:'source'}:{})});
  expect((await control('commit',{operationId:'handoff',expectedRevision:1})).phase).toBe('committed');
  expect([...sessions.values()].flatMap(session=>session.sent)).toEqual([]);
  const attached=JSON.parse((await host.control({method:'POST',path:'/remote/attach',sessionId:'owner',body:JSON.stringify({providerId:targetProvider,nativeSessionId:prepared.to.nativeSessionId})})).body);
  const operationId=randomUUID();
  expect((await sendOverWebSocket(url,attached.agentId,'Continue the task',operationId)).type).toBe('command_acknowledged');
  const candidate=sessions.get(key(targetProvider,prepared.to.nativeSessionId))!;
  expect(candidate.sent).toHaveLength(1);expect(candidate.sent[0]).toContain(`Requirement from ${sourceProvider}`);expect(candidate.sent[0]).toContain('Continue the task');
  expect((await control('reconcile',{operationId:'handoff'})).materialized).toBe(true);
  await sendOverWebSocket(url,attached.agentId,'Continue the task',operationId);
  expect(candidate.sent).toHaveLength(1);expect(creations).toHaveLength(1);
 } finally {await server.close();await host.close();await rm(root,{recursive:true,force:true});}
},10000);
