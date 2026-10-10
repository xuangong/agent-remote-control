import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createHostBroker, type RemoteHostBrokerState } from '../../agent-remote-hosted/src/broker.js';
import { PROTOCOL_VERSION, type ServerMessage, type TpmWork } from '@orchardworks/agent-remote-protocol';
import { createRemoteHostUplinkClient, createAgentRemoteHttpServer } from '@orchardworks/agent-remote-relay';
import type { AgentSession, AgentSessionConfig, AgentCapabilities, AgentInputAcceptance, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime } from './host.js';
import { TpmStore } from './tpm-store.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
const ref=(nativeSessionId:string)=>({controllerId:'controller',providerId:'fixture',nativeSessionId});
class Native implements AgentSession {
 capabilities:AgentCapabilities={history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,toolApproval:false,planApproval:false}};
 constructor(readonly id:string,readonly cwd:string,readonly providerId='fixture'){}
 async runtimeInfo(){return {providerId:this.providerId,sessionId:this.id,status:'idle' as const,cwd:this.cwd};}
 sent:string[]=[];cancels=0;async cancel(){this.cancels++;}private stop?:()=>void;
 async *observe():AsyncIterable<ProviderStreamItem>{if(this.id==='A') yield {type:'observation',sourceKey:'history-user',occurredAt:1,delivery:'history',event:{type:'timeline',provider:'fixture',item:{type:'user_message',text:'Original requirement'}}};yield {type:'history_boundary'};await new Promise<void>(resolve=>{this.stop=resolve;});}
 async sendMessage(text:string):Promise<AgentInputAcceptance | void>{this.sent.push(text);return {disposition:'queued' as const};}
 async respondToInteraction(){}
 async dispose(){this.stop?.();}
}
async function fixture(enableTpm=false,enrollment=false,setup?:(root:string)=>Promise<void>, snapshots=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),'arc-succession-runtime-')));
 const store=new SessionSuccessionStore(join(root,'roles'));await store.ready;
 if(!enrollment) await store.createRole({id:'role',revision:1,origin:ref('A'),current:ref('A'),workspace:{controllerId:'controller',canonicalCwd:root}});
 const grants:Array<{nativeSessionId:string;sourceNativeSessionId:string}>=[];let beforeGrants=async()=>{};
 await setup?.(root);
 const sessions=new Map([['A',new Native('A',root)]]);const tpmConfigurations:AgentSessionConfig[]=[];const snapshotConfigurations:AgentSessionConfig[]=[];let creates=0,sourceCreates=0,supported=true,coverage=true,busy='',loseTpmCreation=false,loseSourceCreation=false;let beforeSourceCreate=async()=>{};let beforeIdleCreate=async()=>{};
 const otherSession = new Native('other-A', root, 'other');
 const additional = snapshots ? [{adapter:{descriptor:{providerId:'other',displayName:'Other'},createSession:async()=>{throw new Error('unexpected');},resumeSession:async()=>{throw new Error('unexpected');},readSessionHistory:async()=>({entries:[]})},directory:{providerId:'other',list:()=>[],workspaces:()=>[],create:async()=>{throw new Error('unexpected');},open:async(id:string)=>{if(id!=='other-A')throw new Error('missing source');return otherSession;},sessionWorkspace:async(id:string)=>{if(id!=='other-A')throw new Error('missing source');return root;},sourceReferences:async()=>[],setSourceBindingReader:()=>{},close:()=>otherSession.dispose()}}] : [];
 const createHost=()=>createAgentHostRuntime({...(enableTpm?{tpm:{stateDirectory:join(root,'tpm'),tickMs:20}}:{}),succession:{controllerId:'controller',...(enrollment?{enrollment:true as const}:{}),stateDirectory:root,native:{
 supports:async()=>supported,
 inspect:async source=>{if(!coverage)throw new Error('Native queue and work coverage unavailable');return {cwd:root,idle:source.nativeSessionId!==busy,managed:true,pendingInputs:0,pendingInteractions:0,activeChildren:0};},
 createIdle:async()=>{creates++;await beforeIdleCreate();const id=String.fromCharCode(65+creates);sessions.set(id,new Native(id,root));return ref(id);},reconcileDelivery:async()=>undefined,
 }},registrations:[{adapter:{descriptor:{providerId:'fixture',displayName:'Fixture',...(enableTpm?{sessionExtensions:{instructions:true,tools:true}}:{})},createSession:async()=>{throw new Error('unexpected');},resumeSession:async()=>{throw new Error('unexpected');},readSessionHistory:async()=>({entries:[]})},directory:{providerId:'fixture',supportsSourceReferences:true,list:()=>[],workspaces:()=>[],create:async config=>{if(config.sourceNativeSessionId){await beforeSourceCreate();const id=`source-${++sourceCreates}`;sessions.set(id,new Native(id,root));grants.push({nativeSessionId:id,sourceNativeSessionId:config.sourceNativeSessionId});if(loseSourceCreation)throw new Error('Unknown native creation');return id;}if(!enableTpm){if(!snapshots)throw new Error('unexpected');snapshotConfigurations.push(config);const id=`snapshot-${snapshotConfigurations.length}`;sessions.set(id,new Native(id,root));return id;}tpmConfigurations.push(config);const id=`tpm-${tpmConfigurations.length}`;sessions.set(id,new Native(id,root));if(loseTpmCreation)throw new Error('Native creation response was lost');return id;},open:async id=>sessions.get(id)!,sessionWorkspace:async()=>root,sourceReferences:async()=>{await beforeGrants();return structuredClone(grants);},setSourceBindingReader:()=>{},close:async()=>{await Promise.all([...sessions.values()].map(session=>session.dispose()));}}}, ...additional]});
 let host=createHost();
 const createServer=()=>createAgentRemoteHttpServer(host.relay,{websocketAuthorizer:{authenticate:()=>({subject:'owner'}),authorize:()=>true}});
 let server=createServer();let address=await server.listen(0);
 const restart=async()=>{await server.close();await host.close();for(const [id,previous] of sessions){const next=new Native(id,root);next.sent.push(...previous.sent);sessions.set(id,next);}host=createHost();server=createServer();address=await server.listen(0);};
 const control=async(action:string,body:unknown)=>{const result=await host.control({method:'POST',path:`/remote/succession/${action}`,sessionId:'owner',body:JSON.stringify(body)});return {status:result.status,payload:JSON.parse(result.body)};};
 return {root,sessions,snapshotConfigurations,providerDescriptors:[{providerId:'fixture',displayName:'Fixture'},...(snapshots?[{providerId:'other',displayName:'Other'}]:[])],get host(){return host;},restart,loseSourceCreation:()=>{loseSourceCreation=true;},sourceCreates:()=>sourceCreates,beforeIdleCreate:(hook:()=>Promise<void>)=>{beforeIdleCreate=hook;},beforeSourceCreate:(hook:()=>Promise<void>)=>{beforeSourceCreate=hook;},loseTpmCreation:(value:boolean)=>{loseTpmCreation=value;},grants,beforeGrants:(hook:()=>Promise<void>)=>{beforeGrants=hook;},tpmConfigurations,control,attach:async(id:string)=>JSON.parse((await host.control({method:'POST',path:'/remote/attach',sessionId:id,body:JSON.stringify({providerId:'fixture',nativeSessionId:id})})).body),get url(){return address.url;},creates:()=>creates,unsupported:()=>{supported=false;},unavailableCoverage:()=>{coverage=false;},busy:(id:string)=>{busy=id;},close:async()=>{await server.close();await host.close();await rm(root,{recursive:true,force:true});}};
}
const request={operationId:'handoff',roleId:'role',expectedRevision:1,from:ref('A')};
/** Each send uses a fresh authenticated connection and closes it before returning. */
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
});
test('unsupported pair and a busy source fail before idle candidate creation',async()=>{
 const f=await fixture();try{f.unsupported();expect((await f.control('prepare',request)).payload.phase).toBe('rejected');expect(f.creates()).toBe(0);}finally{await f.close();}
 const g=await fixture();try{g.busy('A');expect((await g.control('prepare',request)).payload.phase).toBe('rejected');expect(g.creates()).toBe(0);}finally{await g.close();}
});
test('a busy candidate prevents readiness and later source work prevents commit',async()=>{
 const f=await fixture();try{f.busy('B');expect((await f.control('prepare',request)).payload.phase).toBe('rejected');expect(f.creates()).toBe(1);expect(f.sessions.get('B')!.sent).toEqual([]);}finally{await f.close();}
 const g=await fixture();try{expect((await g.control('prepare',request)).payload.phase).toBe('ready');g.busy('A');expect((await g.control('commit',{operationId:'handoff',expectedRevision:1})).status).toBe(409);}finally{await g.close();}
});

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
});

async function enrollmentTransport(f: Awaited<ReturnType<typeof fixture>>, initial?: RemoteHostBrokerState, options:{installationId?:string;enrollment?:boolean}={}) {
  const http = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const result = await broker.handleRequest(new Request(origin + incoming.url!, { method: incoming.method, body: Buffer.concat(chunks).toString() }),
        { principalSubject: () => String(incoming.headers['x-test-subject'] ?? 'owner') });
      response.writeHead(result?.status ?? 404, result ? Object.fromEntries(result.headers) : {});
      response.end(result ? await result.text() : '');
    })().catch(error => { response.writeHead(500); response.end(String(error)); });
  });
  const server = new WebSocketServer({ server: http });
  http.listen(0, '127.0.0.1'); await once(http, 'listening', { signal: AbortSignal.timeout(3000) });
  const origin = `http://127.0.0.1:${(http.address() as {port:number}).port}`;
  const authority = { version: 1 as const, origin, issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
  let saved: RemoteHostBrokerState | undefined; let dropCreationResponse=false;const createRequests=new Set<string>();let failProjection = false, failBinding=false; let beforeControl=async(_input:{action?:string;freeze?:unknown})=>{};
  const makeBroker=(initialState?:RemoteHostBrokerState)=>createHostBroker({ origin, ownerSubject: 'owner', durable: true, successionEnrollment: authority, initialState,
    onStateChange: async state => { if (failProjection && state.associations?.freezes.some(item => item.released)) throw new Error('Projection storage unavailable'); if(failBinding&&state.bindings.some(item=>item.sourceRelation))throw new Error('Binding storage unavailable'); saved = structuredClone(state); }, rpcTimeoutMs: 2000 });
  let broker=makeBroker(initial);
  const request = (path:string, body:unknown, subject='owner') => fetch(origin+path, {method:'POST',body:JSON.stringify(body),headers:{'x-test-subject':subject},signal:AbortSignal.timeout(5000)});
  const enrollmentRpc = (input: unknown): Promise<{status:number;body:string}> => new Promise((resolve,reject) => {
    const socket=[...server.clients].find(item=>item.readyState===WebSocket.OPEN), requestId=crypto.randomUUID();
    if(!socket){reject(new Error('Registered fixture uplink is unavailable.'));return;}
    const cleanup=()=>{clearTimeout(timer);socket.off('message',receive);};
    const timer=setTimeout(()=>{cleanup();reject(new Error('Fixture enrollment RPC deadline exceeded.'));},3000);
    function receive(data:WebSocket.RawData){const message=JSON.parse(data.toString());if(message.type==='rpc_response'&&message.requestId===requestId){cleanup();resolve(message);}}
    socket.on('message',receive);
    socket.send(JSON.stringify({uplinkVersion:2,type:'rpc_request',requestId,method:'POST',path:'/remote/succession/enrollment',body:JSON.stringify(input)}));
  });
  server.on('connection', async (socket, incoming) => {
    const upgrade = await broker.prepareUpgrade(new Request(origin+incoming.url!, { headers: {authorization:incoming.headers.authorization!} }));
    if (!upgrade || upgrade instanceof Response) { socket.close(1008); return; }
    upgrade.accept({get readyState(){return socket.readyState;},get bufferedAmount(){return socket.bufferedAmount;},send:data=>{const message=JSON.parse(data);if(message.type==='rpc_request'&&message.path==='/remote/create')createRequests.add(message.requestId);socket.send(data);},close:(code,reason)=>socket.close(code,reason),
      onMessage(listener){const handle=(data:WebSocket.RawData,binary:boolean)=>{const message=JSON.parse(data.toString());if(dropCreationResponse&&message.type==='rpc_response'&&createRequests.has(message.requestId)){dropCreationResponse=false;return;}void listener(data.toString(),binary);};socket.on('message',handle);return()=>{socket.off('message',handle);};},
      onClose(listener){const handle=(code:number)=>listener({code});socket.on('close',handle);return()=>{socket.off('close',handle);};},
      onError(listener){socket.on('error',listener);return()=>{socket.off('error',listener);};}});
  });
  const connect=async()=>{const pairing=await (await request('/v1/remote/pairings',{}))!.json();return createRemoteHostUplinkClient({relay:f.host.relay,installationId:options.installationId??'controller',name:'Fixture',providers:f.providerDescriptors,
    remoteKey:pairing.key,onCredential:async()=>{},url:origin.replace('http:','ws:')+'/ws/remote-host',resolveSession:f.host.resolveSession,acquireSession:f.host.acquireSession,
    control:f.host.control,...(options.enrollment===false?{}:{successionEnrollment:{control:async(request,context)=>{const result=await f.host.enrollFromRelay(request,context);await beforeControl(JSON.parse(request.body??'{}'));return result;}}})});};
  let client=await connect();const {hostId}=await client.ready;
  return {get client(){return client;},get broker(){return broker;},authority,request,enrollmentRpc,hostId,restart:async(beforeConnect?:()=>Promise<void>)=>{await client.close();broker.close();await beforeConnect?.();broker=makeBroker(saved);client=await connect();await client.ready;},failBinding:(value:boolean)=>{failBinding=value;},dropCreationResponse:()=>{dropCreationResponse=true;},beforeControl:(hook:typeof beforeControl)=>{beforeControl=hook;},failProjection:(value:boolean)=>{failProjection=value;},saved:()=>structuredClone(saved!),action:(action:string,input:unknown,subject='owner')=>request(`/v1/remote/hosts/${hostId}/succession/${action}`,input,subject),
    close:async()=>{await client.close();broker.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>http.close(()=>resolve()));}};
}

test('authenticated broker enrollment derives a role, freezes associations and commits over a real uplink',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  try {
    const input={operationId:'trusted-handoff',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',{...input,authority:transport.authority}))!.status).toBe(400);
    expect((await transport.action('prepare',input,'viewer'))!.status).toBe(403);
    expect((await f.host.control({method:'POST',path:'/remote/succession/enrollment',body:JSON.stringify({action:'describe',providerId:'fixture',nativeSessionId:'A'})})).status).toBe(403);
    const prepared=await transport.action('prepare',input);const ready=await prepared!.json();
    expect(ready,JSON.stringify(ready)).toMatchObject({record:{phase:'ready'},role:{origin:ref('A'),workspace:{canonicalCwd:f.root}}});
    expect(f.sessions.get('A')!.sent).toEqual([]);expect(f.sessions.get('B')!.sent).toEqual([]);
    expect(transport.saved().associations?.freezes).toHaveLength(1);
    expect(transport.saved().associations?.freezes[0]?.released).toBeUndefined();
    const committed=await (await transport.action('commit',{operationId:input.operationId}))!.json();
    expect(committed).toMatchObject({record:{phase:'committed'},role:{current:ref('B'),revision:2},locator:{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'B'}});
    expect(transport.saved().associations?.freezes[0]).toMatchObject({released:'committed',projection:{role:{current:ref('B')}}});
    const state=JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
    expect(state).toMatchObject({version:4,roles:[{associationAuthority:transport.authority,enrollments:[{request:{operationId:input.operationId}}]}]});
  } finally {await transport.close();await f.close();}
});

test('real HTTP and WebSocket cancel a blocked create without activating its late candidate', async () => {
  const f = await fixture(false, true), transport = await enrollmentTransport(f);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  f.beforeIdleCreate(async () => { enter(); await blocked; });
  const input = { operationId: 'cancel-blocked', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 };
  const preparing = transport.action('prepare', input);
  try {
    await entered;
    const a = await f.attach('A');
    expect((await sendOverWebSocket(f.url, a.agentId, 'blocked input', '00000000-0000-4000-8000-000000000080')).type).toBe('protocol_error');
    const cancelled = await transport.action('cancel', { operationId: input.operationId });
    expect(await cancelled.json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect(transport.saved().associations!.freezes[0]!.released).toBe('cancelled');
    release(); expect(await (await preparing).json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect((await sendOverWebSocket(f.url, a.agentId, 'continue A', '00000000-0000-4000-8000-000000000081')).type).toBe('command_acknowledged');
    expect(f.sessions.get('B')!.sent).toEqual([]);
    expect(await (await transport.action('reconcile', { operationId: input.operationId })).json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect(await (await transport.action('prepare', input)).json()).toMatchObject({ record: { phase: 'cancelled' } });
    expect(f.creates()).toBe(1);
    const contexts = JSON.parse(await readFile(join(f.root, 'contexts', 'context.json'), 'utf8'));
    expect(contexts.attachments).toEqual([]); expect(contexts.preparations).toHaveLength(1);
    const roles = JSON.parse(await readFile(join(f.root, 'roles', 'state.json'), 'utf8'));
    expect(roles.roles[0].localPreparations[0].orphanCandidate).toEqual(ref('B'));
  } finally { release(); await preparing.catch(() => undefined); await transport.close(); await f.close(); }
});


test('old operation replay preserves A to B to C',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  const store=async()=>{const value=new SessionSuccessionStore(join(f.root,'roles'));await value.ready;return value;};
  try {
    const input={operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    expect((await transport.action('commit',{operationId:'first'}))!.status).toBe(200);
    const released=await store();
    expect(released.read(released.all()[0]!.role.id).releasedEnrollments).toHaveLength(1);
    const projection=structuredClone(transport.saved().associations!.freezes[0]!.projection);
    const second = await transport.action('prepare',{...input,operationId:'second',nativeSessionId:'B',expectedRevision:2});
    expect(await second!.json()).toMatchObject({record:{phase:'ready'}});
    const secondCommit = await transport.action('commit',{operationId:'second'});
    expect(await secondCommit!.json()).toMatchObject({record:{phase:'committed'},role:{revision:3}});
    const replay=await transport.action('status',{operationId:'first'});
    expect(replay!.status).toBe(200);
    expect(await replay!.json()).toMatchObject({record:{operationId:'first',committedRevision:2},role:{revision:2,current:ref('B')},locator:{nativeSessionId:'B'}});
    expect(transport.saved().associations!.freezes[0]!.projection).toEqual(projection);
    const current = await store(); expect(current.all()[0]!.role).toMatchObject({revision:3,current:ref('C')});
  }finally{await transport.close();await f.close();}
});


test('broker persistence failure keeps a committed Host decision fenced across restart',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  try {
    expect((await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    transport.failProjection(true);
    expect((await transport.action('commit',{operationId:'first'}))!.status).toBe(503);
    const blocked=new SessionSuccessionStore(join(f.root,'roles'));await blocked.ready;
    expect(blocked.operation('first').phase).toBe('committed');
    await expect(blocked.admitAssociation('new-reader','fingerprint',ref('B'))).rejects.toThrow(/reserved/);
    expect(transport.saved().associations!.freezes[0]!.released).toBeUndefined();
    expect(blocked.all()[0]!.releasedEnrollments).toBeUndefined();
    transport.failProjection(false);await transport.restart(f.restart);
    expect((await transport.action('status',{operationId:'first'}))!.status).toBe(200);
    expect(transport.saved().associations!.freezes[0]!.released).toBe('committed');
    const released=new SessionSuccessionStore(join(f.root,'roles'));await released.ready;
    expect(released.all()[0]!.releasedEnrollments).toHaveLength(1);
    expect(f.creates()).toBe(1);
  }finally{await transport.close();await f.close();}
});


test('pre-begin validation failure can be durably cancelled without late preparation effects',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  try {
    const input={operationId:'missing-grant-relation',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    f.grants.push({nativeSessionId:'cold-side',sourceNativeSessionId:'A'});
    expect((await transport.action('prepare',input))!.status).toBe(409);
    expect(transport.saved().associations!.freezes[0]!.released).toBeUndefined();
    const cancelled=await transport.action('cancel',{operationId:input.operationId});
    expect(cancelled!.status).toBe(200);
    expect(await cancelled!.json()).toMatchObject({record:{phase:'cancelled'}});
    f.grants.length=0;
    expect(await (await transport.action('prepare',input))!.json()).toMatchObject({record:{phase:'cancelled'}});
    expect(f.creates()).toBe(0);
    const restored=new SessionSuccessionStore(join(f.root,'roles'));await restored.ready;
    expect(restored.operation(input.operationId).phase).toBe('cancelled');
    expect(restored.all()[0]!.releasedEnrollments).toHaveLength(1);
  }finally{await transport.close();await f.close();}
});

test('cancellation serializes ahead of a delayed pre-begin grant snapshot',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  let resume!:()=>void;let entered!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{resume=resolve;});
  try {
    f.beforeGrants(async()=>{entered();await gate;});
    const input={operationId:'delayed-prepare',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    const preparing=transport.action('prepare',input);await reached;
    expect((await transport.action('cancel',{operationId:input.operationId}))!.status).toBe(200);
    resume();
    expect(await (await preparing)!.json()).toMatchObject({record:{phase:'cancelled'}});
    expect(f.creates()).toBe(0);
  }finally{resume();await transport.close();await f.close();}
});


function coldAssociations(): RemoteHostBrokerState {
  const hostId='cold-host';
  const relation=(id:string,kind:'side'|'ask',sourceNativeSessionId:string,linked=true)=>({id,kind,sourceNativeSessionId,linked,revision:0,createdAt:'2026-10-10T00:00:00.000Z'});
  return {keys:[],hosts:[{id:hostId,installationId:'controller',name:'Fixture',legacyDsh:false,providers:[{providerId:'fixture',displayName:'Fixture'}]}],creations:[],bindings:[
    {hostId,providerId:'fixture',nativeSessionId:'A',agentId:'main'},
    ...[['side',relation('side-relation','side','A')],['ask',relation('ask-relation','ask','A')],['unlinked',relation('unlinked-relation','side','A',false)],['nested',relation('nested-relation','ask','side')]].map(([id,sourceRelation])=>({hostId,providerId:'fixture',nativeSessionId:id as string,agentId:id as string,sourceRelation:sourceRelation as ReturnType<typeof relation>})),
  ]};
}
test('cold complete grants enroll only linked direct readers and preserve immutable provenance',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
    const input={operationId:'cold',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    const state=JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
    expect(state.roles[0].participants.map((item:{before:{nativeSessionId:string}})=>item.before.nativeSessionId).sort()).toEqual(['ask','side']);
    const before=transport.saved().bindings;
    const update={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0};
    await expect(transport.broker.updateSessionRelation('owner',update)).rejects.toThrow(/reserved/);
    expect((await transport.action('commit',{operationId:'cold'}))!.status).toBe(200);
    await expect(transport.broker.updateSessionRelation('owner',update)).rejects.toThrow(/operation identity/);
    expect(transport.saved().bindings).toEqual(before);
    expect(f.sessions.size).toBe(2);
  }finally{await transport.close();await f.close();}
});

test('cancelling the first reservation restores ordinary relationship updates',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f,coldAssociations());
  try {
    const input={operationId:'cancel-first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(409);
    expect((await transport.action('cancel',{operationId:input.operationId}))!.status).toBe(200);
    await transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0});
    expect(transport.saved().bindings.find(item=>item.nativeSessionId==='side')!.sourceRelation!.linked).toBe(false);
  }finally{await transport.close();await f.close();}
});


test.each(['source','revision','provider'] as const)('concurrent different %s cannot reuse one frozen operation identity',async conflict=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let describes=0,prepares=0;
  try {
    f.sessions.set('X',new Native('X',f.root));
    transport.beforeControl(async input=>{if(input.action==='describe'){if(++describes===2)release();await gate;}if(input.action==='prepare')prepares++;});
    const input={operationId:'same-operation',providerId:'fixture',nativeSessionId:'A',expectedRevision:1};
    const changed=conflict==='source'?{nativeSessionId:'X'}:conflict==='revision'?{expectedRevision:2}:{targetProviderId:'other'};
    const results=await Promise.all([transport.action('prepare',input),transport.action('prepare',{...input,...changed})]);
    expect(results.map(result=>result!.status).sort()).toEqual([200,409]);
    expect(prepares).toBe(1);
    const selected=transport.saved().associations!.freezes[0]!.receipt.request;
    expect(f.creates()).toBe(selected.targetProviderId==='other'?0:1);
  }finally{release();await transport.close();await f.close();}
});


test.each([false,true])('unknown TPM creation retains exact admission and paused work without browser bindings (existing role %s)',async(existingRole)=>{
  const f=await fixture(true,true,existingRole?async root=>{const store=new SessionSuccessionStore(join(root,'roles'));await store.ready;await store.ensureRole(ref('A'),root);}:undefined);const transport=await enrollmentTransport(f);
  const roles=async()=>JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
  try {
    f.loseTpmCreation(true);
    const created=await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'unknown-tpm'})});
    expect(created.status).toBe(409);
    const workPath=join(f.root,'tpm',(await readdir(join(f.root,'tpm'))).find(path=>path.endsWith('.json'))!);
    const record=JSON.parse(await readFile(workPath,'utf8'));
    expect(record.creation).toBe('unknown');
    expect((await roles()).associationAdmissions).toHaveLength(1);
    expect((await transport.action('prepare',{operationId:'blocked-tpm',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(409);
    expect((await transport.action('cancel',{operationId:'blocked-tpm'}))!.status).toBe(200);
    const current=async()=>JSON.parse((await f.host.control({method:'GET',path:`/remote/tpm/work?id=${record.work.id}`})).body);
    await expect.poll(async()=>(await current()).mainBinding?.kind).toBe('primary_role');
    let paused:Awaited<ReturnType<typeof f.host.control>>|undefined;
    for(let attempt=0;attempt<4;attempt++){
      const latest=await current();
      paused=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:latest.id,revision:latest.revision,action:'pause',operationId:`pause-tpm-${attempt}`})});
      if(paused.status===200)break;
      expect(paused.status).toBe(409);expect(JSON.parse(paused.body).error).toBe('TPM work changed. Refresh before applying this change.');
    }
    expect(paused!.status,paused!.body).toBe(200);
    const recovered=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:record.work.id,revision:JSON.parse(paused!.body).revision,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'recover-tpm'})});
    expect(recovered.status,recovered.body).toBe(200);
    expect((await roles()).associationAdmissions).toEqual([]);
    const accepted=JSON.parse(recovered.body);
    expect((await transport.action('prepare',{operationId:'enroll-tpm',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    expect((await roles()).roles[0].participants).toEqual([{relationId:`tpm:${accepted.id}`,kind:'tpm',before:ref('tpm-1'),after:ref('tpm-1')}]);
    const persisted=JSON.parse(await readFile(workPath,'utf8'));
    expect(persisted.work).toMatchObject({id:accepted.id,tpmNativeSessionId:'tpm-1',paused:true});
    expect(transport.saved().bindings).toEqual([]);
    expect(f.tpmConfigurations).toHaveLength(1);
  }finally{await transport.close();await f.close();}
});


test('completed persisted TPM is enrolled without attaching its native session',async()=>{
  const f=await fixture(true,true,async root=>{
    const store=new TpmStore(join(root,'tpm'));await store.ready;
    await store.insert({version:1,createKey:'completed-key',createFingerprint:'completed-fingerprint',creation:'accepted',requirement:'Done',dirty:false,lastReviewAt:0,actions:{},work:{
      id:'completed-work',revision:1,title:'Completed work',providerId:'fixture',mainNativeSessionId:'A',tpmNativeSessionId:'cold-tpm',phase:'completed',waiting:'none',paused:false,summary:'Done',nextAction:'',document:'Approved plan',acceptance:'Accepted',evidence:['verified'],createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z',nextCheckAt:0,outbox:[],
    }});
  });const transport=await enrollmentTransport(f);
  try {
    expect((await transport.action('prepare',{operationId:'completed-work-handoff',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    const state=JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
    expect(state.roles[0].participants).toEqual([{relationId:'tpm:completed-work',kind:'tpm',before:ref('cold-tpm'),after:ref('cold-tpm')}]);
    expect(f.sessions.has('cold-tpm')).toBe(false);expect(transport.saved().bindings).toEqual([]);
    const work=JSON.parse(await readFile(join(f.root,'tpm','completed-work.json'),'utf8')).work;
    expect(work).toMatchObject({phase:'completed',document:'Approved plan',evidence:['verified']});
  }finally{await transport.close();await f.close();}
});


test('past and future expected revisions fail before any broker freeze or Host preparation',async()=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f);let prepares=0;
  try {
    transport.beforeControl(async input=>{if(input.action==='prepare')prepares++;});
    const input={operationId:'future',providerId:'fixture',nativeSessionId:'A',expectedRevision:2};
    expect((await transport.action('prepare',input))!.status).toBe(409);
    expect(transport.saved().associations!.freezes).toHaveLength(0);expect(prepares).toBe(0);
    expect((await transport.action('prepare',{...input,operationId:'valid-first',expectedRevision:1}))!.status).toBe(200);
    expect((await transport.action('commit',{operationId:'valid-first'}))!.status).toBe(200);
    expect((await transport.action('prepare',{...input,operationId:'past',nativeSessionId:'B',expectedRevision:1}))!.status).toBe(409);
    expect(transport.saved().associations!.freezes).toHaveLength(1);expect(prepares).toBe(1);
    expect((await transport.action('prepare',{...input,operationId:'valid-second',nativeSessionId:'B'}))!.status).toBe(200);
    expect(prepares).toBe(2);
  }finally{await transport.close();await f.close();}
});


test('lost source creation response recovers its original durable result without native replay',async()=>{
  const f=await fixture(false,true);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial);
  try {
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000002',sourceNativeSessionId:'A',conversationKind:'side'};
    transport.dropCreationResponse();
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(504);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'blocked-reader',expectedRevision:1}))!.status).toBe(409);
    await transport.restart(f.restart);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{...input,model:'changed'}))!.status).toBe(409);
    const grant=f.grants.pop()!;
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(409);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    f.grants.push(grant);
    const recovered=await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{conversationKind:'side',sourceNativeSessionId:'A',operationId:'00000000-0000-4000-8000-000000000002',providerId:'fixture'});
    expect(recovered!.status,JSON.stringify(await recovered!.clone().json())).toBe(200);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toEqual([]);
    expect(transport.saved().bindings.find(item=>item.nativeSessionId==='source-1')!.sourceRelation).toMatchObject({id:'00000000-0000-4000-8000-000000000002',sourceNativeSessionId:'A',kind:'side'});
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'known-reader',expectedRevision:1}))!.status).toBe(200);
  }finally{await transport.close();await f.close();}
});


test('broker binding persistence failure recovers from the Host result after broker restart',async()=>{
  const f=await fixture(false,true);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial);
  try {
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000003',sourceNativeSessionId:'A',conversationKind:'side'};
    transport.failBinding(true);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(503);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    transport.failBinding(false);await transport.restart();
    const recovered=await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input);
    expect(recovered!.status,JSON.stringify(await recovered!.clone().json())).toBe(200);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toEqual([]);
  }finally{await transport.close();await f.close();}
});

test('native source creation and succession freeze have symmetric admission fences',async()=>{
  const f=await fixture(false,true);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});const reached=new Promise<void>(resolve=>{entered=resolve;});
  try {
    f.beforeSourceCreate(async()=>{entered();await gate;});
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000004',sourceNativeSessionId:'A',conversationKind:'side'};
    const creating=transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input);await reached;
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'racing-reader',expectedRevision:1}))!.status).toBe(409);
    expect(transport.saved().associations!.freezes).toHaveLength(0);
    release();expect((await creating)!.status).toBe(200);
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'frozen-reader',expectedRevision:1}))!.status).toBe(200);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{...input,operationId:'00000000-0000-4000-8000-000000000005'}))!.status).toBe(409);
    const direct=await f.host.control({method:'POST',path:'/remote/create',sessionId:'bypass',body:JSON.stringify({providerId:'fixture',sourceNativeSessionId:'A',operationId:'00000000-0000-4000-8000-000000000006'})});
    expect(direct.status,direct.body).toBe(400);expect(JSON.parse(direct.body!).code).toBe('succession_admission_closed');expect(f.sourceCreates()).toBe(1);
  }finally{release();await transport.close();await f.close();}
});


test('an unknown native creation without a result witness stays frozen and is never recreated',async()=>{
  const f=await fixture(false,true);const initial=coldAssociations();initial.bindings=initial.bindings.filter(item=>item.nativeSessionId==='A');
  const transport=await enrollmentTransport(f,initial);
  try {
    f.loseSourceCreation();
    const input={providerId:'fixture',operationId:'00000000-0000-4000-8000-000000000007',sourceNativeSessionId:'A',conversationKind:'side'};
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBeGreaterThanOrEqual(400);
    await transport.restart();
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,input))!.status).toBe(409);
    expect(f.sourceCreates()).toBe(1);expect(transport.saved().associations!.admissions).toHaveLength(1);
    const restored=new SessionSuccessionStore(join(f.root,'roles'));await restored.ready;
    const state=JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
    expect(state.associationAdmissions).toHaveLength(1);expect(state.associationResults).toEqual([]);
  }finally{await transport.close();await f.close();}
});


test.each([{installationId:'foreign'},{enrollment:false}])('mismatched Controller or unnegotiated peer fails before native creation: %j',async options=>{
  const f=await fixture(false,true);const transport=await enrollmentTransport(f,undefined,options);
  try {
    expect((await transport.action('prepare',{providerId:'fixture',nativeSessionId:'A',operationId:'forbidden-peer',expectedRevision:1}))!.status).toBe(409);
    expect(f.creates()).toBe(0);expect(transport.saved().associations!.freezes).toEqual([]);
  }finally{await transport.close();await f.close();}
});

test('replacing the association authority never takes over a previously bound role',async()=>{
  const f=await fixture(false,true);let transport=await enrollmentTransport(f);
  try {
    const input={providerId:'fixture',nativeSessionId:'A',operationId:'bound-role',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    expect((await transport.action('cancel',{operationId:input.operationId}))!.status).toBe(200);
    await transport.close();transport=await enrollmentTransport(f);
    expect((await transport.action('prepare',{...input,operationId:'replacement-authority'}))!.status).toBe(409);
    expect(f.creates()).toBe(1);expect(transport.saved().associations!.freezes).toEqual([]);
  }finally{await transport.close();await f.close();}
});


test('a full Host and broker restart safely rejects a known candidate when capture cannot be revalidated',async()=>{
  const f=await fixture(false,true);f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
  const transport=await enrollmentTransport(f,coldAssociations());
  try {
    const input={providerId:'fixture',nativeSessionId:'A',operationId:'restart-frozen',expectedRevision:1};
    expect((await transport.action('prepare',input))!.status).toBe(200);
    const receipt=structuredClone(transport.saved().associations!.freezes[0]!.receipt);
    await transport.restart(f.restart);
    const restored=await (await transport.action('status',{operationId:input.operationId}))!.json();
    expect(restored.record.phase).toBe('unknown');
    expect(transport.saved().associations!.freezes[0]!.receipt).toEqual(receipt);
    expect(transport.saved().associations!.freezes[0]!.released).toBeUndefined();
    const blocked=await f.host.control({method:'POST',path:'/remote/create',sessionId:'blocked-restart',body:JSON.stringify({providerId:'fixture',sourceNativeSessionId:'A',operationId:'00000000-0000-4000-8000-000000000007'})});
    expect(blocked.status).toBe(400);expect(f.sourceCreates()).toBe(0);
    const reconciled=await transport.action('reconcile',{operationId:input.operationId});
    expect(reconciled!.status).toBe(200);
    expect(await reconciled!.json()).toMatchObject({record:{phase:'rejected',to:ref('B'),failureCode:'succession_boundary_changed'}});
    expect((await (await transport.action('status',{operationId:input.operationId}))!.json()).record.phase).toBe('rejected');
    expect(transport.saved().associations!.freezes[0]!.released).toBe('rejected');
    expect(f.creates()).toBe(1);
  }finally{await transport.close();await f.close();}
});


test('a revision-rejected TPM recovery cannot leave an unresolved association admission',async()=>{
  const f=await fixture(true,true,async root=>{const store=new SessionSuccessionStore(join(root,'roles'));await store.ready;await store.ensureRole(ref('A'),root);});
  try {
    f.loseTpmCreation(true);
    expect((await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'stale-recovery-create'})})).status).toBe(409);
    const path=join(f.root,'tpm',(await readdir(join(f.root,'tpm'))).find(path=>path.endsWith('.json'))!);
    const {work}=JSON.parse(await readFile(path,'utf8'));
    const stale=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:work.id,revision:work.revision-1,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'stale-recovery'})});
    expect(stale.status).toBe(409);expect(JSON.parse(stale.body).error).toMatch(/work changed/);
    const state=JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
    expect(state.associationAdmissions).toHaveLength(1);
    const recovered=await f.host.control({method:'POST',path:'/remote/tpm/action',body:JSON.stringify({id:work.id,revision:work.revision,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'correct-recovery'})});
    expect(recovered.status,recovered.body).toBe(200);
    expect(JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8')).associationAdmissions).toEqual([]);
  }finally{await f.close();}
});


test('a TPM recovery failure after native access retains its unresolved admission',async()=>{
  const f=await fixture(true,true,async root=>{const store=new SessionSuccessionStore(join(root,'roles'));await store.ready;await store.ensureRole(ref('A'),root);});
  try {
    f.loseTpmCreation(true);
    expect((await f.host.control({method:'POST',path:'/remote/tpm/create',body:JSON.stringify({providerId:'fixture',mainNativeSessionId:'A',operationId:'unknown-recovery-create'})})).status).toBe(409);
    const path=join(f.root,'tpm',(await readdir(join(f.root,'tpm'))).find(path=>path.endsWith('.json'))!);
    const {work}=JSON.parse(await readFile(path,'utf8'));
    let inspections=0;f.sessions.get('tpm-1')!.runtimeInfo=async()=>{inspections++;throw new Error('Native recovery outcome is unavailable.');};
    const body=JSON.stringify({id:work.id,revision:work.revision,action:'resolve',intentId:'creation',resolution:'accepted',nativeSessionId:'tpm-1',operationId:'unknown-recovery'});
    expect((await f.host.control({method:'POST',path:'/remote/tpm/action',body})).status).toBe(409);
    expect(JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8')).associationAdmissions).toHaveLength(2);
    const repeated=await f.host.control({method:'POST',path:'/remote/tpm/action',body});
    expect(repeated.status).toBe(409);expect(JSON.parse(repeated.body).error).toMatch(/unresolved/);expect(inspections).toBe(1);
  }finally{await f.close();}
});

test('trusted postcommit unlink and relink reconcile cold direct readers and keep nested Ask fixed', async () => {
  const f = await fixture(false, true); const transport = await enrollmentTransport(f, coldAssociations());
  try {
    f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
    expect((await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}))!.status).toBe(200);
    expect((await transport.action('commit',{operationId:'relations'}))!.status).toBe(200);
    const original = structuredClone(f.grants);
    const input = { hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'unlink-side',expectedRoleRevision:2 };
    const result = await transport.broker.updateSessionRelation('owner', input);
    expect(result).toMatchObject({operation:{phase:'committed',reservation:{operationId:'unlink-side'}}});
    expect(await transport.broker.updateSessionRelation('owner', input)).toEqual(result);
    const state = JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
    expect(state.roles[0].participants.map((row:{after:{nativeSessionId:string}})=>row.after.nativeSessionId)).toEqual(['ask']);
    expect(state.roles[0].relationChanges[0].phase).toBe('released');
    expect(f.grants).toEqual(original); expect(f.sessions.size).toBe(2);
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation).toMatchObject({id:'side-relation',sourceNativeSessionId:'A',linked:false,revision:1});
    await transport.broker.updateSessionRelation('owner',{...input,operationId:'relink-side',linked:true,expectedRevision:1});
    expect(JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8')).roles[0].participants.map((row:{after:{nativeSessionId:string}})=>row.after.nativeSessionId).sort()).toEqual(['ask','side']);
    expect(f.grants).toEqual(original);
  } finally { await transport.close(); await f.close(); }
});

test.each(['relation_reserve','relation_apply','relation_release'])('lost %s response keeps exact operation recoverable across both restarts', async lostAction => {
  const f = await fixture(false, true); const initial = coldAssociations(); initial.bindings = initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));
  const transport = await enrollmentTransport(f, initial);
  try {
    f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});
    await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1}); await transport.action('commit',{operationId:'relations'});
    let lost = false; transport.beforeControl(async input => { if(input.action===lostAction&&!lost){lost=true;throw new Error('Response was lost after durable Host write');} });
    const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'recover-edit',expectedRoleRevision:2};
    await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow();
    expect(transport.saved().associations!.relationChanges![0].phase).not.toBe('committed');
    const metadataCommitted = transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.revision===1;
    expect(metadataCommitted).toBe(lostAction!=='relation_reserve');
    expect(transport.broker.sessionRelations('owner')[0]).toMatchObject({source:{nativeSessionId:'A'},navigationSource:{hostId:transport.hostId,nativeSessionId:'B'}});
    const competing=await transport.action('prepare',{operationId:'blocked',providerId:'fixture',nativeSessionId:'B',expectedRevision:2});expect(competing!.status).toBe(409);
    transport.beforeControl(async()=>{}); await transport.restart(f.restart);
    expect(await transport.broker.resetSessionRelationChange('owner',input)).toMatchObject({operation:{phase:'committed'}});
    expect(transport.saved().associations!.relationResets).toEqual([]);
    expect(transport.broker.sessionRelations('owner')[0]!.navigationSource).toBeUndefined();
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.revision).toBe(1);
    const state=JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8'));
    expect(state.roles[0].associationRevision).toBe(2);expect(state.roles[0].participants).toEqual([]);expect(state.roles[0].relationChanges[0].phase).toBe('released');
    expect(f.creates()).toBe(1);expect(f.sourceCreates()).toBe(0);
  } finally {await transport.close();await f.close();}
});

test('metadata persistence failure after Host reserve remains recoverable without false success', async () => {
  const f=await fixture(false,true), initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
  try {
    f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});
    await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'relations'});
    const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'failed-metadata',expectedRoleRevision:2};
    transport.beforeControl(async value=>{if(value.action==='relation_reserve')transport.failBinding(true);});
    await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow(/storage/);
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.linked).toBe(true);
    expect(JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8')).roles[0].relationChanges[0].phase).toBe('reserved');
    transport.failBinding(false);transport.beforeControl(async()=>{});await transport.restart(f.restart);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'failed-metadata'})).toMatchObject({operation:{phase:'committed'}});
  } finally {await transport.close();await f.close();}
});

test('missing durable grant rejects reserve and retains the exact Broker edit for later reconcile', async () => {
  const f=await fixture(false,true), initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
  try {
    const grant={nativeSessionId:'side',sourceNativeSessionId:'A'};f.grants.push(grant);
    await transport.action('prepare',{operationId:'relations',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'relations'});
    f.grants.splice(0);
    const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'missing-grant',expectedRoleRevision:2};
    await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow(/native grant/);
    expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.linked).toBe(true);
    expect(transport.saved().associations!.relationChanges[0].phase).toBe('reserved');
    expect(()=>transport.broker.sessionRelationChangeStatus('viewer',{hostId:transport.hostId,operationId:'missing-grant'})).toThrow();
    f.grants.push(grant);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'missing-grant'})).toMatchObject({operation:{phase:'committed'}});
  } finally {await transport.close();await f.close();}
});

test('a current-B native reader stays fixed until the next B-to-C frozen enrollment',async()=>{
  const f=await fixture(false,true),transport=await enrollmentTransport(f);
  try {
    await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
    await transport.request(`/v1/remote/hosts/${transport.hostId}/attach`,{providerId:'fixture',nativeSessionId:'B'});
    const response=await transport.request(`/v1/remote/hosts/${transport.hostId}/create`,{providerId:'fixture',sourceNativeSessionId:'B',conversationKind:'side',conversationId:'current-b-side',operationId:'00000000-0000-4000-8000-000000000021'});
    expect(response!.status).toBe(200);
    const reader=transport.saved().bindings.find(row=>row.sourceRelation?.id==='00000000-0000-4000-8000-000000000021')!;
    expect(reader.sourceRelation!.nativeSourceRef).toEqual(ref('B'));
    expect(JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8')).roles[0].participants).toEqual([]);
    expect(transport.broker.sessionRelations('owner')[0]).toMatchObject({nativeSourceRef:ref('B'),sourceBinding:{kind:'fixed',source:ref('B')},source:{nativeSessionId:'B'},hostLocator:{hostId:transport.hostId,controllerId:'controller'}});
    expect((await transport.action('prepare',{operationId:'second',providerId:'fixture',nativeSessionId:'B',expectedRevision:2}))!.status).toBe(200);
    const secondCommit = await transport.action('commit',{operationId:'second'});
    expect(await secondCommit!.json()).toMatchObject({record:{phase:'committed'},role:{revision:3}});
    expect(transport.broker.sessionRelations('owner')[0]).toMatchObject({nativeSourceRef:ref('B'),sourceBinding:{kind:'primary_role'},source:{nativeSessionId:'C'}});
    expect(f.sourceCreates()).toBe(1);expect(f.grants).toEqual([{nativeSessionId:reader.nativeSessionId,sourceNativeSessionId:'B'}]);
  }finally{await transport.close();await f.close();}
});

test('a competing edit between describe and reserve rejects before persisting a stale Host clock',async()=>{
  const f=await fixture(false,true),transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...[{nativeSessionId:'side',sourceNativeSessionId:'A'},{nativeSessionId:'ask',sourceNativeSessionId:'A'},{nativeSessionId:'unlinked',sourceNativeSessionId:'A'},{nativeSessionId:'nested',sourceNativeSessionId:'side'}]);
    await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let first=true;
    transport.beforeControl(async input=>{if(input.action==='describe'&&first){first=false;enter();await gate;}});
    const side={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'slow-edit',expectedRoleRevision:2};
    const slow=transport.broker.updateSessionRelation('owner',side);void slow.catch(()=>{});await entered;
    await transport.broker.updateSessionRelation('owner',{...side,nativeSessionId:'unlinked',id:'unlinked-relation',linked:true,operationId:'fast-edit'});
    release();await expect(slow).rejects.toThrow(/changed|catalog/);
    expect(transport.saved().associations!.relationChanges.map(row=>row.reservation.operationId)).toEqual(['fast-edit']);
    expect(await transport.broker.updateSessionRelation('owner',side)).toMatchObject({operation:{phase:'committed'}});
  }finally{await transport.close();await f.close();}
});

test('concurrent exact same-ID relation describes join the saved operation before catalog drift checks',async()=>{
 const f=await fixture(false,true),initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
 try{
  f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
  let entered!:()=>void,release!:()=>void,count=0;const described=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  transport.beforeControl(async input=>{if(input.action==='describe'){count++;if(count===2)entered();await gate;}});
  const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'same-edit',expectedRoleRevision:2};
  const a=transport.broker.updateSessionRelation('owner',input),b=transport.broker.updateSessionRelation('owner',input);await described;release();
  const results=await Promise.all([a,b]);expect(results[0]).toEqual(results[1]);expect(transport.saved().associations!.relationChanges).toHaveLength(1);expect(transport.saved().bindings.find(row=>row.nativeSessionId==='side')!.sourceRelation!.revision).toBe(1);
 }finally{await transport.close();await f.close();}
});


test('durable exact pre-effect reset fences a delayed absent operation before reserve and after restart',async()=>{
 const f=await fixture(false,true),initial=coldAssociations();initial.bindings=initial.bindings.filter(row=>['A','side'].includes(row.nativeSessionId));const transport=await enrollmentTransport(f,initial);
 let release!:()=>void;
 try{
  f.grants.push({nativeSessionId:'side',sourceNativeSessionId:'A'});await transport.action('prepare',{operationId:'first',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'first'});
  let entered!:()=>void;const described=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let first=true,reserves=0;
  transport.beforeControl(async input=>{if(input.action==='relation_reserve')reserves++;if(input.action==='describe'&&first){first=false;entered();await gate;}});
  const input={hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'reset-old-edit',expectedRoleRevision:2};
  const slow=transport.broker.updateSessionRelation('owner',input);void slow.catch(()=>{});await described;
  expect(()=>transport.broker.sessionRelationChangeStatus('owner',input)).toThrow(/No pending/);
  await transport.action('prepare',{operationId:'second',providerId:'fixture',nativeSessionId:'B',expectedRevision:2});await transport.action('commit',{operationId:'second'});
  const reset=await transport.broker.resetSessionRelationChange('owner',input);expect(reset).toMatchObject({reset:{phase:'pre_effect',intent:{operationId:input.operationId}}});
  await expect(transport.broker.resetSessionRelationChange('other',input)).rejects.toThrow(/owner|access/);
  await expect(transport.broker.resetSessionRelationChange('owner',{...input,linked:true})).rejects.toThrow(/identity/);
  release();await expect(slow).rejects.toThrow(/reset/);expect(reserves).toBe(0);expect(transport.saved().associations!.relationChanges).toEqual([]);
  transport.beforeControl(async()=>{});await transport.restart(f.restart);
  await expect(transport.broker.updateSessionRelation('owner',input)).rejects.toThrow(/reset/);
  expect(await transport.broker.resetSessionRelationChange('owner',input)).toEqual(reset);
  await transport.broker.updateSessionRelation('owner',{...input,operationId:'fresh-edit',expectedRoleRevision:3});
  expect(transport.saved().associations!.relationChanges).toHaveLength(1);
  expect(await transport.broker.resetSessionRelationChange('owner',{...input,operationId:'fresh-edit',expectedRoleRevision:3})).toMatchObject({operation:{phase:'committed'}});
 }finally{release?.();await transport.close();await f.close();}
});


test('real WebSocket validation admission blocks first handoff and is released after rejection', async () => {
  const f = await fixture(); let finish!: () => void; let entered!: () => void;
  const validation = new Promise<void>(resolve => { finish = resolve; }); const waiting = new Promise<void>(resolve => { entered = resolve; });
  try {
    const attached = await f.attach('A'); const agent = f.host.relay.requireAgent(attached.agentId);
    agent.validateMessageContent = async () => { entered(); await validation; throw new Error('Invalid image preparation'); };
    const send = sendOverWebSocket(f.url, attached.agentId, 'blocked validation', '00000000-0000-4000-8000-000000000091', 'owner', true);
    await waiting;
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
    finish(); expect((await send).type).toBe('protocol_error');
    expect(f.sessions.get('A')!.sent).toEqual([]);
    expect((await f.control('prepare', { ...request, operationId: 'after-validation' })).payload.phase).toBe('ready');
  } finally { finish(); await f.close(); }
}, 10000);

test('retained queued input blocks first enablement for an existing role', async () => {
  const f = await fixture();
  try {
    const attached = await f.attach('A');
    expect((await sendOverWebSocket(f.url, attached.agentId, 'queued first', '00000000-0000-4000-8000-000000000092')).type).toBe('command_acknowledged');
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
  } finally { await f.close(); }
}, 10000);


const deferredBoundary = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('source reservation precedes store begin and exact retries join while unrelated WebSocket writes remain available', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  const original = SessionSuccessionStore.prototype.begin;
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'begin').mockImplementation(async function (input, local) {
    if (input.operationId === 'begin-reservation') { entered.resolve(); await gate.promise; }
    return original.call(this, input, local);
  });
  try {
    const a = await f.attach('A'); f.sessions.set('C', new Native('C', f.root)); const c = await f.attach('C');
    const input = { ...request, operationId: 'begin-reservation' };
    const preparing = f.control('prepare', input); await entered.promise;
    const retry = f.control('prepare', input);
    expect((await sendOverWebSocket(f.url, a.agentId, 'forbidden', '00000000-0000-4000-8000-000000000093')).type).toBe('protocol_error');
    expect((await sendOverWebSocket(f.url, c.agentId, 'unrelated', '00000000-0000-4000-8000-000000000094')).type).toBe('command_acknowledged');
    expect((await f.control('prepare', { ...input, operationId: 'different-attempt' })).status).toBe(409);
    expect(f.creates()).toBe(0); expect(f.sessions.get('A')!.sent).toEqual([]);
    gate.resolve(); expect((await preparing).payload.phase).toBe('ready'); expect((await retry).payload.phase).toBe('ready'); expect(f.creates()).toBe(1);
    expect((await f.control('cancel', { operationId: input.operationId })).payload.phase).toBe('cancelled');
    expect((await sendOverWebSocket(f.url, a.agentId, 'after cancel', '00000000-0000-4000-8000-000000000095')).type).toBe('command_acknowledged');
  } finally { gate.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('known candidate is fenced before save and cancellation cannot resurrect its reservation', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  const original = SessionSuccessionStore.prototype.saveCandidate;
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'saveCandidate').mockImplementation(async function (operationId, target) {
    entered.resolve(); await gate.promise; return original.call(this, operationId, target);
  });
  try {
    const a = await f.attach('A'); const preparing = f.control('prepare', request); await entered.promise; const b = await f.attach('B');
    for (const [agentId, id] of [[a.agentId, '96'], [b.agentId, '97']]) {
      expect((await sendOverWebSocket(f.url, agentId, 'forbidden before save', `00000000-0000-4000-8000-0000000000${id}`)).type).toBe('protocol_error');
    }
    const cancelling = f.control('cancel', { operationId: request.operationId }); gate.resolve();
    expect((await cancelling).payload.phase).toBe('cancelled'); await preparing;
    expect(f.sessions.get('A')!.sent).toEqual([]); expect(f.sessions.get('B')!.sent).toEqual([]);
    expect((await sendOverWebSocket(f.url, a.agentId, 'after cancellation', '00000000-0000-4000-8000-000000000098')).type).toBe('command_acknowledged');
    expect((await sendOverWebSocket(f.url, b.agentId, 'orphan', '00000000-0000-4000-8000-000000000099')).type).toBe('command_acknowledged');
    expect(f.creates()).toBe(1);
  } finally { gate.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('source and candidate remain excluded during commit publication and only committed B opens', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  const original = SessionSuccessionStore.prototype.commit;
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'commit').mockImplementation(async function (operationId, generation) {
    entered.resolve(); await gate.promise; return original.call(this, operationId, generation);
  });
  try {
    expect((await f.control('prepare', request)).payload.phase).toBe('ready');
    const a = await f.attach('A'), b = await f.attach('B'); const committing = f.control('commit', { operationId: 'handoff', expectedRevision: 1 }); await entered.promise;
    for (const [agentId, id] of [[a.agentId, '101'], [b.agentId, '102']]) expect((await sendOverWebSocket(f.url, agentId, 'forbidden', `00000000-0000-4000-8000-000000000${id}`)).type).toBe('protocol_error');
    gate.resolve(); expect((await committing).payload.phase).toBe('committed');
    expect((await sendOverWebSocket(f.url, a.agentId, 'superseded', '00000000-0000-4000-8000-000000000103')).type).toBe('protocol_error');
    expect((await sendOverWebSocket(f.url, b.agentId, 'continue', '00000000-0000-4000-8000-000000000104')).type).toBe('command_acknowledged');
  } finally { gate.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('native call lifetime blocks handoff while known completion survives a later local receipt failure', async () => {
  const f = await fixture(); const gate = deferredBoundary(), entered = deferredBoundary();
  try {
    const a = await f.attach('A'); const native = f.sessions.get('A')!;
    native.sendMessage = async text => { native.sent.push(text); entered.resolve(); await gate.promise; return { disposition: 'started' }; };
    const agent = f.host.relay.requireAgent(a.agentId), original = agent.sendMessage.bind(agent);
    agent.sendMessage = async (...args) => { await original(...args); throw new Error('Local receipt readback failed'); };
    const sending = sendOverWebSocket(f.url, a.agentId, 'complete native once', '00000000-0000-4000-8000-000000000105'); await entered.promise;
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
    gate.resolve(); expect(await sending).toMatchObject({ type: 'protocol_error', payload: { code: 'operation_outcome_unknown' } });
    expect((await f.control('prepare', { ...request, operationId: 'known-completed' })).payload.phase).toBe('ready');
    expect(native.sent).toHaveLength(1);
  } finally { gate.resolve(); await f.close(); }
}, 10000);

test('conflicting candidate admission persists its identity, rejects preparation and never repeats create', async () => {
  const f = await fixture(); const creating = deferredBoundary(), createEntered = deferredBoundary(), validating = deferredBoundary(), validateEntered = deferredBoundary();
  f.beforeIdleCreate(async () => { createEntered.resolve(); await creating.promise; });
  try {
    const preparing = f.control('prepare', request); await createEntered.promise;
    f.sessions.set('B', new Native('B', f.root)); const b = await f.attach('B');
    const agent = f.host.relay.requireAgent(b.agentId);
    agent.validateMessageContent = async () => { validateEntered.resolve(); await validating.promise; throw new Error('Invalid content'); };
    const sending = sendOverWebSocket(f.url, b.agentId, 'already admitted', '00000000-0000-4000-8000-000000000106', 'owner', true); await validateEntered.promise;
    creating.resolve(); expect(await preparing).toMatchObject({ status: 200, payload: { phase: 'rejected', to: ref('B'), failureCode: 'succession_candidate_busy' } });
    expect((await f.control('prepare', request)).payload.to).toEqual(ref('B')); expect(f.creates()).toBe(1);
    validating.resolve(); expect((await sending).type).toBe('protocol_error');
  } finally { creating.resolve(); validating.resolve(); await f.close(); }
}, 10000);

test('uncertain store begin publication retains the synchronous source fence', async () => {
  const f = await fixture();
  const { SuccessionPublicationUnknown } = await import('./succession-persistence.js');
  const spy = vi.spyOn(SessionSuccessionStore.prototype, 'begin').mockImplementation(async () => { throw new SuccessionPublicationUnknown('Uncertain storage'); });
  try {
    const a = await f.attach('A'); expect((await f.control('prepare', request)).status).toBe(409);
    expect((await sendOverWebSocket(f.url, a.agentId, 'fenced unknown begin', '00000000-0000-4000-8000-000000000107')).type).toBe('protocol_error');
    expect(f.creates()).toBe(0); expect(f.sessions.get('A')!.sent).toEqual([]);
  } finally { spy.mockRestore(); await f.close(); }
}, 10000);


test('restored durable role with fresh empty cache still requires native queue and work coverage', async () => {
  const f = await fixture();
  try {
    f.unavailableCoverage(); await f.restart();
    expect((await f.control('prepare', request)).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
    const a = await f.attach('A');
    expect((await sendOverWebSocket(f.url, a.agentId, 'ordinary remains available', '00000000-0000-4000-8000-000000000108')).type).toBe('command_acknowledged');
  } finally { await f.close(); }
}, 10000);

test('pre-role retained queued input blocks enrolled first enablement', async () => {
  const f = await fixture(false, true); const transport = await enrollmentTransport(f);
  try {
    const a = await f.attach('A');
    expect((await sendOverWebSocket(f.url, a.agentId, 'queued before role', '00000000-0000-4000-8000-000000000109')).type).toBe('command_acknowledged');
    const result = await transport.action('prepare', { providerId: 'fixture', nativeSessionId: 'A', operationId: 'first-role', expectedRevision: 1 });
    expect(result!.status).toBe(200); expect((await result!.json()).record.phase).toBe('rejected'); expect(f.creates()).toBe(0);
  } finally { await transport.close(); await f.close(); }
}, 10000);

test('real uplink authorizes snapshot provenance on its source provider and retains both create identities', async () => {
  const f = await fixture(false, true, undefined, true), transport = await enrollmentTransport(f);
  const path = `/v1/remote/hosts/${transport.hostId}/create`;
  try {
    await transport.request(`/v1/remote/hosts/${transport.hostId}/attach`, { providerId:'fixture', nativeSessionId:'A' });
    const input = { providerId:'fixture', operationId:'00000000-0000-4000-8000-000000000201', creationSource:{providerId:'other',nativeSessionId:'other-A'} };
    expect((await transport.request(path, input)).status).toBe(403);
    expect(f.snapshotConfigurations).toEqual([]);
    expect((await transport.request(`/v1/remote/hosts/${transport.hostId}/attach`, {providerId:'other',nativeSessionId:'other-A'})).status).toBe(200);
    const created = await transport.request(path, input); expect(created.status, await created.clone().text()).toBe(200);
    const result = await created.json();
    expect(await (await transport.request(path, input)).json()).toEqual(result);
    expect(f.snapshotConfigurations).toHaveLength(1);
    expect(f.snapshotConfigurations[0]).not.toHaveProperty('creationSource');
    expect(f.snapshotConfigurations[0]).not.toHaveProperty('sourceNativeSessionId');
    expect(f.snapshotConfigurations[0]).not.toHaveProperty('tools');
    expect(f.grants).toEqual([]);
    expect(transport.saved().bindings.find(row=>row.agentId===result.agentId)).not.toHaveProperty('sourceRelation');
    expect((await transport.request(path, {...input,creationSource:{providerId:'fixture',nativeSessionId:'A'}})).status).toBe(409);
    await transport.restart();
    expect(await (await transport.request(path, input)).json()).toEqual(result);
    expect((await transport.request(path, {...input,creationSource:{providerId:'fixture',nativeSessionId:'A'}})).status).toBe(409);
    expect(f.snapshotConfigurations).toHaveLength(1);
    for (const bad of [ {...input.creationSource,controllerId:'other-host'}, {...input.creationSource,hostId:'other-host'}, {...input.creationSource,nativeSessionId:' other-A'} ]) {
      expect((await transport.request(path, {...input,operationId:crypto.randomUUID(),creationSource:bad})).status).toBe(400);
    }
    expect((await transport.request(path, {...input,operationId:crypto.randomUUID(),sourceNativeSessionId:'A'})).status).toBe(400);
  } finally { await transport.close(); await f.close(); }
}, 10000);

test('relation persistence admission precedes async store publication and blocks a reader handoff', async () => {
  const f = await fixture(false, true, async root => {
    const store = new SessionSuccessionStore(join(root,'roles')); await store.ready;
    await store.createRole({id:'reader-role',revision:1,origin:ref('side'),current:ref('side'),workspace:{controllerId:'controller',canonicalCwd:root}});
  });
  f.sessions.set('side',new Native('side',f.root));
  const transport = await enrollmentTransport(f,coldAssociations()), gate=deferredBoundary(),entered=deferredBoundary();
  const original=SessionSuccessionStore.prototype.reserveRelationChange;
  const spy=vi.spyOn(SessionSuccessionStore.prototype,'reserveRelationChange').mockImplementation(async function(reservation,generation){
    if(reservation.operationId==='persisting-relation'){entered.resolve();await gate.promise;}
    return original.call(this,reservation,generation);
  });
  let changing: Promise<unknown> | undefined, coordinator: SessionSuccessionCoordinator | undefined;
  const prepare=SessionSuccessionCoordinator.prototype.prepareEnrolled;
  const prepareSpy=vi.spyOn(SessionSuccessionCoordinator.prototype,'prepareEnrolled').mockImplementation(function(...args){coordinator=this;return prepare.apply(this,args);});
  try {
    f.grants.push(...['side','ask','unlinked'].map(nativeSessionId=>({nativeSessionId,sourceNativeSessionId:'A'})),{nativeSessionId:'nested',sourceNativeSessionId:'side'});
    await transport.action('prepare',{operationId:'initial',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});
    await transport.action('commit',{operationId:'initial'});
    changing=transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'persisting-relation',expectedRoleRevision:2});
    await entered.promise;
    const before=await readFile(join(f.root,'roles','state.json'),'utf8');
    expect(JSON.parse(before).roles.find((row:{role:{current:{nativeSessionId:string}}})=>row.role.current.nativeSessionId==='B').relationChanges??[]).toEqual([]);
    expect(await coordinator!.prepare({operationId:'reader-during-write',roleId:'reader-role',expectedRevision:1,from:ref('side')})).toMatchObject({phase:'rejected'});
    expect(f.creates()).toBe(1); expect(f.sourceCreates()).toBe(0);
    gate.resolve(); await expect(changing).rejects.toThrow(/may have reached/);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'persisting-relation'})).toMatchObject({operation:{phase:'committed'}});
    expect(JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8')).roles.find((row:{role:{current:{nativeSessionId:string}}})=>row.role.current.nativeSessionId==='B').relationChanges[0].phase).toBe('released');
    expect((await coordinator!.prepare({operationId:'reader-after-write',roleId:'reader-role',expectedRevision:1,from:ref('side')})).phase).toBe('ready');
  } finally { gate.resolve();await changing?.catch(()=>undefined);spy.mockRestore();prepareSpy.mockRestore();await transport.close();await f.close(); }
},10000);

test.each(['A','B','side'])('fresh relation reserve refuses transient %s and preserves exact concurrent durable identity',async reserved=>{
  let boundary:SessionSuccessionBoundary|undefined;
  const install=SessionSuccessionCoordinator.prototype.setAdmission;
  const installSpy=vi.spyOn(SessionSuccessionCoordinator.prototype,'setAdmission').mockImplementation(function(admission){boundary=admission as SessionSuccessionBoundary;install.call(this,admission);});
  const f=await fixture(false,true),transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...['side','ask','unlinked'].map(nativeSessionId=>({nativeSessionId,sourceNativeSessionId:'A'})),{nativeSessionId:'nested',sourceNativeSessionId:'side'});
    await transport.action('prepare',{operationId:'initial',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'initial'});
    const grant=f.grants.shift()!;
    await expect(transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'blocked-relation',expectedRoleRevision:2})).rejects.toThrow(/native grant/);
    f.grants.unshift(grant);
    const reservation=transport.saved().associations!.relationChanges[0].reservation;
    f.sessions.set('C',new Native('C',f.root));await f.attach('C');
    boundary!.reserve('fixture-fence',ref('C'));boundary!.registerCandidate('fixture-fence',ref(reserved));
    const before=await readFile(join(f.root,'roles','state.json'),'utf8');
    const blocked=await transport.enrollmentRpc({action:'relation_reserve',reservation});
    expect(blocked.status,blocked.body).toBe(409);expect(JSON.parse(blocked.body).error).toMatch(/handoff/);
    expect(await readFile(join(f.root,'roles','state.json'),'utf8')).toBe(before);
    expect(f.creates()).toBe(1);expect(f.sourceCreates()).toBe(0);
    boundary!.releaseReservation('fixture-fence');
    const exact=await Promise.all([transport.enrollmentRpc({action:'relation_reserve',reservation}),transport.enrollmentRpc({action:'relation_reserve',reservation})]);
    expect(exact.map(row=>row.status)).toEqual([200,200]);expect(JSON.parse(exact[0].body)).toEqual(JSON.parse(exact[1].body));
    expect(JSON.parse(await readFile(join(f.root,'roles','state.json'),'utf8')).roles[0].relationChanges).toHaveLength(1);
    const changed=await transport.enrollmentRpc({action:'relation_reserve',reservation:{...reservation,linked:true}});
    expect(changed.status).toBe(409);expect(JSON.parse(changed.body).error).toMatch(/identity conflict/);
    expect(await transport.broker.reconcileSessionRelationChange('owner',{hostId:transport.hostId,operationId:'blocked-relation'})).toMatchObject({operation:{phase:'committed'}});
    expect(f.grants[0]).toEqual(grant);
  }finally{boundary?.releaseReservation('fixture-fence');installSpy.mockRestore();await transport.close();await f.close();}
},10000);

test('fresh relation reserve rejects a restored persistent old-source reservation without a transient fence',async()=>{
  const f=await fixture(false,true),transport=await enrollmentTransport(f,coldAssociations());
  try {
    f.grants.push(...['side','ask','unlinked'].map(nativeSessionId=>({nativeSessionId,sourceNativeSessionId:'A'})),{nativeSessionId:'nested',sourceNativeSessionId:'side'});
    await transport.action('prepare',{operationId:'initial',providerId:'fixture',nativeSessionId:'A',expectedRevision:1});await transport.action('commit',{operationId:'initial'});
    const grant=f.grants.shift()!;
    await expect(transport.broker.updateSessionRelation('owner',{hostId:transport.hostId,providerId:'fixture',nativeSessionId:'side',sourceNativeSessionId:'A',id:'side-relation',linked:false,expectedRevision:0,operationId:'restored-block',expectedRoleRevision:2})).rejects.toThrow(/native grant/);
    f.grants.unshift(grant);const reservation=transport.saved().associations!.relationChanges[0].reservation;
    await transport.restart(async()=>{
      const store=new SessionSuccessionStore(join(f.root,'roles'));await store.ready;
      await store.createRole({id:'old-source-role',revision:1,origin:ref('A'),current:ref('A'),workspace:{controllerId:'controller',canonicalCwd:f.root}});
      await store.begin({operationId:'durable-old-source',roleId:'old-source-role',expectedRevision:1,from:ref('A')});
      await f.restart();
    });
    await f.host.control({method:'GET',path:'/remote/workspaces?providerId=fixture'});
    const before=await readFile(join(f.root,'roles','state.json'),'utf8');
    const blocked=await transport.enrollmentRpc({action:'relation_reserve',reservation});
    expect(blocked.status,blocked.body).toBe(409);expect(JSON.parse(blocked.body).error).toMatch(/reserved for handoff/);
    expect(await readFile(join(f.root,'roles','state.json'),'utf8')).toBe(before);
    expect(f.creates()).toBe(1);expect(f.sourceCreates()).toBe(0);
  }finally{await transport.close();await f.close();}
},10000);


test('bulk stop rejects all captured targets before any cancellation when one source is reserved', async () => {
  const f = await fixture();
  try {
    f.sessions.get('A')!.capabilities.cancel = true; await f.attach('A');
    const c = new Native('C', f.root); c.capabilities.cancel = true; f.sessions.set('C', c); await f.attach('C');
    expect((await f.control('prepare', request)).payload.phase).toBe('ready');
    const stopped = await f.host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: '00000000-0000-4000-8000-000000000110' }) });
    expect(stopped.status).not.toBe(200); expect(c.cancels).toBe(0); expect(f.sessions.get('A')!.cancels).toBe(0);
    expect((await f.control('cancel', { operationId: 'handoff' })).payload.phase).toBe('cancelled');
    const after = await f.host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: '00000000-0000-4000-8000-000000000111' }) });
    expect(after.status).toBe(200); expect(c.cancels).toBe(1); expect(f.sessions.get('A')!.cancels).toBe(1);
  } finally { await f.close(); }
}, 10000);
