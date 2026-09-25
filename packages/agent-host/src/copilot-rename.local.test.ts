import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {expect, it} from 'vitest';
import {CopilotAgentProvider} from '../../agent-provider-copilot/src/provider.js';
import {fixture, observe, reply, waitFor} from '../../agent-provider-copilot/tests/native-fixture.js';
import {createCopilotSessionDirectory} from './copilot-directory.js';
import {createHostExecutionPolicy, protectHostDirectory} from './execution-policy.js';
import {createAgentHostRuntime} from './host.js';

it('refuses a foreign native writer, then renames a saved Copilot favorite and reconciles retries without restoring old names', async () => {
  const f=await fixture((body,res)=>reply(res,body,'SAVED_SESSION'));
  const provider=new CopilotAgentProvider({useLoggedInUser:false,requestTimeoutMs:5000,
    env:{COPILOT_HOME:join(f.home,'profile'),GITHUB_TOKEN:undefined,GH_TOKEN:undefined,COPILOT_GITHUB_TOKEN:undefined},
    nativeSessionConfig:{provider:{type:'openai',baseUrl:f.baseUrl,wireApi:'completions'}}});
  const directory=protectHostDirectory(createCopilotSessionDirectory(provider,[],{root:join(f.home,'owners')}),
    (await createHostExecutionPolicy({AGENT_HOST_WORKSPACE:f.cwd}))!);
  const host=createAgentHostRuntime({registrations:[{adapter:provider,directory}]});
  try {
    const initial=await f.provider.createSession({sessionId:'initial',cwd:f.cwd,model:'native-fixture'});
    const seen=observe(initial);await initial.sendMessage('Create a saved session.');
    await waitFor(()=>seen.events().some(event=>event.type==='turn_completed'));
    const id=(await initial.runtimeInfo()).sessionId!;
    await expect(directory.validateSessionRename!(id, '"invalid"')).rejects.toThrow(/double quotes/);
    await expect(directory.validateSessionRename!(id, 'Renamed')).rejects.toThrow(/unmanaged native client/);
    expect((await initial.runtimeInfo()).status).toBe('idle');
    await f.provider.dispose();await seen.done;
    const request={method:'POST' as const,path:'/remote/session/rename',body:JSON.stringify({providerId:'copilot',nativeSessionId:id,title:'Favorite title',operationId:randomUUID()})};
    const first=await host.control(request);
    expect(first.status).toBe(200);expect(JSON.parse(first.body)).toEqual({title:'Favorite title'});
    expect(await directory.sessionTitle!(id)).toBe('Favorite title');
    await provider.renameSession(id,'A newer native name');
    const retried=await host.control(request);
    expect(retried.status).toBe(200);expect(JSON.parse(retried.body)).toEqual({title:'A newer native name'});
    expect(await provider.readSessionTitle(id)).toBe('A newer native name');
    expect(f.requests).toHaveLength(1);expect(f.errors).toEqual([]);
  } finally {await host.close();await f.close();}
}, 30000);
