import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {ClaudeAgentProvider} from '../dist/provider.js';
import {nativeFixture,nativeReply} from './test-utils/native-fixture.js';

it('projects real Write/Edit output as diffs and restores the transcript through a cold native-ID resume', async () => {
 let calls=0;
 const f=await nativeFixture((_body,res)=>nativeReply(res,++calls===1
  ? [{type:'tool_use',id:'write',name:'Write',input:{file_path:join(f.cwd,'result.txt'),content:'before\n'}}]
  : calls===2 ? [{type:'tool_use',id:'edit',name:'Edit',input:{file_path:join(f.cwd,'result.txt'),old_string:'before',new_string:'after'}}]
  : [{type:'text',text:'NATIVE_DIFF_DONE'}]));
 const provider=new ClaudeAgentProvider(f.options);let resumed:Awaited<ReturnType<typeof provider.resumeSession>>|undefined;
 const session=await provider.createSession({sessionId:'ignored',cwd:f.cwd,model:'claude-sonnet-4-5-20250929'});
 const events:any[]=[];
 const pump=(async()=>{for await(const item of session.observe()) if(item.type==='observation') {
  events.push(item.event);
  if(item.event.type==='interaction_requested' && item.event.request.kind==='tool_approval') await session.respondToInteraction(item.event.request.requestId,{kind:'tool_approval',decision:'allow',scope:'once'});
 }})();
 try {
  await session.sendMessage('Write and edit the fixture file.');
  await expect.poll(()=>events.some(event=>event.type==='turn_completed'),{timeout:15000}).toBe(true);
  expect(await readFile(join(f.cwd,'result.txt'),'utf8')).toBe('after\n');
  const changes=events.flatMap(event=>event.type==='timeline'&&event.item.type==='tool_call' ? event.item.result?.content.filter((part:any)=>part.type==='json'&&part.value.format==='file_changes').flatMap((part:any)=>part.value.files)??[]:[]);
  expect(changes).toContainEqual(expect.objectContaining({kind:'added',diff:expect.stringContaining('+before')}));
  expect(changes).toContainEqual(expect.objectContaining({kind:'modified',diff:expect.stringContaining('+after')}));
  const handle=(await session.runtimeInfo()).persistence!;
  await provider.releaseSession(handle.sessionId);await pump;
  const cold=new ClaudeAgentProvider(f.options);
  expect(await cold.sessionWorkspace(handle.sessionId)).toBe(f.cwd);
  resumed=await cold.resumeSession({...handle,opaque:'{}'});
  const history:any[]=[];
  for await(const item of resumed.observe()){if(item.type==='history_boundary')break;history.push(item);}
  // The public catalog omits native structured tool output; do not reconstruct diffs from intent.
  expect(JSON.stringify(history)).not.toContain('file_changes');
  expect(JSON.stringify(history)).toContain('NATIVE_DIFF_DONE');
  expect((await resumed.runtimeInfo()).cwd).toBe(f.cwd);
 } finally {await resumed?.dispose();await provider.dispose();await pump;await f.close();}
},45000);

it('applies a native suggested session grant so the repeated command does not prompt again',async()=>{
 let calls=0;const f=await nativeFixture((_body,res)=>nativeReply(res,++calls<=2
  ? [{type:'tool_use',id:'shell-'+calls,name:'Bash',input:{command:'node -e "console.log(123)"'}}]
  : [{type:'text',text:'GRANT_DONE'}]));
 const provider=new ClaudeAgentProvider(f.options);const session=await provider.createSession({sessionId:'ignored',cwd:f.cwd});
 const events:any[]=[];const grants:any[]=[];
 const pump=(async()=>{for await(const item of session.observe())if(item.type==='observation'){
  events.push(item.event);
  if(item.event.type==='interaction_requested'&&item.event.request.kind==='tool_approval'){
   grants.push(item.event.request);
   await session.respondToInteraction(item.event.request.requestId,{kind:'tool_approval',decision:'allow',scope:item.event.request.allowScopes.includes('session')?'session':'once'});
  }
 }})();
 try{
  await session.sendMessage('Run the fixture command twice.');
  await expect.poll(()=>events.some(event=>event.type==='turn_completed'),{timeout:15000}).toBe(true);
  expect(grants).toHaveLength(1);expect(grants[0]).toMatchObject({allowScopes:['once','session']});
  expect(JSON.stringify(events)).toContain('123');
 }finally{await provider.dispose();await pump;await f.close();}
},30000);
