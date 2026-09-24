import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {fixture,observe,reply,waitFor} from '../../agent-provider-copilot/tests/native-fixture.js';
import {createCopilotSessionDirectory} from './copilot-directory.js';
import {inspectNativeOwner} from './native-session-owner.js';

it('interrupts a real SDK turn for CLI resume, then interrupts that CLI turn to resume the same native session',async()=>{
  let sdkStarted=false,cliStarted=false;
  const f=await fixture((body,res,index)=>{if(index===1)sdkStarted=true;else if(index===2)cliStarted=true;else reply(res,body,'RESUMED_AFTER_HANDOFF');});
  const root=join(f.home,'profile','.arc-session-owners');
  const directory=createCopilotSessionDirectory(f.provider,[],{root});
  let child:ReturnType<typeof spawn>|undefined;
  try {
    const id=await directory.create({cwd:f.cwd,model:'native-fixture'});
    const session=await directory.open(id);observe(session);
    await session.sendMessage('SDK_PENDING');await waitFor(()=>sdkStarted);
    const state=join(f.home,'controller');await mkdir(state);
    await writeFile(join(state,'connection.json'),JSON.stringify({serverUrl:'https://relay.invalid',remoteKey:'fixture',environment:{AGENT_HOST_COPILOT_HOME:join(f.home,'profile')}}));
    child=spawn(process.execPath,[resolve('dist/cli.js'),'copilot','resume',id,'--take-over','--no-auto-update','--no-auto-login','--disable-builtin-mcps','--allow-all-tools','-p','CLI_PENDING'],{
      cwd:f.cwd,env:{...process.env,AGENT_HOST_STATE_DIR:state,AGENT_HOST_COPILOT:undefined,AGENT_HOST_COPILOT_HOME:undefined,
        GITHUB_TOKEN:undefined,GH_TOKEN:undefined,COPILOT_GITHUB_TOKEN:undefined,COPILOT_PROVIDER_BASE_URL:f.baseUrl,COPILOT_MODEL:'native-fixture'},stdio:['ignore','pipe','pipe'],
    });
    let stderr='';child.stderr!.on('data',chunk=>stderr+=chunk);child.stdout!.resume();
    const exit=new Promise<number|null>(resolve=>child!.once('exit',resolve));
    await waitFor(()=>cliStarted).catch(error=>{throw new Error(String(error)+'\n'+stderr);});
    await expect(session.sendMessage('STALE_WEB')).rejects.toThrow(/control/);
    const owner=await inspectNativeOwner({root,providerId:'copilot',sessionId:id});expect(owner?.kind).toBe('native_cli');
    const resumed=await directory.open(id,{takeOver:owner!.generation});
    expect(await exit).toBe(0);
    const restored=observe(resumed);await waitFor(()=>restored.items.some(item=>item.type==='history_boundary'));
    expect((await resumed.runtimeInfo()).sessionId).toBe(id);
    await resumed.sendMessage('SDK_RESUMED');
    await waitFor(()=>restored.timeline().some(row=>row.item.type==='assistant_message'&&row.item.text==='RESUMED_AFTER_HANDOFF'));
    expect(stderr).toContain('"outcome":"requested"');expect(stderr).not.toContain('"outcome":"unexpected"');
    expect(f.errors).toEqual([]);
  }finally {if(child?.exitCode===null)child.kill('SIGTERM');await directory.close();await f.close();}
},40000);

it.skipIf(process.platform==='win32')('automatically stops the interactive terminal for immediate web takeover',async()=>{
  const f=await fixture((body,res,index)=>{if(index!==2)reply(res,body,'WEB_CONTINUES');});
  const root=join(f.home,'profile','.arc-session-owners');const directory=createCopilotSessionDirectory(f.provider,[],{root});
  let terminal:ReturnType<typeof spawn>|undefined;
  try {
    const id=await directory.create({cwd:f.cwd,model:'native-fixture'});
    const initial=await directory.open(id);const seen=observe(initial);await initial.sendMessage('INITIAL_HISTORY');
    await waitFor(()=>seen.events().some(event=>event.type==='turn_completed'));
    const state=join(f.home,'controller');await mkdir(state);
    await writeFile(join(state,'connection.json'),JSON.stringify({serverUrl:'https://relay.invalid',remoteKey:'fixture',environment:{AGENT_HOST_COPILOT_HOME:join(f.home,'profile')}}));
    terminal=spawn('python3',[resolve('tests/copilot-pty.py'),process.execPath,resolve('dist/cli.js'),'copilot','resume',id,'--take-over','--no-auto-update','--no-auto-login','--disable-builtin-mcps','--allow-all-tools'],{
      cwd:f.cwd,env:{...process.env,TERM:'xterm-256color',AGENT_HOST_STATE_DIR:state,AGENT_HOST_COPILOT:undefined,AGENT_HOST_COPILOT_HOME:undefined,GITHUB_TOKEN:undefined,GH_TOKEN:undefined,COPILOT_GITHUB_TOKEN:undefined,COPILOT_PROVIDER_BASE_URL:f.baseUrl,COPILOT_MODEL:'native-fixture'},stdio:['pipe','pipe','pipe'],
    });
    let text='',buffer='',exit:unknown;
    terminal.stdout!.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);text+=row.output??'';if('exit' in row)exit=row.exit;}});
    terminal.stderr!.on('data',chunk=>text+=chunk);
    await waitFor(()=>text.includes('commands')).catch(error=>{throw new Error(String(error)+'\n'+text.slice(-3000));});
    await new Promise(resolve=>setTimeout(resolve,300));
    terminal.stdin!.write(JSON.stringify({write:'INTERACTIVE_PENDING\r'})+'\n');
    await waitFor(()=>f.requests.length===2);
    const owner=await inspectNativeOwner({root,providerId:'copilot',sessionId:id});expect(owner?.kind).toBe('native_cli');
    const resumed=await directory.open(id,{takeOver:owner!.generation});
    await waitFor(()=>exit===0).catch(error=>{throw new Error(String(error)+'\n'+text.slice(-3000));});
    const observed=observe(resumed);await resumed.sendMessage('WEB_CONTINUES');
    await waitFor(()=>observed.timeline().some(row=>row.item.type==='assistant_message'&&row.item.text==='WEB_CONTINUES'));
    expect(text).toContain('Native session stopped for the requested handoff');
  }finally{terminal?.stdin?.end();await directory.close();await f.close();}
},40000);
