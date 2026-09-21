import React from 'react';
import {createRoot} from 'react-dom/client';
import {App, type LabTransport} from '../src/App';
import {replicaState} from '../src/test/fixtures';
import '../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';
const count=Number(new URLSearchParams(location.search).get('count') || 100);
const paragraph='The session keeps its current workspace and native runtime. We review the implementation, preserve the draft, and wait for a ready connection before sending. ';
const entries=Array.from({length:count},(_,i)=>({providerId:'recorded',seqStart:i+1,seqEnd:i+1,timestamp:'2026-09-22T00:00:00Z',sourceSeqRanges:[],collapsed:[],resources:[],item:i%3===0 ? {type:'user_message' as const,text:`Review step ${i}. Please check the current implementation.`,messageId:`u${i}`} : {type:'assistant_message' as const,text:`### Review ${i}\n\n${paragraph.repeat(3)}\n\n- Preserve the current workspace.\n- Check the connection and pending message.\n- Keep the reading position stable.\n\nUse \`agent-remote-controller\` to connect.`,messageId:`a${i}`}}));
const state={...replicaState,agent: {...replicaState.agent!, capabilities:{...replicaState.agent!.capabilities, ...(location.search.includes('rich') ? {imageInput:{mediaTypes:['image/png' as const],maxImages:8,maxImageBytes:10485760,maxMessageBytes:20971520}} : {})}},timeline:{...replicaState.timeline,entries,hasOlder:false,nextSeq:count+1}};
const transport: LabTransport = {
 listProviders: async()=>[], createAgent:async()=>{throw new Error('unused')},resumeAgent:async()=>{throw new Error('unused')},
 fetchSnapshot:async()=>({protocolVersion:'1.5.0',type:'agent_snapshot',payload:state.agent}),fetchTimeline:async()=>{throw new Error('unused')},
 connect:(id,listener)=>{queueMicrotask(()=>listener.onOpen());return {close(){},send(message){if(message.type==='negotiate')queueMicrotask(()=>listener.onMessage({protocolVersion:'1.5.0',type:'agent_activity',payload:{agentId:id,status:'idle'}}))}}},
 onDiagnostic:()=>()=>{},onProtocolMessage:()=>()=>{},
};
createRoot(document.getElementById('root')!).render(<App transport={transport} initialState={state} initialSessionStatus="ready" actions={{sendMessage:async()=>{}}}/>);
