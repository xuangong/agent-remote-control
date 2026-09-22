import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../install.sh', import.meta.url));
const invitation = 'arc_' + 'a'.repeat(43);
const revision = 'b'.repeat(40);
const version = '1.2.3';
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arc-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'tools'), pkg = join(root, 'package');
  await mkdir(bin); await mkdir(join(pkg, 'dist'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@orchardworks/agent-remote-controller', version, type: 'module', scripts: { install: 'touch ' + join(root, 'lifecycle-ran') } }));
  await writeFile(join(pkg, 'build-info.json'), JSON.stringify({ version, revision: options.badIdentity ? 'c'.repeat(40) : revision, dirty: false }));
  await writeFile(join(pkg, 'dist/launcher.js'), `import fs from 'node:fs';
const args=process.argv.slice(2);const state=process.env.AGENT_HOST_STATE_DIR;
fs.appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'cli',args,state,key:!!process.env.AGENT_HOST_REMOTE_KEY,locale:process.env.LC_ALL,nofile:process.env.AGENT_HOST_CODEX_NOFILE})+'\\n');
if(args[0]==='--version')console.log('1.2.3');
if(args[0]==='start'||args[0]==='foreground'){fs.mkdirSync(state,{recursive:true});fs.writeFileSync(state+'/connection.json','saved');}
if(args[0]==='foreground')console.log('Agent Host uplink is registered.');
if(args[0]==='status')console.log('Agent Host daemon is running; uplink: registered; supervisor: fixture.');
`);
  const archive = join(root,'package.tgz');
  await exec('tar',['-czf',archive,'-C',root,'package'],{timeout:10000});
  const manifest = { version, revision, sha256: options.badChecksum ? '0'.repeat(64) : createHash('sha256').update(await readFile(archive)).digest('hex'),
    nodeMajor: options.nodeMajor ?? 22, asset: `orchardworks-agent-remote-controller-${version}.tgz`, platforms: options.platforms ?? ['darwin-arm64','darwin-x64','linux-arm64','linux-x64'] };
  await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
  await writeFile(join(bin,'curl'), `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'curl',args})+'\\n');
if(args.includes('%{url_effective}')){console.log('https://github.com/xuangong/agent-remote-control/releases/tag/controller-v1.2.3');process.exit(0);}
const dest=args[args.indexOf('-o')+1],url=args.find(a=>a.startsWith('https://'));
fs.copyFileSync(process.env.FIXTURE_ROOT+(url.endsWith('.json')?'/manifest.json':'/package.tgz'),dest);
`,{mode:0o755});
  await writeFile(join(bin,'uname'),`#!/bin/sh\ncase "$1" in -s) echo ${options.os ?? 'Linux'};; -m) echo ${options.arch ?? 'x86_64'};; esac\n`,{mode:0o755});
  await writeFile(join(bin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const keyFile=join(root,'key'); await writeFile(keyFile,invitation+'\n',{mode:0o600});
  const prefix=join(root,"install's files"), commands=join(root,'commands'), state=join(root,"state's files");
  const env={...process.env,PATH:bin+':'+process.env.PATH,HOME:root,AGENT_HOST_STATE_DIR:state,FIXTURE_ROOT:root,FIXTURE_EVENTS:join(root,'events'),npm_config_offline:'true'};
  delete env.AGENT_HOST_REMOTE_KEY; delete env.AGENT_HOST_SERVER;
  async function run(args=[]) {
    try {const result=await exec('/bin/sh',[script,'--prefix',prefix,'--bin-dir',commands,'--name','sunny-test-ab1234','--server','https://agents.xianliao.de5.net','--key-file',keyFile,...args],{env,timeout:20000,maxBuffer:1024*1024});return {code:0,output:result.stdout+result.stderr};}
    catch(e){return {code:e.code,output:(e.stdout??'')+(e.stderr??'')};}
  }
  async function events(){try{return (await readFile(join(root,'events'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
  return {root,env,prefix,commands,state,run,events};
}
for(const os of ['Darwin','Linux']) test(`fresh ${os} install validates the release and starts through the stable launcher`,{timeout:30000},async t=>{
  const f=await fixture(t,{os});const r=await f.run();assert.equal(r.code,0,r.output);
  const events=await f.events();const start=events.find(e=>e.kind==='cli'&&['start','foreground'].includes(e.args[0]));assert.ok(start);
  assert.equal(start.state,f.state);assert.equal(start.key,true);assert.equal(start.locale,'C');assert.equal(start.nofile,'8192');
  assert.ok(!r.output.includes(invitation));assert.ok(!JSON.stringify(events).includes(invitation));
  await assert.rejects(access(join(f.root,'lifecycle-ran')));assert.match(r.output,/Host sunny-test-ab1234 is ready|uplink is registered/);
});
for(const mode of ['badChecksum','badIdentity'])test(`rejects ${mode} before installing or starting`,{timeout:30000},async t=>{
  const f=await fixture(t,{[mode]:true});const r=await f.run();assert.notEqual(r.code,0);assert.ok(!(await f.events()).some(e=>e.kind==='cli'));await assert.rejects(access(f.commands));
});
test('rejects unsupported platforms and Node requirements before package download',{timeout:30000},async t=>{
  for(const options of [{platforms:['darwin-arm64']},{nodeMajor:99}]){const f=await fixture(t,options);assert.notEqual((await f.run()).code,0);assert.equal((await f.events()).filter(e=>e.kind==='curl'&&e.args.some(a=>a.endsWith('.tgz'))).length,0);}
});
test('new installer never overwrites an existing Host or command',{timeout:30000},async t=>{
  const f=await fixture(t);await mkdir(f.state,{recursive:true});await writeFile(join(f.state,'connection.json'),'private-state');
  const r=await f.run();assert.notEqual(r.code,0);assert.equal(await readFile(join(f.state,'connection.json'),'utf8'),'private-state');assert.deepEqual(await f.events(),[]);
  await rm(f.state,{recursive:true});await mkdir(f.commands);await writeFile(join(f.commands,'agent-remote-controller'),'original');
  assert.notEqual((await f.run()).code,0);assert.equal(await readFile(join(f.commands,'agent-remote-controller'),'utf8'),'original');
});
test('install only needs no key or service and supports a runtime state override',{timeout:30000},async t=>{
  const f=await fixture(t);const r=await f.run(['--no-start']);assert.equal(r.code,0,r.output);assert.ok(!(await f.events()).some(e=>e.args?.[0]==='start'));
  await exec(join(f.commands,'agent-remote-controller'),['status'],{env:{...f.env,AGENT_HOST_STATE_DIR:join(f.root,'override')},timeout:5000});
  assert.equal((await f.events()).at(-1).state,join(f.root,'override'));
});
async function existingController(f, check) {
  await mkdir(f.commands, {recursive:true});
  const path=join(f.commands,'agent-remote-controller');
  await writeFile(path, `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'update',args})+'\\n');\nif(args.includes('--check'))console.log(${JSON.stringify(JSON.stringify(check))});else if(args[0]==='update')console.log('Controller update completed.');else process.exit(1);\n`, {mode:0o755});
  return path;
}
test('existing install checks updates without consuming a pairing key and never consents noninteractively',{timeout:30000},async t=>{
  const f=await fixture(t);await existingController(f,{current:'1.0.0',version:'1.2.3',available:true});
  const r=await f.run();assert.equal(r.code,0,r.output);assert.match(r.output,/Update.*1.0.0.*1.2.3/);assert.match(r.output,/not changed/);
  assert.equal((await f.events()).filter(e=>e.kind==='update').length,1);assert.ok(!(await f.events()).some(e=>e.kind==='curl'));
});
test('explicit update consent reuses the installed updater without starting or pairing',{timeout:30000},async t=>{
  const f=await fixture(t);await existingController(f,{current:'1.0.0',version:'1.2.3',available:true});
  const r=await f.run(['--yes']);assert.equal(r.code,0,r.output);
  const calls=(await f.events()).filter(e=>e.kind==='update');assert.deepEqual(calls[1].args,['update','--version','1.2.3','--yes']);
});
test('existing install with no compatible update keeps its version even with consent',{timeout:30000},async t=>{
  const f=await fixture(t);await existingController(f,{current:'1.2.3',available:false,message:'No compatible newer release.'});
  const r=await f.run(['--yes']);assert.equal(r.code,0,r.output);assert.match(r.output,/No compatible newer release/);assert.equal((await f.events()).length,1);
});
test('first installation explains where to create the one-time pairing key',{timeout:30000},async t=>{
  const f=await fixture(t);const r=await f.run();assert.equal(r.code,0,r.output);
  assert.match(r.output,/https:\/\/agents.xianliao.de5.net/);assert.match(r.output,/Pairing keys/);assert.match(r.output,/Generate pairing key/);
});

test('clean install is an explicit choice and preserves the existing identity',{timeout:30000},async t=>{
  const f=await fixture(t);await existingController(f,{current:'1.2.3',version:'1.2.3',available:false,canClean:true});
  await mkdir(f.state,{recursive:true});await writeFile(join(f.state,'connection.json'),'private-state');
  const r=await f.run(['--yes','--clean']);assert.equal(r.code,0,r.output);
  assert.match(r.output,/uninstall and reinstall/);
  assert.deepEqual((await f.events()).filter(e=>e.kind==='update')[1].args,['update','--version','1.2.3','--yes','--clean']);
  assert.equal(await readFile(join(f.state,'connection.json'),'utf8'),'private-state');
});
async function terminal(f, answers, args=[]) {
  const driver=join(f.root,'terminal.py');
  await writeFile(driver, `import os,pty,select,sys,time,json,signal
pid,fd=pty.fork()
if pid==0: os.execve('/bin/sh',json.loads(os.environ['TEST_ARGS']),dict(os.environ))
answers=json.loads(os.environ['TEST_ANSWERS']);out=b'';deadline=time.time()+20
try:
 while time.time()<deadline:
  if select.select([fd],[],[],0.1)[0]:
   try: data=os.read(fd,65536)
   except OSError: break
   if not data: break
   out+=data
   if answers and answers[0][0].encode() in out:
    os.write(fd,(answers.pop(0)[1]+'\\n').encode())
 _,status=os.waitpid(pid,os.WNOHANG)
 if status==0 and time.time()>=deadline: raise RuntimeError('Terminal timed out')
 sys.stdout.buffer.write(out)
finally:
 try: os.kill(pid,signal.SIGKILL)
 except ProcessLookupError: pass
 os.close(fd)
`);
  const result=await exec('python3',[driver],{env:{...f.env,TEST_ARGS:JSON.stringify(['/bin/sh',script,'--prefix',f.prefix,'--bin-dir',f.commands,'--name','sunny-test-ab1234','--server','https://agents.xianliao.de5.net',...args]),TEST_ANSWERS:JSON.stringify(answers)},timeout:25000,maxBuffer:1024*1024});
  return result.stdout;
}
for(const answer of ['update','clean','cancel'])test(`terminal selection ${answer} only performs the selected action`,{timeout:30000},async t=>{
  const f=await fixture(t);await existingController(f,{current:'1.0.0',version:'1.2.3',available:true,canClean:true});
  const output=await terminal(f,[['Choose Update / Clean install / Cancel',answer]]);
  assert.match(output,/Clean install/);
  const calls=(await f.events()).filter(e=>e.kind==='update');assert.equal(calls.length,answer==='cancel'?1:2);
  if(answer!=='cancel')assert.equal(calls[1].args.includes('--clean'),answer==='clean');
});
test('first install terminal explains pairing and hides the pasted key',{timeout:30000},async t=>{
  const f=await fixture(t);const output=await terminal(f,[['(hidden): ',invitation]]);
  assert.match(output,/Generate pairing key/);assert.match(output,/is ready|uplink is registered/);assert.ok(!output.includes(invitation));
});

test('existing wrappers retain their configured state unless explicitly overridden',{timeout:30000},async t=>{
  const f=await fixture(t);delete f.env.AGENT_HOST_STATE_DIR;
  await mkdir(f.commands,{recursive:true});
  await writeFile(join(f.commands,'agent-remote-controller'),`#!${process.execPath}\nif(process.env.AGENT_HOST_STATE_DIR)throw Error('Wrong Host state forced into wrapper');console.log(JSON.stringify({current:'1.2.3',available:false}));`,{mode:0o755});
  const r=await f.run();assert.equal(r.code,0,r.output);
});

test('inside a container installation runs foreground without daemon or service-manager startup',{timeout:30000},async t=>{
 const f=await fixture(t);f.env.container='docker';const r=await f.run();assert.equal(r.code,0,r.output);
 const calls=(await f.events()).filter(e=>e.kind==='cli');
 assert.ok(calls.some(e=>e.args[0]==='foreground'));assert.ok(!calls.some(e=>['start','autostart'].includes(e.args[0])));
 assert.match(r.output,/keep this process running/);
});
test('the complete script can be piped into sh with pairing input from a file',{timeout:30000},async t=>{
 const f=await fixture(t);const source=await readFile(script,'utf8');
 const result=await new Promise((resolve,reject)=>{
  const child=execFile('/bin/sh',['-s','--','--prefix',f.prefix,'--bin-dir',f.commands,'--name','pipe-test','--server','https://agents.xianliao.de5.net','--key-file',join(f.root,'key')],{env:f.env,timeout:20000},(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve(stdout+stderr));
  child.stdin.end(source);
 });
 assert.match(result,/Host pipe-test is ready|uplink is registered/);
 assert.ok((await f.events()).some(e=>e.kind==='cli'&&['start','foreground'].includes(e.args[0])));
});
