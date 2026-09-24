import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {ClaudeAgentProvider} from '@orchardworks/agent-provider-claude';
import {nativeFixture,nativeReply} from '../../agent-provider-claude/src/test-utils/native-fixture.js';
import {createClaudeSessionDirectory} from './claude-directory.js';
import {inspectNativeOwner} from './native-session-owner.js';

it('transfers a running Claude Query to native CLI and back, preserving the native ID and rejecting stale writes',async()=>{
 let calls=0;const f=await nativeFixture((_body,res)=>{calls++;if(calls!==2&&calls!==3)nativeReply(res,[{type:'text',text:'CLAUDE_HANDOFF_OK'}]);});
 const provider=new ClaudeAgentProvider(f.options);const root=join(f.home,'.arc-session-owners');
 const directory=createClaudeSessionDirectory(provider,[],{root});let cli:ReturnType<typeof spawn>|undefined;
 const pumps:Promise<void>[]=[];const watch=(session:any)=>{const events:any[]=[];pumps.push((async()=>{for await(const item of session.observe())if(item.type==='observation')events.push(item.event);})());return events;};
 try {
  const id=await directory.create({cwd:f.cwd,model:'claude-sonnet-4-5-20250929'});
  const session=await directory.open(id);const events=watch(session);
  await session.sendMessage('INITIAL_HISTORY');
  await expect.poll(()=>events.some(event=>event.type==='turn_completed'),{timeout:15000}).toBe(true);
  await session.sendMessage('SDK_PENDING');await expect.poll(()=>calls,{timeout:10000}).toBe(2);
  const state=join(f.home,'controller');await mkdir(state);
  await writeFile(join(state,'connection.json'),JSON.stringify({serverUrl:'https://relay.invalid',remoteKey:'fixture',environment:{AGENT_HOST_CLAUDE_HOME:f.home,AGENT_HOST_CLAUDE:f.options.executable}}));
  cli=spawn(process.execPath,[resolve('dist/cli.js'),'claude','resume',id,'--take-over','--model','claude-sonnet-4-5-20250929','--print','CLI_PENDING'],{cwd:f.cwd,
   env:{...process.env,...f.options.env,AGENT_HOST_STATE_DIR:state,AGENT_HOST_CLAUDE:undefined,AGENT_HOST_CLAUDE_HOME:undefined},stdio:['ignore','pipe','pipe']});
  let stderr='';cli.stderr!.on('data',chunk=>stderr+=chunk);cli.stdout!.resume();
  const exited=new Promise<number|null>((resolve,reject)=>{cli!.once('exit',resolve);cli!.once('error',reject);});
  await expect.poll(()=>calls,{timeout:15000}).toBe(3).catch(error=>{throw new Error(String(error)+'\n'+stderr);});
  await expect(session.sendMessage('STALE')).rejects.toThrow(/control|ownership/i);
  const owner=await inspectNativeOwner({root,providerId:'claude',sessionId:id});expect(owner?.kind).toBe('native_cli');
  const resumed=await directory.open(id,{takeOver:owner!.generation});
  expect(await exited).toBe(0);
  expect((await resumed.runtimeInfo()).sessionId).toBe(id);
  const restored=watch(resumed);await resumed.sendMessage('RESUMED');
  await expect.poll(()=>restored.some(event=>event.type==='turn_completed'),{timeout:15000}).toBe(true);
  expect(JSON.stringify(restored)).toContain('INITIAL_HISTORY');
  expect(stderr).toContain('Native session stopped for the requested handoff.');
  expect(stderr).not.toContain('"outcome":"unexpected"');
 }finally{if(cli?.exitCode===null)cli.kill('SIGTERM');await directory.close();await Promise.all(pumps);await f.close();}
},60000);
