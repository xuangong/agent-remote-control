import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import { createAgentRemoteRelay } from '../relay.js';
import { createRemoteHostUplinkClient } from './remote-host-uplink-client.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 5000);
async function connection(acknowledged: boolean) {
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening',{signal:AbortSignal.timeout(3000)});
  cleanup.push(async()=>{for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const authority={version:1 as const,origin,issuer:'https://issuer.example',namespace:'tenant',ownerSubject:'owner'};
  const registered={uplinkVersion:2,type:'registered',hostId:'host',heartbeat:{intervalMs:30000,timeoutMs:10000},successionEnrollment:authority,...(acknowledged?{successionEnrollmentVersion:2}:{})};
  const responses: Array<{requestId:string;status:number;body:string}>=[];
  let query='',socket!:import('ws').WebSocket;
  server.on('connection',(next,request)=>{socket=next;query=new URL(request.url!,origin).searchParams.get('successionEnrollment')!;socket.on('message',data=>{
    const message=JSON.parse(data.toString());
    if(message.type==='register'){socket.send(JSON.stringify(registered));socket.send(JSON.stringify(registered));}
    if(message.type==='rpc_response')responses.push(message);
  });});
  const relay=createAgentRemoteRelay({providers:[]});cleanup.push(()=>relay.close());
  const contexts: unknown[]=[];
  const client=createRemoteHostUplinkClient({relay,installationId:'installation',name:'Fixture',remoteKey:'secret',url:origin.replace('http:','ws:')+'/ws/remote-host',providers:[],resolveSession:()=>undefined,
    control:()=>({status:200,body:'{"ordinary":true}'}),successionEnrollment:{control:(_request,context)=>{contexts.push(context);return{status:200,body:'{}'};}}});
  cleanup.push(()=>client.close());await client.ready;
  const rpc=async(requestId:string,path:string)=>{
    socket.send(JSON.stringify({uplinkVersion:2,type:'rpc_request',requestId,method:'POST',path,body:'{}'}));
    await expect.poll(()=>responses.find(response=>response.requestId===requestId),{timeout:3000}).toBeDefined();
    return responses.find(response=>response.requestId===requestId)!;
  };
  return{query,registered,socket,rpc,contexts};
}

test.each([true,false])('duplicate registration retains acknowledged v2 trust only: %s',async acknowledged=>{
  const f=await connection(acknowledged);expect(f.query).toBe('2');
  expect((await f.rpc('ordinary','/remote/controller-update')).status).toBe(200);
  const enrolled=await f.rpc('enrolled','/remote/succession/enrollment');
  expect(enrolled.status).toBe(acknowledged?200:403);
  expect(f.contexts).toHaveLength(acknowledged?1:0);
  if(acknowledged)expect(f.contexts[0]).toMatchObject({successionEnrollmentVersion:2,authority:{version:1},installationId:'installation'});
  else expect(JSON.parse(enrolled.body)).toMatchObject({code:'succession_enrollment_unavailable'});
},10000);

test('a duplicate registration that changes negotiated feature version retires the connection',async()=>{
  const f=await connection(true),closed=once(f.socket,'close',{signal:AbortSignal.timeout(3000)});
  f.socket.send(JSON.stringify({...f.registered,successionEnrollmentVersion:undefined}));
  await closed;expect(f.contexts).toEqual([]);
},10000);
