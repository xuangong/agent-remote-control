import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

async function stopLauncher(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => {
    const deadline = setTimeout(() => {
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => {});
      else child.kill('SIGKILL');
    }, 3000);
    child.once('exit', () => { clearTimeout(deadline); done(); });
    if (process.platform === 'win32') child.send({ type: 'controller-shutdown' }, () => {});
    else child.kill('SIGTERM');
  });
}
const gracefulStop = `const stop=()=>{setTimeout(()=>process.exit(0),30);};
  process.on('SIGTERM',stop);process.on('message',message=>{if(message.type==='controller-shutdown')stop();});`;

it.each([
  { failure: false, container: false, clean: false }, { failure: true, container: false, clean: false },
  { failure: false, container: false, clean: true }, { failure: true, container: false, clean: true },
  ...(process.platform === 'linux' ? [{ failure: false, container: true, clean: false }, { failure: true, container: true, clean: false }] : []),
])('switches and rolls back real children: %j', async ({ failure, container, clean }) => {
  const root = await mkdtemp(join(tmpdir(), 'controller launcher & 中文 '));
  const launcher = join(root, container ? 'agent-remote-controller' : 'launcher.mjs');
  const updates = join(root, 'controller-updates');
  const active = join(updates, 'packages/0.2.0/node_modules/@orchardworks/agent-remote-controller/dist');
  const target = clean ? join(updates, 'packages/0.2.0.reinstall/node_modules/@orchardworks/agent-remote-controller/dist') : active;
  await mkdir(target, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(updates, 'status.json'), JSON.stringify({ phase: 'waiting', version: '0.2.0', operationId: 'test-operation', updatedAt: Date.now() }));
  await cp(fileURLToPath(new URL('../../../scripts/controller-launcher.mjs', import.meta.url)), launcher);
  await writeFile(join(root, 'connection.json'), '{"serverUrl":"https://relay.example","remoteKey":"retained-test-credential"}');
  await writeFile(join(root, 'installation-id'), 'retained-installation');
  await writeFile(join(root, 'cli.js'), `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
    const root=process.env.AGENT_HOST_STATE_DIR;
    if(existsSync(root+'/attempted')&&process.env.AGENT_HOST_REMOTE_KEY)writeFileSync(root+'/reused-key','yes');
    appendFileSync(root+'/children', 'old\\n');
    process.send({type:'controller-ready',version:'0.1.0'});
    if(!existsSync(root+'/attempted')) {writeFileSync(root+'/attempted','yes');setTimeout(()=>process.send({type:'controller-update',version:'0.2.0',clean:${clean}}),30);}
    const stop=()=>{writeFileSync(root+'/cleaned','yes');setTimeout(()=>process.exit(0),30);};
    process.on('SIGTERM',stop);process.on('message',message=>{if(message.type==='controller-shutdown')stop();});setInterval(()=>{},1000);`);
  if (clean) {
    await mkdir(active, { recursive: true });
    await cp(join(root,'cli.js'),join(active,'cli.js'));
    await writeFile(join(active,'old-runtime-marker'),'remove on reinstall');
    await mkdir(join(updates,'packages/0.2.0.clean-backup'),{recursive:true});
    await writeFile(join(updates,'packages/0.2.0.clean-backup/committed-backup'),'left over after an interrupted cleanup');
    await writeFile(join(updates,'current.json'),JSON.stringify({version:'0.2.0'}));
  }
  await writeFile(join(target, 'cli.js'), failure ? 'process.exit(1);' : `import {existsSync,appendFileSync} from 'node:fs';
    if(process.env.AGENT_HOST_REMOTE_KEY||process.env.AGENT_HOST_SERVER)process.exit(3);
    if(!existsSync(process.env.AGENT_HOST_STATE_DIR+'/cleaned'))process.exit(2);
    appendFileSync(process.env.AGENT_HOST_STATE_DIR+'/children','new\\n'); process.send({type:'controller-ready',version:'0.2.0'});${gracefulStop}setInterval(()=>{},1000);`);
  await chmod(launcher, 0o755);
  const entry = container ? fileURLToPath(new URL('../../../scripts/controller/entrypoint.mjs', import.meta.url)) : launcher;
  const launch = () => spawn(process.execPath, [entry, 'foreground'], { env: { ...process.env, AGENT_HOST_STATE_DIR: root,
    AGENT_HOST_SERVER:'https://relay.example',AGENT_HOST_REMOTE_KEY:'one-time-fixture-invitation',
    ...(container ? { PATH: `${root}:${process.env.PATH}` } : {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let child = launch();
  let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
  try {
    await expect.poll(async () => JSON.parse(await readFile(join(updates, 'status.json'), 'utf8')).phase, { timeout: 7000 }).toBe(failure ? 'failed' : 'succeeded');
    await expect.poll(async () => (await readFile(join(root, 'children'), 'utf8')).trim().split('\n')).toEqual(failure ? ['old', 'old'] : ['old', 'new']);
    if (!failure) expect(JSON.parse(await readFile(join(updates, 'current.json'), 'utf8'))).toEqual({ version: '0.2.0' });
    expect(await readFile(join(root, 'cleaned'), 'utf8')).toBe('yes');
    expect(await readFile(join(root, 'connection.json'), 'utf8')).toBe('{"serverUrl":"https://relay.example","remoteKey":"retained-test-credential"}');
    expect(await readFile(join(root, 'installation-id'), 'utf8')).toBe('retained-installation');
    expect(stderr).toBe('');
    await expect(readFile(join(root,'reused-key'))).rejects.toMatchObject({code:'ENOENT'});
    if (clean) {
      if (failure) expect(await readFile(join(active,'old-runtime-marker'),'utf8')).toBe('remove on reinstall');
      else await expect(readFile(join(active,'old-runtime-marker'))).rejects.toMatchObject({code:'ENOENT'});
      await expect(readFile(join(updates,'reinstall.json'))).rejects.toMatchObject({code:'ENOENT'});
      expect(await readFile(join(root,'cli.js'),'utf8')).toContain('controller-update');
    }
    if (container) {
      await stopLauncher(child);
      expect(child.exitCode).toBe(0);
      child = launch();
      await expect.poll(async () => (await readFile(join(root, 'children'), 'utf8')).trim().split('\n')).toEqual(
        failure ? ['old', 'old', 'old'] : ['old', 'new', 'new']);
      expect(JSON.parse(await readFile(join(updates, 'status.json'), 'utf8')).phase).toBe(failure ? 'failed' : 'succeeded');
    }
  } finally { await stopLauncher(child); await rm(root, { recursive: true, force: true }); }
}, 10000);
it('recovers an interrupted restart to the saved version and allows another attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controller-interrupted-'));
  await mkdir(join(root, 'controller-updates'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'controller-updates/status.json'), JSON.stringify({ phase: 'restarting', version: '0.2.0', operationId: 'interrupted', updatedAt: 0 }));
  await cp(fileURLToPath(new URL('../../../scripts/controller-launcher.mjs', import.meta.url)), join(root, 'launcher.mjs'));
  await writeFile(join(root, 'cli.js'), `process.send({type:'controller-ready',version:'0.1.0'});${gracefulStop}setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [join(root, 'launcher.mjs'), 'foreground'], { env: { ...process.env, AGENT_HOST_STATE_DIR: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    await expect.poll(async () => JSON.parse(await readFile(join(root, 'controller-updates/status.json'), 'utf8')).phase).toBe('failed');
    expect(child.exitCode).toBeNull();
  } finally { await stopLauncher(child); await rm(root, { recursive: true, force: true }); }
}, 10000);
it.each([false,true])('restores an interrupted same-version clean install (new files activated: %s)',async activated=>{
 const root=await mkdtemp(join(tmpdir(),'controller-clean-recovery-'));
 const updates=join(root,'controller-updates'), target=join(updates,'packages/0.2.0');
 const relative='node_modules/@orchardworks/agent-remote-controller/dist/cli.js';
 await mkdir(join(target+'.clean-backup','node_modules/@orchardworks/agent-remote-controller/dist'),{recursive:true});
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 await cp(fileURLToPath(new URL('../../../scripts/controller-launcher.mjs',import.meta.url)),join(root,'launcher.mjs'));
 await writeFile(join(target+'.clean-backup',relative),`import {writeFileSync} from 'node:fs';writeFileSync(process.env.AGENT_HOST_STATE_DIR+'/restored','yes');${gracefulStop}setInterval(()=>{},1000);`);
 if(activated){await mkdir(join(target,'node_modules/@orchardworks/agent-remote-controller/dist'),{recursive:true});await writeFile(join(target,relative),'process.exit(99);');}
 await writeFile(join(updates,'current.json'),JSON.stringify({version:'0.2.0'}));
 await writeFile(join(updates,'reinstall.json'),JSON.stringify({version:'0.2.0',hadTarget:true,savedVersion:'0.2.0'}));
 const child=spawn(process.execPath,[join(root,'launcher.mjs'),'foreground'],{env:{...process.env,AGENT_HOST_STATE_DIR:root},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 try {
  await expect.poll(()=>readFile(join(root,'restored'),'utf8')).toBe('yes');
  expect(JSON.parse(await readFile(join(updates,'status.json'),'utf8'))).toMatchObject({phase:'failed',message:expect.stringContaining('previous Controller was restored')});
  await expect(readFile(join(updates,'reinstall.json'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{await stopLauncher(child);await rm(root,{recursive:true,force:true});}
},10000);
