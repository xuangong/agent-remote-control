import {expect,test} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {createGatewayRelay} from '../src/server/gateway-relay.js';
import {createGatewayStaticPages} from '../src/server/gateway-static.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createAgentHost} from '../../agent-host/src/host.js';
import {createCopilotSessionDirectory} from '../../agent-host/src/copilot-directory.js';
import {fixture,reply} from '../../agent-provider-copilot/tests/native-fixture.js';

for (const cold of [false, true]) test(`takes a running native CLI session back through the ${cold ? 'cold' : 'open'} product Chatbox`,async({page,browser},info)=>{
  test.setTimeout(45000);
  const secret='handoff-test-only-secret-01234567890123456789';
  const issuer='https://gateway.example';
  const gateway=createGatewayRelay({origin:'http://127.0.0.1:0',issuer,secret,servePage:await createGatewayStaticPages(resolve('dist'))});
  const {url:relay}=await gateway.listen(0);
  const request=page.context().request;
  const pending=await request.get(`${relay}/auth/login`,{maxRedirects:0});
  const nonce=new URL(pending.headers().location!).searchParams.get('challenge');
  const iat=Math.floor(Date.now()/1000);
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'arc-relay+jwt'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:issuer,aud:relay,sub:'handoff-test',nonce,iat,exp:iat+900,jti:crypto.randomUUID()})).toString('base64url');
  const grant=`${header}.${payload}`;
  const login=await request.post(`${relay}/auth/session`,{headers:{origin:relay},data:{ticket:`${grant}.${createHmac('sha256',secret).update(grant).digest('base64url')}`}});
  expect(login.status()).toBe(200);
  const {basePath}=await login.json();
  const invitation=await(await request.post(`${relay}${basePath}v1/remote/pairings`,{headers:{origin:relay},data:{}})).json();
  const f=await fixture((body,res,index)=>{if(index>2)reply(res,body,'CONTINUED_IN_PRODUCT');});
  const directory=createCopilotSessionDirectory(f.provider,[],{root:join(f.home,'profile','.arc-session-owners')});
  const nativeId=await directory.create({cwd:f.cwd,model:'native-fixture'});
  const host=createAgentHost({registrations:[{adapter:f.provider,directory}],installationId:`handoff-${info.project.name}`,name:'Copilot handoff fixture',uplink:{url:relay.replace('http:','ws:')+'/ws/remote-host',remoteKey:invitation.key}});
  let cli:ReturnType<typeof spawn>|undefined;
  let newcomer:Awaited<ReturnType<typeof browser.newContext>>|undefined;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const frames: string[]=[];page.on('websocket',socket=>{socket.on('framereceived',frame=>frames.push(String(frame.payload)));socket.on('socketerror',error=>frames.push(String(error)));});
  try {
    const {hostId}=await host.ready;
    await page.goto(`${relay}/?host=${hostId}&provider=copilot&session=${nativeId}`);
    const input=page.getByRole('textbox',{name:'Message',exact:true});
    await expect(input).toBeEditable().catch(error=>{throw new Error(String(error)+'\n'+frames.slice(-8).join('\n'));});await input.fill('WEB_RUNNING');await input.press('Enter');
    await expect.poll(()=>f.requests.length).toBe(1);
    await input.fill('Keep this draft');
    const state=join(f.home,'controller');await mkdir(state);
    await writeFile(join(state,'connection.json'),JSON.stringify({serverUrl:'https://relay.invalid',remoteKey:'fixture',environment:{AGENT_HOST_COPILOT_HOME:join(f.home,'profile')}}));
    cli=spawn(process.execPath,[resolve('../agent-host/dist/cli.js'),'copilot','resume',nativeId,'--take-over','--no-auto-update','--no-auto-login','--disable-builtin-mcps','--allow-all-tools','-p','CLI_RUNNING'],{
      cwd:f.cwd,env:{...process.env,AGENT_HOST_STATE_DIR:state,AGENT_HOST_COPILOT:undefined,AGENT_HOST_COPILOT_HOME:undefined,GITHUB_TOKEN:undefined,GH_TOKEN:undefined,COPILOT_GITHUB_TOKEN:undefined,COPILOT_PROVIDER_BASE_URL:f.baseUrl,COPILOT_MODEL:'native-fixture'},stdio:['ignore','pipe','pipe'],
    });
    let stderr='';cli.stderr!.on('data',chunk=>stderr+=chunk);cli.stdout!.resume();
    const exited=new Promise<number|null>(resolve=>cli!.once('exit',resolve));
    await expect.poll(()=>f.requests.length,{message:stderr}).toBe(2);
    const composer=page.getByRole('region',{name:'Live provider controls'});
    await expect(input).not.toBeEditable();await expect(input).toHaveValue('Keep this draft');
    await expect(composer).toContainText('Native CLI');
    let controllingPage=page;
    if (cold) {
      newcomer=await browser.newContext({viewport:{width:402,height:874}});
      await newcomer.addCookies(await page.context().cookies());
      controllingPage=await newcomer.newPage();
      controllingPage.on('pageerror',error=>errors.push(error.message));
      await controllingPage.goto(page.url());
    }
    const controllingComposer=controllingPage.getByRole('region',{name:'Live provider controls'});
    const controllingInput=controllingPage.getByRole('textbox',{name:'Message',exact:true});
    if (cold) await expect(controllingComposer.locator('[data-testid="prompt-input"]')).toBeHidden();
    else await expect(controllingInput).not.toBeEditable();
    const takeoverButton=controllingComposer.getByRole('button',{name:'Interrupt and take control',exact:true});
    const owner=controllingComposer.locator('.lab-session-control-owner');
    const ownerBox=await owner.boundingBox(); const buttonBox=await takeoverButton.boundingBox();
    expect(ownerBox!.x+ownerBox!.width).toBeLessThanOrEqual(buttonBox!.x);
    expect((await controllingComposer.boundingBox())!.height).toBeLessThan(cold ? 110 : 190);
    await controllingPage.screenshot({path:info.outputPath('native-takeover.png'),fullPage:true});
    await controllingComposer.getByRole('button',{name:'Interrupt and take control',exact:true}).click();
    await expect.poll(()=>cli!.exitCode,{timeout:12000}).toBe(0);
    expect(await exited).toBe(0);
    await expect(controllingInput).toBeEditable();await expect(input).toHaveValue('Keep this draft');
    if (cold) await expect(input).not.toBeEditable();
    await expect(controllingComposer.locator('.lab-session-control')).toHaveCount(0);
    await controllingInput.fill('WEB_CONTINUES');await controllingInput.press('Enter');
    await expect(page.getByText('CONTINUED_IN_PRODUCT',{exact:true})).toBeVisible();
    expect(new URL(page.url()).searchParams.get('session')).toBe(nativeId);
    expect(f.requests).toHaveLength(3);expect(errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('resumed-native-session.png'),fullPage:true});
  }finally{if(cli?.exitCode===null)cli.kill('SIGTERM');await newcomer?.close().catch(()=>undefined);await host.close();await f.close();await gateway.close();}
});
