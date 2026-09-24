import { describe, expect, it } from 'vitest';
import { ClaudeEventProjector } from './projector.js';

const envelope = { session_id: 'session', parent_tool_use_id: null };
function assistant(uuid: string, content: unknown[]) {
  return { ...envelope, type: 'assistant', uuid, message: { id: 'msg', role: 'assistant', content } };
}
function stream(event: unknown) { return { ...envelope, type: 'stream_event', event }; }

describe('Claude event projection', () => {
  it('appends streamed text exactly once when completed blocks and replay arrive', () => {
    const projector = new ClaudeEventProjector('session');
    const frames = [stream({ type: 'message_start', message: { id: 'msg' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      assistant('a1', [{ type: 'text', text: 'Hello' }]), assistant('a1', [{ type: 'text', text: 'Hello' }])];
    const events = frames.flatMap((frame) => projector.project(frame));
    const texts = events.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'assistant_message' ? [event.item.text] : []);
    expect(texts).toEqual(['Hel', 'lo']);
    expect(new Set(events.map(({ sourceKey }) => sourceKey)).size).toBe(events.length);
  });

  it('keeps multiple completed blocks with the same native message ID distinct', () => {
    const projector = new ClaudeEventProjector('session');
    const events = [assistant('a1', [{ type: 'thinking', thinking: 'Considering.' }]),
      assistant('a2', [{ type: 'text', text: 'First.' }]), assistant('a3', [{ type: 'text', text: 'Second.' }])]
      .flatMap((frame) => projector.project(frame));
    expect(events.map(({ event }) => event.type === 'timeline' ? event.item : null)).toEqual([
      { type: 'reasoning', text: 'Considering.' },
      expect.objectContaining({ type: 'assistant_message', text: 'First.' }),
      expect.objectContaining({ type: 'assistant_message', text: 'Second.' }),
    ]);
  });

  it('projects tools and error results with the original tool identity and bounded content', () => {
    const projector = new ClaudeEventProjector('session');
    projector.project(assistant('a', [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'false' } }]));
    const events = projector.project({ ...envelope, type: 'user', uuid: 'result', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool', is_error: true, content: 'command failed' },
    ] } });
    expect(events[0]?.event).toMatchObject({ type: 'timeline', item: {
      type: 'tool_call', callId: 'tool', name: 'Bash', status: 'failed', error: 'command failed',
      detail: { type: 'shell', command: 'false' }, result: { content: [{ type: 'text', text: 'command failed' }] },
    } });
  });

  it('does not render subagent messages as root assistant responses', () => {
    const projector = new ClaudeEventProjector('session');
    expect(projector.project({ ...assistant('child', [{ type: 'text', text: 'child private output' }]), parent_tool_use_id: 'parent-tool' })).toEqual([]);
    expect(projector.project({ ...assistant('other', [{ type: 'text', text: 'other session' }]), session_id: 'other' })).toEqual([]);
  });

  it('replays history with stable source identities and no live turn events', () => {
    const frame = assistant('history', [{ type: 'text', text: 'Saved answer' }]);
    const first = new ClaudeEventProjector('session', 'history').project(frame);
    const second = new ClaudeEventProjector('session', 'history').project(frame);
    expect(first.map(({ sourceKey, delivery, event }) => ({ sourceKey, delivery, event })))
      .toEqual(second.map(({ sourceKey, delivery, event }) => ({ sourceKey, delivery, event })));
    expect(first[0]).toMatchObject({ delivery: 'history', event: { type: 'timeline', item: { text: 'Saved answer' } } });
  });
});

it('keeps native structured tool output bounded, correlated, and deduplicated alongside readable text', () => {
  const projector = new ClaudeEventProjector('session');
  projector.project(assistant('structured-tool', [{ type: 'tool_use', id: 'structured', name: 'Bash', input: { command: 'printf hello' } }]));
  const frame = { ...envelope, type: 'user', uuid: 'structured-result', tool_use_result: { stdout: 'hello', exitCode: 0, nativeFlag: true },
    message: { content: [{ type: 'tool_result', tool_use_id: 'structured', content: 'hello' }] } };
  expect(projector.project(frame)[0]?.event).toMatchObject({ type: 'timeline', item: { callId: 'structured', result: { content: [
    { type: 'text', text: 'hello' }, { type: 'json', value: { stdout: 'hello', exitCode: 0, nativeFlag: true } },
  ] } } });
  expect(projector.project(frame)).toEqual([]);
  const large = projector.project({ ...frame, uuid: 'large-result', tool_use_result: { data: 'x'.repeat(70000) } })[0]?.event;
  expect(large).toMatchObject({ type: 'timeline', item: { result: { truncated: true } } });
  if (large?.type !== 'timeline' || large.item.type !== 'tool_call') throw new Error('Missing tool result');
  expect(large.item.result!.content.reduce((sum, content) => sum + (content.type === 'text' ? content.text.length : JSON.stringify(content.value).length), 0)).toBeLessThanOrEqual(65536);
});

it('does not assign an uncorrelated structured payload to multiple tool results', () => {
  const events = new ClaudeEventProjector('session').project({ ...envelope, type: 'user', uuid: 'ambiguous', tool_use_result: { oneToolOnly: true },
    message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'first' }, { type: 'tool_result', tool_use_id: 'two', content: 'second' }] } });
  expect(events.map(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call' ? event.item.result?.content : [])).toEqual([
    [{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }],
  ]);
});

it.each(['live', 'history'] as const)('renders confirmed native file changes in %s without inventing failed diffs', delivery => {
 const projector = new ClaudeEventProjector('session', delivery);
 projector.project(assistant('edit-start', [{type:'tool_use', id:'edit', name:'Edit', input:{file_path:'/work/a.txt',old_string:'before',new_string:'after'}}]));
 const result = {filePath:'/work/a.txt', structuredPatch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-before','+after']}]};
 const value = {...envelope,type:'user',uuid:'edit-result',tool_use_result:result,message:{content:[{type:'tool_result',tool_use_id:'edit',content:'Updated file.'}]}};
 const events = projector.project(value);
 expect(events).toContainEqual(expect.objectContaining({delivery,event:expect.objectContaining({item:expect.objectContaining({type:'tool_call',callId:'edit',status:'completed',result:expect.objectContaining({content:expect.arrayContaining([{type:'json',value:{format:'file_changes',version:1,files:[{path:'/work/a.txt',kind:'modified',diff:'--- a/work/a.txt\n+++ b/work/a.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n'}]}}])})})})}));
 expect(projector.project(value)).toEqual([]);
 const failed = projector.project({...value,uuid:'failed',message:{content:[{type:'tool_result',tool_use_id:'edit',is_error:true,content:'Permission denied'}]}});
 expect(JSON.stringify(failed)).not.toContain('file_changes');
});

it('ignores text and thinking deltas delivered after the completed native block', () => {
 const p=new ClaudeEventProjector('session');
 p.project(stream({type:'message_start',message:{id:'msg'}}));
 p.project(stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}}));
 p.project(assistant('final',[{type:'text',text:'Complete'}]));
 expect(p.project(stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Complete'}}))).toEqual([]);
});

it('projects native compaction start and boundary completion without interpreting requesting as compacting', () => {
 const p=new ClaudeEventProjector('session');
 expect(p.project({...envelope,type:'system',uuid:'start',subtype:'status',status:'compacting'})).toContainEqual(expect.objectContaining({event:expect.objectContaining({item:{type:'compaction',status:'loading'}})}));
 expect(p.project({...envelope,type:'system',uuid:'requesting',subtype:'status',status:'requesting'})).toEqual([]);
 expect(p.project({...envelope,type:'system',uuid:'complete',subtype:'compact_boundary',compact_metadata:{trigger:'auto',pre_tokens:100}})).toContainEqual(expect.objectContaining({event:expect.objectContaining({item:{type:'compaction',status:'completed',trigger:'auto',preTokens:100}})}));
});
