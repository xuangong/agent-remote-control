import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { RESOURCE_INPUT_CAPABILITIES, type AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { createProtocolValidationServer } from './server.js';
import { createDebuggerServer } from '../../agent-remote-debugger/src/server.js';
const provider: AgentProviderAdapter={descriptor:{providerId:'fixture',displayName:'Fixture'},async createSession(config){let close!:()=>void;const ended=new Promise<void>(resolve=>close=resolve);return {capabilities:{history:true,sendMessage:true,readResource:false,steer:false,cancel:false,resourceInput:RESOURCE_INPUT_CAPABILITIES,interactions:{question:false,planApproval:false,toolApproval:false}},async *observe(){yield {type:'history_boundary' as const};await ended;},async sendMessage(){},async sendMessageContent(){},async respondToInteraction(){},async runtimeInfo(){return {providerId:'fixture',sessionId:config.sessionId,status:'idle' as const};},async dispose(){close();}};},async resumeSession(){throw new Error('unused');}};
it.each(['lab','debugger'])('%s production composition enables resource uploads on real WebSocket',async kind=>{
 const directory=await mkdtemp(join(tmpdir(),'resource-server-')); let shutdown:()=>Promise<void>=async()=>{};let socket:WebSocket|undefined;
 try{
  let url:string,agentId:string,origin:string;
  if(kind==='lab') {const server=createProtocolValidationServer({providers:[provider],labOrigin:'http://127.0.0.1:5175',imageDirectory:join(directory,'images'),resourceDirectory:join(directory,'resources'),teamResourceDirectory:join(directory,'team-resources')});shutdown=()=>server.close();url=(await server.http.listen(0,'127.0.0.1')).url;origin='http://127.0.0.1:5175';agentId='agent';await server.relay.createAgent({protocolVersion:PROTOCOL_VERSION,type:'create_agent',payload:{requestId:randomUUID(),operationId:randomUUID(),agentId,providerId:'fixture',config:{sessionId:'native'}}});}
  else{await writeFile(join(directory,'index.html'),'test');const server=await createDebuggerServer({adapter:provider,assetsDirectory:directory,resourceDirectory:join(directory,'resources')});shutdown=()=>server.close();url=server.url;origin=url;agentId=server.agentId;}
  socket=new WebSocket(`${url.replace('http','ws')}/v1/sessions/${agentId}/events`,{headers:{origin}});const messages:any[]=[];socket.on('message',data=>messages.push(JSON.parse(data.toString())));await once(socket,'open');
  const wait=async(type:string,predicate=(m:any)=>true)=>{const deadline=Date.now()+2000;while(Date.now()<deadline){const index=messages.findIndex(m=>m.type===type&&predicate(m));if(index>=0)return messages.splice(index,1)[0];await new Promise(r=>setTimeout(r,10));}throw new Error('response timeout '+type+' '+JSON.stringify(messages));};
  socket.send(JSON.stringify({protocolVersion:PROTOCOL_VERSION,type:'negotiate'}));await wait('negotiated');const state=await wait('session_control');socket.send(JSON.stringify({protocolVersion:PROTOCOL_VERSION,type:'session_control_request',payload:{agentId,requestId:'control',action:'take_over',revision:state.payload.revision}}));const control=await wait('session_control',m=>m.payload.requestId==='control');
  socket.send(JSON.stringify({protocolVersion:PROTOCOL_VERSION,type:'resource_upload_begin',controlToken:control.payload.token,payload:{requestId:'begin',agentId,uploadId:'empty',name:'empty.txt',mediaType:'text/plain',byteLength:0,sha256:createHash('sha256').update('').digest('hex')}}));expect((await wait('resource_upload_result')).payload.offset).toBe(0);
 }finally{socket?.terminate();await shutdown();await rm(directory,{recursive:true,force:true});}
},10000);
