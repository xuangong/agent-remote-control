import {execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {expect,it} from 'vitest';

it('opens a Claude session with its saved profile and executable, without Relay credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'arc-claude-command-'));
 try {
  const bin=join(root,'native claude.mjs');
  await writeFile(bin,"console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.CLAUDE_CONFIG_DIR,key:process.env.AGENT_HOST_REMOTE_KEY,secret:process.env.RELAY_SECRET})); process.exit(Number(process.env.TEST_NATIVE_EXIT??0));");
  await writeFile(join(root,'connection.json'),JSON.stringify({serverUrl:'https://relay.invalid',remoteKey:'private',environment:{AGENT_HOST_CLAUDE:bin,AGENT_HOST_CLAUDE_HOME:join(root,'profile')}}));
  const cli=(args:string[],extra:NodeJS.ProcessEnv={})=>promisify(execFile)(process.execPath,[resolve('dist/cli.js'),...args],{timeout:5000,env:{PATH:process.env.PATH,HOME:process.env.HOME,AGENT_HOST_STATE_DIR:root,RELAY_SECRET:'secret',...extra}});
  const run=(args:string[],extra:NodeJS.ProcessEnv={})=>cli(['claude',...args],extra);
  const id='11111111-1111-4111-8111-111111111111';
  expect(JSON.parse((await cli(['session','attach',`local/claude/${id}`])).stdout)).toEqual({args:['--resume',id],home:join(root,'profile')});
  expect(JSON.parse((await run(['--continue'])).stdout).args).toEqual(['--continue']);
  expect(JSON.parse((await run(['--help'])).stdout).args).toEqual(['--help']);
  await expect(cli(['session','attach',`local/claude/${id}`],{TEST_NATIVE_EXIT:'23'})).rejects.toMatchObject({code:23,stderr:expect.stringContaining('"outcome":"unexpected"')});
  await expect(run(['--take-over'])).rejects.toMatchObject({stderr:expect.stringContaining('explicit session ID')});
  await expect(run(['resume',id])).rejects.toMatchObject({stderr:expect.stringContaining('session attach')});
 }finally{await rm(root,{recursive:true,force:true});}
},15000);
