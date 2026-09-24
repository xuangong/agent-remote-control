import { describe, expect, it } from 'vitest';
import { ClaudeInteractions } from './interactions.js';
import type { AgentStreamEvent } from '@orchardworks/agent-provider-sdk';

describe('Claude native permissions', () => {
  it('waits for a validated one-time approval and rejects broader scopes', async () => {
    const events: AgentStreamEvent[] = [];
    const interactions = new ClaudeInteractions((event) => events.push(event));
    const result = interactions.request('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool' });
    const request = events.find((event) => event.type === 'interaction_requested');
    if (request?.type !== 'interaction_requested') throw new Error('Missing request');
    expect(() => interactions.respond(request.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'session' })).toThrow();
    interactions.respond(request.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    await expect(result).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } });
    expect(() => interactions.respond(request.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' })).toThrow();
  });

  it('maps question choices and custom answers back to native question text', async () => {
    const events: AgentStreamEvent[] = [];
    const interactions = new ClaudeInteractions((event) => events.push(event));
    const result = interactions.request('AskUserQuestion', { questions: [{ header: 'Color', question: 'Choose a color', multiSelect: false,
      options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] },
    { signal: new AbortController().signal, toolUseID: 'question-tool' });
    const event = events.find((event) => event.type === 'interaction_requested');
    if (event?.type !== 'interaction_requested' || event.request.kind !== 'question') throw new Error('Missing question');
    interactions.respond(event.request.requestId, { kind: 'question', answers: [{ questionId: event.request.questions[0]!.questionId, selectedValues: ['Red'] }] });
    await expect(result).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Choose a color': 'Red' } } });
  });

  it('settles aborted permission requests and rejects stale responses', async () => {
    const events: AgentStreamEvent[] = [];
    const interactions = new ClaudeInteractions((event) => events.push(event));
    const controller = new AbortController();
    const result = interactions.request('Bash', {}, { signal: controller.signal, toolUseID: 'tool' });
    controller.abort();
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
    expect(events.some((event) => event.type === 'interaction_resolved')).toBe(true);
    expect(interactions.size).toBe(0);
  });
});

it('offers native suggested grants for this session without writing persistent settings', async () => {
 const events: AgentStreamEvent[]=[];
 const interactions=new ClaudeInteractions(event=>events.push(event));
 const suggestions=[{type:'addRules' as const,behavior:'allow' as const,destination:'localSettings' as const,rules:[{toolName:'Bash',ruleContent:'pwd'}]}];
 const pending=interactions.request('Bash',{command:'pwd'},{signal:new AbortController().signal,toolUseID:'grant',suggestions});
 const event=events.find(event=>event.type==='interaction_requested');
 if(event?.type!=='interaction_requested')throw new Error('Missing approval');
 expect(event.request).toMatchObject({allowScopes:['once','session']});
 suggestions[0]!.rules[0]!.ruleContent='*';
 interactions.respond(event.request.requestId,{kind:'tool_approval',decision:'allow',scope:'session'});
 await expect(pending).resolves.toMatchObject({behavior:'allow',updatedPermissions:[{type:'addRules',behavior:'allow',destination:'session',rules:[{toolName:'Bash',ruleContent:'pwd'}]}]});
});

it('does not widen a native mode-change suggestion into a session grant', async () => {
 const events:AgentStreamEvent[]=[];const interactions=new ClaudeInteractions(event=>events.push(event));
 const pending=interactions.request('Bash',{command:'pwd'},{signal:new AbortController().signal,toolUseID:'mode',suggestions:[{type:'setMode',mode:'bypassPermissions',destination:'session'}]});
 const event=events.find(event=>event.type==='interaction_requested');if(event?.type!=='interaction_requested')throw new Error('Missing approval');
 expect(event.request).toMatchObject({allowScopes:['once']});
 interactions.respond(event.request.requestId,{kind:'tool_approval',decision:'allow',scope:'once'});
 await expect(pending).resolves.toEqual({behavior:'allow',updatedInput:{command:'pwd'}});
});

it('preserves the complete native rule and directory grant and shows its scope',async()=>{
 const events:AgentStreamEvent[]=[];const interactions=new ClaudeInteractions(event=>events.push(event));
 const pending=interactions.request('Bash',{command:'echo ok > result'},{signal:new AbortController().signal,toolUseID:'directory',suggestions:[
  {type:'addRules',rules:[{toolName:'Bash',ruleContent:'echo ok > result'}],behavior:'allow',destination:'localSettings'},
  {type:'addDirectories',directories:['/work'],destination:'session'}]});
 const event=events.find(event=>event.type==='interaction_requested');if(event?.type!=='interaction_requested')throw new Error('Missing approval');
 expect(event.request).toMatchObject({allowScopes:['once','session'],context:expect.arrayContaining([expect.objectContaining({value:expect.stringContaining('/work')})])});
 interactions.respond(event.request.requestId,{kind:'tool_approval',decision:'allow',scope:'session'});
 await expect(pending).resolves.toMatchObject({updatedPermissions:[{type:'addRules',destination:'session'},{type:'addDirectories',directories:['/work'],destination:'session'}]});
});
