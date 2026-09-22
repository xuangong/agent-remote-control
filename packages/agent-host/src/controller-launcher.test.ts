import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.each([false, true])('switches a real child process and rolls back a failed candidate: %s', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'controller-launcher-'));
  const launcher = join(root, 'launcher.mjs');
  const updates = join(root, 'controller-updates');
  const target = join(updates, 'packages/0.2.0/node_modules/@orchardworks/agent-remote-controller/dist');
  await mkdir(target, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(updates, 'status.json'), JSON.stringify({ phase: 'waiting', version: '0.2.0', operationId: 'test-operation', updatedAt: Date.now() }));
  await cp(fileURLToPath(new URL('../../../scripts/controller-launcher.mjs', import.meta.url)), launcher);
  await writeFile(join(root, 'cli.js'), `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
    const root=process.env.AGENT_HOST_STATE_DIR;
    appendFileSync(root+'/children', 'old\\n');
    process.send({type:'controller-ready',version:'0.1.0'});
    if(!existsSync(root+'/attempted')) {writeFileSync(root+'/attempted','yes');setTimeout(()=>process.send({type:'controller-update',version:'0.2.0'}),30);}
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  await writeFile(join(target, 'cli.js'), failure ? 'process.exit(1);' : `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.AGENT_HOST_STATE_DIR+'/children','new\\n'); process.send({type:'controller-ready',version:'0.2.0'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [launcher, 'foreground'], { env: { ...process.env, AGENT_HOST_STATE_DIR: root }, stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await expect.poll(async () => JSON.parse(await readFile(join(updates, 'status.json'), 'utf8')).phase, { timeout: 7000 }).toBe(failure ? 'failed' : 'succeeded');
    await expect.poll(async () => (await readFile(join(root, 'children'), 'utf8')).trim().split('\n')).toEqual(failure ? ['old', 'old'] : ['old', 'new']);
    if (!failure) expect(JSON.parse(await readFile(join(updates, 'current.json'), 'utf8'))).toEqual({ version: '0.2.0' });
    expect(stderr).toBe('');
  } finally { child.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true }); }
}, 10000);
it('recovers an interrupted restart to the saved version and allows another attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controller-interrupted-'));
  await mkdir(join(root, 'controller-updates'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'controller-updates/status.json'), JSON.stringify({ phase: 'restarting', version: '0.2.0', operationId: 'interrupted', updatedAt: 0 }));
  await cp(fileURLToPath(new URL('../../../scripts/controller-launcher.mjs', import.meta.url)), join(root, 'launcher.mjs'));
  await writeFile(join(root, 'cli.js'), "process.send({type:'controller-ready',version:'0.1.0'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);");
  const child = spawn(process.execPath, [join(root, 'launcher.mjs'), 'foreground'], { env: { ...process.env, AGENT_HOST_STATE_DIR: root }, stdio: 'pipe' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await expect.poll(async () => JSON.parse(await readFile(join(root, 'controller-updates/status.json'), 'utf8')).phase).toBe('failed');
    expect(child.exitCode).toBeNull();
  } finally { child.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true }); }
}, 10000);
