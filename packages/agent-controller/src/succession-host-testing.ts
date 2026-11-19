/**
 * Test support: a Controller Host over a scripted native provider, for the rules of session succession.
 *
 * Purpose. `successionHostFixture` builds a real `createAgentHostRuntime` whose succession, context and TPM stores keep their files in
 * memory (`stateFiles`, shared by every restart of the Host in one test) and whose native provider is a script: `Native`, `EvidenceNative`
 * and `PromptNative` are the provider sessions, and the flags it returns (`unsupported`, `busy`, `loseSourceCreation`, the `before*`
 * hooks) place a failure at one step. `sendOverWebSocket` sends one message through the Host's own HTTP server like a browser would, over in-memory sockets (`memoryHttp`: real HTTP parsing and WebSocket framing, no port).
 * Nothing here starts a Relay; a Relay is joined by the caller (see `agent-remote-seams` S2).
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { memoryStateFiles } from './memory-state-files.js';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer } from '@orchardworks/agent-session-runtime';
import { memoryHttp, type MemoryHttp } from '@orchardworks/agent-session-runtime/testing';
import type { AgentSession, AgentSessionConfig, AgentCapabilities, AgentInputAcceptance, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { parseAgentPreparedTextInput, serializeAgentPreparedTextInput, AGENT_NATIVE_EVIDENCE_REASONS, type AgentSessionNativeEvidence, type AgentEmptyCreationResult } from '@orchardworks/agent-provider-sdk';
import { directoryOperationId } from './directory-mutation.js';
import { createAgentHostRuntime } from './host.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { TpmStore } from './tpm-store.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';

/** The Host's own succession classes, for a test that places a failure inside one of them. */
export { SessionSuccessionStore, SessionSuccessionCoordinator, SessionSuccessionBoundary, TpmStore };
export const ref=(nativeSessionId:string)=>({controllerId:'controller',providerId:'fixture',nativeSessionId});
export class Native implements AgentSession {
 capabilities:AgentCapabilities={history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,toolApproval:false,planApproval:false}};
 constructor(readonly id:string,readonly cwd:string,readonly providerId='fixture'){}
 async runtimeInfo(){return {providerId:this.providerId,sessionId:this.id,status:'idle' as const,cwd:this.cwd};}
 sent:string[]=[];cancels=0;disposals=0;async cancel(){this.cancels++;}private stop?:()=>void;
 async *observe():AsyncIterable<ProviderStreamItem>{if(this.id==='A') yield {type:'observation',sourceKey:'history-user',occurredAt:1,delivery:'history',event:{type:'timeline',provider:'fixture',item:{type:'user_message',text:'Original requirement'}}};yield {type:'history_boundary'};await new Promise<void>(resolve=>{this.stop=resolve;});}
 async sendMessage(text:string):Promise<AgentInputAcceptance | void>{this.sent.push(text);return {disposition:'queued' as const};}
 async respondToInteraction(){}
 async dispose(){this.disposals++;this.stop?.();}
}
export class EvidenceNative extends Native {
 override async runtimeInfo(){return {...await super.runtimeInfo(), persistence:{providerId:this.providerId,sessionId:this.id,opaque:'original complete handle'}};}
 epoch = 0; preparations = 0; inspections = 0; captures = 0; dispatches = 0; materialized = false; unresolved = false;
 dispatchFailure = false; afterInspect = () => {}; beforeCapture = () => {};
 nativeEvidence: AgentSessionNativeEvidence = {
  availability: () => ({ status: 'configured', version: 2 }),
  inspectReadiness: async () => ({ cwd: this.cwd, idle: !this.unresolved, pendingInputs: this.unresolved ? 1 : 0, pendingInteractions: 0, activeChildren: 0 }),
  captureValidity: () => { this.beforeCapture(); this.captures++; if (this.unresolved) throw new Error('unresolved native input'); return { epoch: this.epoch } as never; },
  isCurrent: token => (token as unknown as {epoch:number}).epoch === this.epoch,
  prepareInput: async (parts, options) => {
   this.preparations++; const text=(parts[0] as {text:string}).text;
   return parseAgentPreparedTextInput(serializeAgentPreparedTextInput({ version: 2, providerId:this.providerId,nativeSessionId:this.id,inputId:`U-${this.preparations}`,cwd:this.cwd,
    authority:{kind:'trusted-service' as const,authorityId:'authority',namespaceId:'store'},parts:[{type:'text',text}],content:{encoding:'utf-8',bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')},
    selections:{model:'provider/model',agent:'agent',...(options?.delivery ? {delivery:'immediate' as const} : {})} }));
  },
  dispatchInput: async witness => { this.dispatches++;this.sent.push(witness.parts[0].text);this.unresolved=true;this.epoch++;if(this.dispatchFailure)throw new Error('response lost'); },
  inspectInput: async witness => {
   this.inspections++;this.afterInspect();
   if(!this.materialized)return {status:'unknown',code:'native_evidence_readback_missing',reason:AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_readback_missing};
   const {delivery:_delivery,...selections}=witness.selections;
   return {status:'materialized',proof:{version: 2, providerId:this.providerId,nativeSessionId:this.id,inputId:witness.inputId,nativeInputId:witness.inputId,cwd:this.cwd,authority:witness.authority,
    witnessSha256:createHash('sha256').update(serializeAgentPreparedTextInput(witness)).digest('hex'),contentSha256:witness.content.sha256,nativeSelectionsSha256:createHash('sha256').update(JSON.stringify(selections)).digest('hex')}};
  },
 };
 override async dispose(){this.epoch++;await super.dispose();}
}
export class PromptNative extends Native {
 epoch = 0; baselined = false; captures = 0;
 override async runtimeInfo(){return {...await super.runtimeInfo(), persistence:{providerId:this.providerId,sessionId:this.id,opaque:'original prefix handle'}};}
 promptEditEvidence = {
  version: 1 as const,
  inspectReadiness: async () => { this.baselined = true; return {cwd:this.cwd,idle:true,pendingInputs:0,pendingInteractions:0,activeChildren:0}; },
  captureValidity: () => { if (!this.baselined) throw new Error('readiness baseline required'); this.captures++; return {epoch:this.epoch} as never; },
  isCurrent: (token: unknown) => (token as {epoch:number}).epoch === this.epoch,
 };
 override async dispose(){this.epoch++;await super.dispose();}
}
/** The role, context and TPM state of a Host, in memory. */
export interface SuccessionHostFiles { roles: ReturnType<typeof memoryStateFiles>; contexts: ReturnType<typeof memoryStateFiles>; tpm: ReturnType<typeof memoryStateFiles> }
export async function successionHostFixture(enableTpm=false,enrollment=false,setup?:(root:string,files:SuccessionHostFiles)=>Promise<void>, snapshots=false,evidence=false,policy=false,prefix=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),'arc-succession-runtime-')));
 const stateFiles:SuccessionHostFiles={roles:memoryStateFiles(),contexts:memoryStateFiles(),tpm:memoryStateFiles()};
 const store=new SessionSuccessionStore(join(root,'roles'),stateFiles.roles);await store.ready;
 if(!enrollment) await store.createRole({id:'role',revision:1,origin:ref('A'),current:ref('A'),workspace:{controllerId:'controller',canonicalCwd:root}});
 const grants:Array<{nativeSessionId:string;sourceNativeSessionId:string}>=[];let beforeGrants=async()=>{};
 await setup?.(root,stateFiles);
 const sessions=new Map<string,Native>([['A',prefix?new PromptNative('A',root):evidence?new EvidenceNative('A',root):new Native('A',root)]]);const tpmConfigurations:Array<Omit<AgentSessionConfig,"sessionId">>=[];const snapshotConfigurations:Array<Omit<AgentSessionConfig,"sessionId">>=[];let creates=0,sourceCreates=0,supported=true,bounded=true,coverage=true,busy='',loseTpmCreation=false,loseSourceCreation=false;let beforeSourceCreate=async()=>{};let beforeIdleCreate=async()=>{};
 let prefixForks=0,prefixVerifications=0; let onPrefixVerify=async()=>{}; const prefixHandles:unknown[]=[];
 const creationOptions: unknown[]=[],resumeOptions: unknown[]=[],workspaceReads:string[]=[];let evidenceCreates=0,allowIdleRelease=false;let creationResult: AgentEmptyCreationResult | undefined; let beforeNativeInspect=async(_id:string)=>{};
 const providerEvidence = evidence ? { availability:()=>({status:'configured' as const,version:2 as const}),async createEmpty(config:Pick<AgentSessionConfig,'sessionId'|'cwd'>):Promise<AgentEmptyCreationResult>{evidenceCreates++;assert.deepStrictEqual(config,{sessionId:directoryOperationId('handoff:create'),cwd:root,selectionSourceSessionId:'A'});await beforeIdleCreate();sessions.set('B',new EvidenceNative('B',root));return creationResult ?? {status:'created',handle:{providerId:'fixture',sessionId:'B',opaque:'original complete handle'}};} } : undefined;
 const otherSession = new Native('other-A', root, 'other');
 const additional = snapshots ? [{adapter:{descriptor:{providerId:'other',displayName:'Other'},createSession:async()=>{throw new Error('unexpected');},resumeSession:async()=>{throw new Error('unexpected');},readSessionHistory:async()=>({entries:[]})},directory:{providerId:'other',list:()=>[],workspaces:()=>[],create:async()=>{throw new Error('unexpected');},open:async(id:string)=>{if(id!=='other-A')throw new Error('missing source');return otherSession;},sessionWorkspace:async(id:string)=>{if(id!=='other-A')throw new Error('missing source');return root;},sourceReferences:async()=>[],setSourceBindingReader:()=>{},close:()=>otherSession.dispose()}}] : [];
 const createHost=()=>createAgentHostRuntime({...(evidence?{idleGraceMs:20}:{}),...(policy?{executionPolicy:{defaultWorkspace:root,allowedWorkspaceRoots:[root],lockPermissions:false}}:{}),...(enableTpm?{tpm:{stateDirectory:join(root,'tpm'),files:stateFiles.tpm,tickMs:20}}:{}),succession:{controllerId:'controller',files:{roles:stateFiles.roles,contexts:stateFiles.contexts},...(enrollment?{enrollment:true as const}:{}),stateDirectory:root,native:{
 supports:async()=>supported,supportsBoundedProjection:async()=>bounded,
 inspect:async source=>{await beforeNativeInspect(source.nativeSessionId);if(!coverage)throw new Error('Native queue and work coverage unavailable');return {cwd:root,idle:source.nativeSessionId!==busy,managed:true,pendingInputs:0,pendingInteractions:0,activeChildren:0};},
 createIdle:async()=>{creates++;await beforeIdleCreate();const id=String.fromCharCode(65+creates);sessions.set(id,new Native(id,root));return ref(id);},reconcileDelivery:async()=>undefined,
 }},registrations:[{adapter:{nativeEvidence:providerEvidence,descriptor:{providerId:'fixture',displayName:'Fixture',...(enableTpm?{sessionExtensions:{instructions:true,tools:true}}:{})},createSession:async()=>{throw new Error('unexpected');},resumeSession:async()=>{throw new Error('unexpected');},readSessionHistory:async()=>({entries:[]})},directory:{providerId:'fixture',supportsNativePrefix:async()=>prefix,createNativePrefix:async(target,extensions,_evidence,checkpoint)=>{prefixForks++;assert.deepStrictEqual(target,{nativeSessionId:'A',turnId:'turn',messageId:'message'});assert.deepStrictEqual(extensions,{});sessions.set('B',new PromptNative('B',root));const handle={providerId:'fixture',sessionId:'B',opaque:'original prefix handle'};await checkpoint(handle);return handle;},verifyNativePrefix:async(target,handle)=>{prefixVerifications++;assert.deepStrictEqual(handle,{providerId:'fixture',sessionId:'B',opaque:'original prefix handle'});await onPrefixVerify();if(sessions.get('B')!.sent.length)throw new Error('candidate prefix changed');},canReleaseSession:()=>allowIdleRelease,supportsSourceReferences:true,supportsBoundedSourceCreate:async()=>true,list:()=>[],workspaces:()=>[],create:async config=>{if(config.sourceNativeSessionId){await beforeSourceCreate();const id=`source-${++sourceCreates}`;sessions.set(id,new Native(id,root));grants.push({nativeSessionId:id,sourceNativeSessionId:config.sourceNativeSessionId});if(loseSourceCreation)throw new Error('Unknown native creation');return id;}if(!enableTpm){if(!snapshots)throw new Error('unexpected');snapshotConfigurations.push(config);const id=`snapshot-${snapshotConfigurations.length}`;sessions.set(id,new Native(id,root));return id;}tpmConfigurations.push(config);const id=`tpm-${tpmConfigurations.length}`;sessions.set(id,new Native(id,root));if(loseTpmCreation)throw new Error('Native creation response was lost');return id;},open:async(id,options)=>{prefixHandles.push(options?.nativePrefix);creationOptions.push(options?.nativeCreation);resumeOptions.push(options?.resumeOptions);return sessions.get(id)!;},sessionWorkspace:async(id)=>{workspaceReads.push(id);return root;},sourceReferences:async()=>{await beforeGrants();return structuredClone(grants);},setSourceBindingReader:()=>{},close:async()=>{await Promise.all([...sessions.values()].map(session=>session.dispose()));}}}, ...additional]});
 let host=createHost();
 const createServer=()=>createAgentRemoteHttpServer(host.relay,{websocketAuthorizer:{authenticate:()=>({subject:'owner'}),authorize:()=>true}});
 let server=createServer();let network=memoryHttp(server.server);
 const restart=async()=>{network.close();await server.close();await host.close();for(const [id,previous] of sessions){const next=prefix?new PromptNative(id,root):evidence?new EvidenceNative(id,root):new Native(id,root);next.sent.push(...previous.sent);sessions.set(id,next);}host=createHost();server=createServer();network=memoryHttp(server.server);};
 const control=async(action:string,body:unknown)=>{const result=await host.control({method:'POST',path:`/remote/succession/${action}`,sessionId:'owner',body:JSON.stringify(body)});return {status:result.status,payload:JSON.parse(result.body)};};
 const roleStore=async()=>{const opened=new SessionSuccessionStore(join(root,'roles'),stateFiles.roles);await opened.ready;return opened;};
 return {root,stateFiles,roleStore,sessions,providerEvidence,prefixHandles,prefixForks:()=>prefixForks,prefixVerifications:()=>prefixVerifications,onPrefixVerify:(hook:()=>Promise<void>)=>{onPrefixVerify=hook;},creationOptions,resumeOptions,workspaceReads,allowIdleRelease:()=>{allowIdleRelease=true;},evidenceCreates:()=>evidenceCreates,creationResult:(value:AgentEmptyCreationResult)=>{creationResult=value;},beforeNativeInspect:(hook:typeof beforeNativeInspect)=>{beforeNativeInspect=hook;},snapshotConfigurations,providerDescriptors:[{providerId:'fixture',displayName:'Fixture'},...(snapshots?[{providerId:'other',displayName:'Other'}]:[])],get host(){return host;},restart,loseSourceCreation:()=>{loseSourceCreation=true;},sourceCreates:()=>sourceCreates,beforeIdleCreate:(hook:()=>Promise<void>)=>{beforeIdleCreate=hook;},beforeSourceCreate:(hook:()=>Promise<void>)=>{beforeSourceCreate=hook;},loseTpmCreation:(value:boolean)=>{loseTpmCreation=value;},grants,beforeGrants:(hook:()=>Promise<void>)=>{beforeGrants=hook;},tpmConfigurations,control,attach:async(id:string)=>JSON.parse((await host.control({method:'POST',path:'/remote/attach',sessionId:id,body:JSON.stringify({providerId:'fixture',nativeSessionId:id})})).body),get url(){return network.url;},webSocket:(url:string|URL,options?:Parameters<MemoryHttp['webSocket']>[1])=>network.webSocket(url,options),creates:()=>creates,unsupported:()=>{supported=false;},unbounded:()=>{bounded=false;},unavailableCoverage:()=>{coverage=false;},busy:(id:string)=>{busy=id;},close:async()=>{network.close();await server.close();await host.close();await rm(root,{recursive:true,force:true});}};
}
/** Each send uses a fresh authenticated connection and closes it before returning. */
export async function sendOverWebSocket(host: { url: string; webSocket: MemoryHttp['webSocket'] }, agentId: string, text: string, operationId: string, subject = 'owner', content = false) {
  const socket = host.webSocket(`${host.url.replace('http', 'ws')}/v1/sessions/${agentId}/events`, {
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

/** The request that begins the handoff of role A in the succession tests. */
export const handoffRequest={operationId:'handoff',roleId:'role',expectedRevision:1,from:ref('A')};
export const nativePrefixRequest = {...handoffRequest,preparation:{kind:'native_prefix' as const,turnId:'turn',messageId:'message'}};
/** A promise a test settles by hand, to hold a Host call at one step. */
export const deferredBoundary = () => { let resolve!: () => void; const promise = new Promise<void>(next => { resolve = next; }); return { promise, resolve }; };
