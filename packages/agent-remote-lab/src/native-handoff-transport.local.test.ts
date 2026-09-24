// @vitest-environment node
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import WebSocket from 'ws';
import {expect,it,vi} from 'vitest';
import {AgentReplica,HttpWebSocketTransport,RemoteSessionClient,type WebSocketLike} from '@orchardworks/agent-remote-web';
import {createAgentRemoteHttpServer} from '@orchardworks/agent-remote-relay';
import {createAgentHostRuntime} from '../../agent-host/src/host.js';
import {createCopilotSessionDirectory} from '../../agent-host/src/copilot-directory.js';
import {fixture,reply} from '../../agent-provider-copilot/tests/native-fixture.js';

it('broadcasts native handoff over real browser sockets and reconnects both views to the resumed session',async()=>{
  const f=await fixture((body,res,index)=>{if(index>2)reply(res,body,'WEB_RESUMED');});
  const directory=createCopilotSessionDirectory(f.provider,[],{root:join(f.home,'profile','.arc-session-owners')});
  const runtime=createAgentHostRuntime({registrations:[{adapter:f.provider,directory}]});
  const http=createAgentRemoteHttpServer(runtime.relay,{websocketAuthorizer:{authenticate:()=>({subject:'fixture'}),authorize:()=>true}});
  const clients:RemoteSessionClient[]=[];
  let child:ReturnType<typeof spawn>|undefined;
  try {
    const nativeId=await directory.create({cwd:f.cwd,model:'native-fixture'});
    const attach=(takeOver?:string)=>runtime.control({method:'POST',path:'/remote/attach',sessionId:'agent',body:JSON.stringify({providerId:'copilot',nativeSessionId:nativeId,takeOver})});
    expect((await attach()).status).toBe(200);
    const {url}=await http.listen();
    async function page(){
      const transport=new HttpWebSocketTransport(url,{sessionChannels:false,webSocketFactory:url=>new WebSocket(url) as unknown as WebSocketLike});
      const replica=new AgentReplica();const client=new RemoteSessionClient('agent',transport,replica,{requireSessionControl:true,clientKind:'web',reconnectInitialDelayMs:10});
      let status='';client.subscribeStatus(value=>status=value);clients.push(client);client.start();
      await vi.waitFor(()=>expect(status).toBe('ready'),{timeout:5000});return{replica,client,get status(){return status;}};
    }
    const a=await page(),b=await page();
    await a.client.sendMessage('WEB_RUNNING');await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    const state=join(f.home,'controller');await mkdir(state);
    await writeFile(join(state,'connection.json'),JSON.stringify({serverUrl:'https://relay.invalid',remoteKey:'fixture',environment:{AGENT_HOST_COPILOT_HOME:join(f.home,'profile')}}));
    child=spawn(process.execPath,[resolve('../agent-host/dist/cli.js'),'copilot','resume',nativeId,'--take-over','--no-auto-update','--no-auto-login','--disable-builtin-mcps','--allow-all-tools','-p','CLI_RUNNING'],{
      cwd:f.cwd,env:{...process.env,AGENT_HOST_STATE_DIR:state,AGENT_HOST_COPILOT:undefined,AGENT_HOST_COPILOT_HOME:undefined,GITHUB_TOKEN:undefined,GH_TOKEN:undefined,COPILOT_GITHUB_TOKEN:undefined,COPILOT_PROVIDER_BASE_URL:f.baseUrl,COPILOT_MODEL:'native-fixture'},stdio:['ignore','pipe','pipe'],
    });
    let stderr='';child.stderr!.on('data',chunk=>stderr+=chunk);child.stdout!.resume();
    const exited=new Promise<number|null>(resolve=>child!.once('exit',resolve));
    await vi.waitFor(()=>expect(f.requests,stderr).toHaveLength(2),{timeout:10000});
    for(const view of [a,b])await vi.waitFor(()=>expect(view.replica.getState().sessionControl).toMatchObject({access:'read_only',nativeOwner:{kind:'native_cli'}}));
    await expect(a.client.sendMessage('STALE_WEB')).rejects.toMatchObject({code:'session_read_only'});
    const automatic=await attach();expect(automatic.status).toBe(409);expect(JSON.parse(automatic.body).code).toBe('native_session_owned');
    const result=await attach(a.replica.getState().sessionControl!.nativeOwner!.generation);
    expect(result.status,result.body).toBe(200);expect(JSON.parse(result.body)).toMatchObject({agentId:'agent',nativeSessionId:nativeId});
    expect(await exited).toBe(0);
    for(const view of [a,b])await vi.waitFor(()=>{expect(view.status).toBe('ready');expect(view.replica.getState().sessionControl?.nativeOwner).toBeUndefined();},{timeout:5000});
    await a.client.takeControl();
    await a.client.sendMessage('WEB_AFTER_HANDOFF');
    for(const view of [a,b])await vi.waitFor(()=>expect(JSON.stringify(view.replica.getState().timeline)).toContain('WEB_RESUMED'),{timeout:5000});
    expect(f.requests).toHaveLength(3);
    expect(a.replica.getState().diagnostics.some(d=>d.message.includes('ended unexpectedly'))).toBe(false);
  }finally {clients.forEach(client=>client.stop());if(child?.exitCode===null)child.kill('SIGTERM');await http.close();await runtime.close();await f.close();}
},40000);
