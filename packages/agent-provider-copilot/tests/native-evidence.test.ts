import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { parseAgentPreparedTextInput, serializeAgentPreparedTextInput, type AgentSessionNativeEvidence } from '@orchardworks/agent-provider-sdk';
import { CopilotAgentProvider } from '../src/provider.js';
import { fixture, observe, reply, waitFor, type ModelRequest } from './native-fixture.js';

function coldProvider(f: Awaited<ReturnType<typeof fixture>>) {
  return new CopilotAgentProvider({useLoggedInUser:false,requestTimeoutMs:5000,
    env:{COPILOT_HOME:join(f.home,'profile'),GITHUB_TOKEN:undefined,GH_TOKEN:undefined,COPILOT_GITHUB_TOKEN:undefined},
    nativeSessionConfig:{provider:{type:'openai',baseUrl:f.baseUrl,wireApi:'completions'}},
  });
}
async function ready(evidence:AgentSessionNativeEvidence) {
  let facts:Awaited<ReturnType<AgentSessionNativeEvidence['inspectReadiness']>>|undefined;
  await waitFor(async () => {
    try {facts=await evidence.inspectReadiness();return true;}
    catch(error) {if((error as {code?:string}).code==='native_evidence_stale') return false;throw error;}
  });
  return facts!;
}

it('retains a zero-input descriptor across native server lifetimes and resumes materialized history without replay',async () => {
  const held:Array<{body:ModelRequest;res:ServerResponse}>=[];
  const f=await fixture((body,res)=>held.push({body,res}));
  let owner=f.provider;
  try {
    const source=await owner.createSession({sessionId:'source',cwd:f.cwd,model:'gpt-5.4',reasoningEffort:'high'});
    await source.setSessionSetting('tool_approval_mode','allow');
    const creation=await owner.nativeEvidence!.createEmpty({sessionId:'successor',cwd:f.cwd,selectionSourceSessionId:(await source.runtimeInfo()).sessionId});
    if(creation.status!=='created') throw new Error('Expected prepared empty session');
    expect(creation.handle.sessionId).toBe('successor');
    expect(JSON.parse(creation.handle.opaque).selections).toMatchObject({model:'gpt-5.4',reasoningEffort:'high',toolApproval:'allow'});
    expect(f.requests).toHaveLength(0);
    await owner.dispose();owner=coldProvider(f);

    await expect(owner.resumeSession(creation.handle)).rejects.toThrow(/Session not found/);
    expect(f.requests).toHaveLength(0);
    let successor=await owner.resumeSession(creation.handle,{}, {initializeEmpty:true});
    expect(await successor.runtimeInfo()).toMatchObject({sessionId:'successor',model:'gpt-5.4'});
    await successor.setSessionSetting('tool_approval_mode','ask');
    await successor.setPlanning(true);
    const updated=(await successor.runtimeInfo()).persistence!;
    expect(JSON.parse(updated.opaque).selections).toMatchObject({mode:'plan',toolApproval:'ask'});
    expect(f.requests).toHaveLength(0);
    await owner.dispose();owner=coldProvider(f);
    successor=await owner.resumeSession(updated,{}, {initializeEmpty:true});
    expect(await successor.runtimeInfo()).toMatchObject({sessionId:'successor',cwd:await realpath(f.cwd),mode:'plan'});
    expect((await successor.runtimeInfo()).settings).toContainEqual(expect.objectContaining({id:'tool_approval_mode',value:'ask'}));
    await successor.setPlanning(false);
    expect(f.requests).toHaveLength(0);

    const seen=observe(successor);const evidence=successor.nativeEvidence!;
    const witness=await evidence.prepareInput([{type:'text',text:'EXACT_SUCCESSION_INPUT'}],{delivery:'immediate'});
    await evidence.dispatchInput(witness);
    await waitFor(()=>held.length===1);
    const proof=await evidence.inspectInput(witness);
    expect(proof).toMatchObject({status:'materialized',execution:{disposition:'started'}});
    const {delivery:_delivery,...selections}=parseAgentPreparedTextInput(serializeAgentPreparedTextInput(witness)).selections;
    expect(proof).toMatchObject({proof:{nativeSelectionsSha256:createHash('sha256').update(JSON.stringify(selections)).digest('hex')}});
    const journal=await successor.rpc.eventLog.read({max:1000,includeEphemeral:false});
    const user=journal.events.find(event=>event.type==='user.message');
    const start=journal.events.find(event=>event.type==='assistant.turn_start');
    expect(proof).toMatchObject({proof:{inputId:witness.inputId,nativeInputId:user?.id},execution:{nativeExecutionId:start?.id}});
    expect((await ready(evidence)).idle).toBe(false);
    await successor.sendMessage('QUEUED_SUCCESSION_INPUT',{delivery:'next_turn'});
    expect((await ready(evidence)).pendingInputs).toBe(1);
    expect(f.requests).toHaveLength(1);
    reply(held[0]!.res,held[0]!.body,'FIRST_COMPLETE');
    await waitFor(()=>held.length===2);
    reply(held[1]!.res,held[1]!.body,'SECOND_COMPLETE');
    await waitFor(()=>seen.events().filter(event=>event.type==='turn_completed').length===2);
    await successor.setPlanning(true);
    await waitFor(async ()=>(await owner.listSessions()).some(session=>session.nativeSessionId==='successor'));
    await owner.dispose();await seen.done;owner=coldProvider(f);

    // The creation handle describes preparation, not the current settings of saved history.
    const resumed=await owner.resumeSession(creation.handle,{}, {initializeEmpty:true});const history=observe(resumed);
    expect((await resumed.runtimeInfo()).mode).toBe('plan');
    await waitFor(()=>history.items.some(item=>item.type==='history_boundary'));
    expect(history.timeline().filter(row=>row.item.type==='user_message')).toHaveLength(2);
    expect(await resumed.nativeEvidence!.inspectInput(witness)).toMatchObject({status:'unknown'});
    expect(f.requests).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally {
    for(const pending of held) if(!pending.res.writableEnded) pending.res.destroy();
    await owner.dispose();await f.close();
  }
},60000);

it('reports a native pending approval and only reopens admission after the turn completes',async () => {
  const f=await fixture((body,res,index)=>reply(res,body,index===1?{name:'bash',arguments:{command:'echo EVIDENCE_APPROVAL',description:'Print marker'}}:'APPROVAL_COMPLETE'));
  try {
    const session=await f.provider.createSession({sessionId:'approval',cwd:f.cwd,model:'gpt-4.1'});
    const seen=observe(session);const evidence=session.nativeEvidence!;
    await ready(evidence);const token=evidence.captureValidity();
    await session.sendMessage('Request a tool approval.');
    await waitFor(()=>seen.events().some(event=>event.type==='interaction_requested'));
    expect(await ready(evidence)).toMatchObject({idle:false,pendingInteractions:1});
    expect(evidence.isCurrent(token)).toBe(false);
    const request=seen.events().find(event=>event.type==='interaction_requested');
    if(request?.type!=='interaction_requested') throw new Error('Expected approval');
    await session.respondToInteraction(request.request.requestId,{kind:'tool_approval',decision:'allow',scope:'once'});
    await waitFor(()=>seen.events().some(event=>event.type==='turn_completed'));
    expect(await ready(evidence)).toMatchObject({idle:true,pendingInputs:0,pendingInteractions:0,activeChildren:0});
    expect(f.errors).toEqual([]);
  } finally {await f.close();}
},45000);

it('keeps a running native background child visible after the foreground turn is idle',async () => {
  let childRequest:{body:ModelRequest;res:ServerResponse}|undefined;
  const f=await fixture((body,res,index)=>{
    if(index===1) reply(res,body,{name:'task',arguments:{name:'Evidence child',description:'Hold child for readiness',prompt:'HELD_EVIDENCE_CHILD',agent_type:'general-purpose',model:'gpt-4.1',mode:'background'}});
    else if(body.messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('HELD_EVIDENCE_CHILD'))) childRequest={body,res};
    else reply(res,body,'FOREGROUND_COMPLETE');
  });
  try {
    const session=await f.provider.createSession({sessionId:'parent',cwd:f.cwd,model:'gpt-4.1'});const seen=observe(session);
    await session.sendMessage('Create a background task.');
    await waitFor(()=>childRequest&&seen.events().some(event=>event.type==='turn_completed'));
    const evidence=session.nativeEvidence!;
    expect(await ready(evidence)).toMatchObject({idle:true,activeChildren:1});
    const witness=await evidence.prepareInput([{type:'text',text:'MUST_NOT_DISPATCH_WHILE_CHILD_ACTIVE'}]);
    await expect(evidence.dispatchInput(witness)).rejects.toMatchObject({code:'native_evidence_admission'});
    expect(JSON.stringify(f.requests)).not.toContain('MUST_NOT_DISPATCH_WHILE_CHILD_ACTIVE');
    reply(childRequest!.res,childRequest!.body,'CHILD_COMPLETE');
    await waitFor(async ()=>!(await ready(evidence)).activeChildren);
    expect(f.errors).toEqual([]);
  } finally {if(childRequest&&!childRequest.res.writableEnded) childRequest.res.destroy();await f.close();}
},45000);
