/**
 * Support for the S2 succession seam tests: a real Relay Broker (`createHostBroker`, durable, in memory) joined to a Controller Host's uplink
 * client through `relayConnection`, so no port is opened. `enrollmentTransport` also hands out the Relay's saved state, a restart of the Relay
 * from that state, and the places where a test breaks the wire (a dropped create response, a failed projection or binding save).
 * `coldAssociations` is a saved Relay state whose bindings carry session relations, as a Relay that never saw a handoff would hold them.
 */
import { once } from 'node:events';
import type { EventEmitter } from 'node:events';
import { expect } from 'vitest';
import { createHostBroker, type RemoteHostBrokerState } from '@orchardworks/agent-relay-core';
import { createRemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';
import { relayConnection } from '@orchardworks/agent-session-runtime/testing';
import type { successionHostFixture } from '@orchardworks/agent-remote-controller/succession-host-testing';

type SuccessionHost = Awaited<ReturnType<typeof successionHostFixture>>;
let relays = 0;
export async function enrollmentTransport(f: SuccessionHost, initial?: RemoteHostBrokerState, options:{installationId?:string;enrollment?:boolean;noAllowance?:boolean;legacyRelay?:boolean;legacyHost?:boolean;ceiling?:number;rpcTimeoutMs?:number}={}) {
  // The Relay and the Controller meet in memory: the uplink client's `connect` is answered by the Relay's own `prepareUpgrade`.
  // Each transport is another Relay with its own origin, as a new listener port was.
  const origin = `http://relay-${++relays}.example`;
  const authority = { version: 1 as const, origin, issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
  let saved: RemoteHostBrokerState | undefined; let dropCreationResponse=false;const createRequests=new Set<string>();let failProjection = false, failBinding=false; let beforeControl=async(_input:{action?:string;freeze?:unknown})=>{};
  const makeBroker=(initialState?:RemoteHostBrokerState)=>createHostBroker({ origin, ownerSubject: 'owner', durable: true, successionEnrollment: authority, ...(options.noAllowance ? {} : { successionProjectionAllowance: () => options.ceiling ?? 2 * 1024 * 1024 }), initialState,
    onStateChange: async state => { if (failProjection && state.associations?.freezes.some(item => item.released)) throw new Error('Projection storage unavailable'); if(failBinding&&state.bindings.some(item=>item.sourceRelation))throw new Error('Binding storage unavailable'); saved = structuredClone(state); }, rpcTimeoutMs: options.rpcTimeoutMs ?? 2000 });
  let broker=makeBroker(initial);
  const closers: Array<() => void | Promise<void>> = [];
  const link = relayConnection(() => broker, closers, {
    query: endpoint => { if (options.legacyRelay) endpoint.searchParams.delete('successionEnrollment'); },
    deliver: (direction, json) => {
      const message = JSON.parse(json);
      if (direction === 'relay->controller' && message.type === 'rpc_request' && message.path === '/remote/create') createRequests.add(message.requestId);
      if (direction === 'controller->relay' && dropCreationResponse && message.type === 'rpc_response' && createRequests.has(message.requestId)) { dropCreationResponse = false; return false; }
      return true;
    },
  });
  const request = async (path:string, body:unknown, subject='owner') => (await broker.handleRequest(new Request(origin+path, {method:'POST',body:JSON.stringify(body)}), { principalSubject: () => subject }))!;
  const enrollmentRpc = (input: unknown): Promise<{status:number;body:string}> => new Promise((resolve,reject) => {
    const socket=link.servers.filter(item=>item.readyState===1).at(-1), requestId=crypto.randomUUID();
    if(!socket){reject(new Error('Registered fixture uplink is unavailable.'));return;}
    const timer=setTimeout(()=>{cleanup();reject(new Error('Fixture enrollment RPC deadline exceeded.'));},3000);
    const cleanup=()=>{clearTimeout(timer);stop();};
    const stop=socket.onMessage(data=>{const message=JSON.parse(data);if(message.type==='rpc_response'&&message.requestId===requestId){cleanup();resolve(message);}});
    socket.send(JSON.stringify({uplinkVersion:2,type:'rpc_request',requestId,method:'POST',path:'/remote/succession/enrollment',body:JSON.stringify(input)}));
  });
  const connect=async()=>{
    const pairing=await (await request('/v1/remote/pairings',{}))!.json();
    if (options.legacyHost) {
      const socket = link.connect(new URL(origin.replace('http:', 'ws:') + '/ws/remote-host?successionEnrollment=1'), { authorization: `Bearer ${pairing.key}`, maxPayload: 1 << 20, handshakeTimeout: 3000 }) as unknown as EventEmitter & { send(json: string): void; terminate(): void };
      let resolveReady!: (value: { hostId: string }) => void;
      const ready = new Promise<{hostId:string}>(resolve => { resolveReady = resolve; });
      socket.on('message', (data: Buffer) => { void (async () => {
        const message = JSON.parse(data.toString());
        if (message.type === 'credential_issued') socket.send(JSON.stringify({uplinkVersion:2,type:'credential_saved'}));
        if (message.type === 'registered') { expect(message.successionEnrollmentVersion).toBeUndefined(); resolveReady(message); }
        if (message.type === 'heartbeat') socket.send(JSON.stringify({uplinkVersion:2,type:'heartbeat_ack',nonce:message.nonce}));
        if (message.type === 'rpc_request') {
          const result = message.path === '/remote/succession/enrollment'
            ? await f.host.enrollFromRelay(message,{authority,installationId:'controller',successionEnrollmentVersion:1})
            : await f.host.control(message);
          socket.send(JSON.stringify({uplinkVersion:2,type:'rpc_response',requestId:message.requestId,...result}));
        }
      })().catch(error => { socket.terminate(); throw error; }); });
      await once(socket,'open',{signal:AbortSignal.timeout(3000)});
      socket.send(JSON.stringify({uplinkVersion:2,type:'register',installationId:'controller',name:'Legacy',providers:f.providerDescriptors,credentialRotation:true}));
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([ready,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Legacy registration deadline')),3000);})]); } finally {clearTimeout(deadline);}
      return {ready,close:async()=>{socket.terminate();}};
    }
    return createRemoteHostUplinkClient({relay:f.host.relay,installationId:options.installationId??'controller',name:'Fixture',providers:f.providerDescriptors,connect:link.connect,
      remoteKey:pairing.key,onCredential:async()=>{},url:origin.replace('http:','ws:')+'/ws/remote-host',resolveSession:f.host.resolveSession,acquireSession:f.host.acquireSession,
      control:f.host.control,...(options.enrollment===false?{}:{successionEnrollment:{control:async(request,context)=>{const result=await f.host.enrollFromRelay(request,context);await beforeControl(JSON.parse(request.body??'{}'));return result;}}})});
  };
  let client=await connect();const {hostId}=await client.ready;
  return {get client(){return client;},get broker(){return broker;},authority,request,enrollmentRpc,hostId,restart:async(beforeConnect?:()=>Promise<void>)=>{await client.close();broker.close();await beforeConnect?.();broker=makeBroker(saved);client=await connect();await client.ready;},failBinding:(value:boolean)=>{failBinding=value;},dropCreationResponse:()=>{dropCreationResponse=true;},beforeControl:(hook:typeof beforeControl)=>{beforeControl=hook;},failProjection:(value:boolean)=>{failProjection=value;},saved:()=>structuredClone(saved!),action:(action:string,input:unknown,subject='owner')=>request(`/v1/remote/hosts/${hostId}/succession/${action}`,input,subject),
    close:async()=>{await client.close();broker.close();for(const close of closers.splice(0).reverse())await close();}};
}


export function coldAssociations(): RemoteHostBrokerState {
  const hostId='cold-host';
  const relation=(id:string,kind:'side'|'ask',sourceNativeSessionId:string,linked=true)=>({id,kind,sourceNativeSessionId,linked,revision:0,createdAt:'2026-10-10T00:00:00.000Z'});
  return {keys:[],hosts:[{id:hostId,installationId:'controller',name:'Fixture',legacyDsh:false,providers:[{providerId:'fixture',displayName:'Fixture'}]}],creations:[],bindings:[
    {hostId,providerId:'fixture',nativeSessionId:'A',agentId:'main'},
    ...[['side',relation('side-relation','side','A')],['ask',relation('ask-relation','ask','A')],['unlinked',relation('unlinked-relation','side','A',false)],['nested',relation('nested-relation','ask','side')]].map(([id,sourceRelation])=>({hostId,providerId:'fixture',nativeSessionId:id as string,agentId:id as string,sourceRelation:sourceRelation as ReturnType<typeof relation>})),
  ]};
}
