import {join} from 'node:path';
import {expect,test,type WebSocketRoute} from '@playwright/test';
import {ClaudeAgentProvider} from '../../agent-provider-claude/dist/provider.js';
import {nativeFixture,nativeReply} from '../../agent-provider-claude/src/test-utils/native-fixture.js';
import {createDebuggerServer} from '../dist/server.js';

test('Claude live view preserves pending approval on reconnect and renders the actual file diff once',async({page,context},info)=>{
 test.setTimeout(60000);await page.setViewportSize({width:390,height:844});
 let calls=0;const f=await nativeFixture((_body,res)=>nativeReply(res,++calls===1
  ? [{type:'tool_use',id:'browser-write',name:'Write',input:{file_path:join(f.cwd,'result.md'),content:'# Claude native diff\n'}}]
  : [{type:'text',text:'CLAUDE_BROWSER_COMPLETE'}]));
 const provider=new ClaudeAgentProvider(f.options);
 const server=await createDebuggerServer({adapter:provider,config:{cwd:f.cwd,model:'claude-sonnet-4-5-20250929'}});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  const sockets:WebSocketRoute[]=[];
  await page.routeWebSocket('**',socket=>{socket.connectToServer();sockets.push(socket);});
  await page.goto(server.url);
  const input=page.getByRole('textbox',{name:'Message',exact:true});await expect(input).toBeEditable();
  await input.fill('Create result.md.');await page.getByRole('button',{name:'Send message',exact:true}).click();
  const pending=page.getByRole('complementary',{name:'Pending interactions'});
  await expect(pending.getByRole('button',{name:'Allow once',exact:true})).toBeEnabled({timeout:15000});
  await context.setOffline(true);for(const socket of sockets)socket.close({code:1001,reason:'Test reconnect'});
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));
  await expect(pending).toContainText('Waiting for connection to respond.');
  await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(pending.getByRole('button',{name:'Allow once',exact:true})).toBeEnabled({timeout:15000});
  await pending.getByRole('button',{name:'Allow once',exact:true}).click();
  await expect(page.getByText('CLAUDE_BROWSER_COMPLETE',{exact:true})).toBeVisible({timeout:15000});
  const tool=page.locator('.agent-tool').filter({hasText:'Write'});await expect(tool).toHaveCount(1);
  const toggle=tool.locator('.agent-tool-toggle');if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  await expect(tool.getByRole('region',{name:/^Diff for /})).toContainText('+# Claude native diff');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('claude-mobile-diff.png'),fullPage:true});
  await page.reload();await expect(page.getByText('CLAUDE_BROWSER_COMPLETE',{exact:true})).toBeVisible();
  await expect(tool).toHaveCount(1);
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  await expect(tool.getByRole('region',{name:/^Diff for /})).toContainText('+# Claude native diff');
  expect(calls).toBe(2);expect(errors).toEqual([]);
 }finally{await context.setOffline(false);await server.close();await provider.dispose();await f.close();}
});
