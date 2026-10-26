import { createConnection, createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '@orchardworks/agent-platform';
import { serveOpenCodeServerSupervisor } from './opencode-server-supervisor.js';

interface Owner { running: true; pid: number; nativePid: number; version: string; url: string; generation: string; managementPort: number; token: string }
// Each test starts real processes; under a full parallel suite their startup alone can take seconds.
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
}, 30000);
async function availablePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function control(owner: Owner, action = 'status', token = owner.token) {
  return fetch(`http://127.0.0.1:${owner.managementPort}/control`, { method: 'POST', body: JSON.stringify({ action, token }), signal: AbortSignal.timeout(10000) });
}
async function fixture(mode = 'ready') {
  const directory = await mkdtemp(join(tmpdir(), 'arc-opencode-supervisor-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const executable = join(directory, 'opencode.mjs');
  const url = `http://127.0.0.1:${await availablePort()}`;
  await writeFile(join(directory, 'config.json'), JSON.stringify({ url, username: 'opencode', password: 'private-native-password' }));
  await writeFile(executable, `
    import {createServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    import {spawn} from 'node:child_process';
    const mode = process.env.TEST_NATIVE_MODE;
    const args = process.argv.slice(2);
    const descendant = mode === 'descendant' ? spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}) : undefined;
    writeFileSync(process.env.TEST_NATIVE_REPORT, JSON.stringify({pid:process.pid,descendant:descendant?.pid,args,secret:process.env.AGENT_HOST_REMOTE_KEY,password:process.env.OPENCODE_PASSWORD}));
    if (mode === 'exit') { process.stderr.write('private-native-password'); process.exit(7); }
    if (mode === 'no-listening') setInterval(()=>{},1000);
    else {
      const hostname = args[args.indexOf('--hostname')+1];
      const port = Number(args[args.indexOf('--port')+1]);
      const server = createServer((req,res)=>{
        if (req.headers.authorization !== 'Basic '+Buffer.from('opencode:private-native-password').toString('base64')) {res.writeHead(401).end();return;}
        if (req.url !== '/api/info') {res.writeHead(404).end();return;}
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({version:mode === 'old-version' ? '2.0.24' : '2.0.25',pid:mode === 'wrong-pid' ? process.pid+1 : process.pid,urls:[],paths:mode === 'invalid-info' ? {} : {tmp:'/tmp'}}));
      });
      server.on('error',()=>process.exit(12));
      server.listen(mode === 'different-port' ? 0 : port,hostname,()=> {
        if (mode === 'noise') {process.stderr.write('private-native-password'.repeat(10000));process.stdout.write('x'.repeat(100000)+'\\n');}
        process.stdout.write('server listening on http://'+hostname+':'+server.address().port+'\\n');
      });
      if (mode === 'ignore-term') process.on('SIGTERM',()=>{});
    }
  `);
  const environment = { ...process.env, AGENT_HOST_OPENCODE: executable, AGENT_HOST_REMOTE_KEY: 'relay-secret', TEST_NATIVE_MODE: mode,
    TEST_NATIVE_REPORT: join(directory, 'native.json'), AGENT_HOST_OPENCODE_START_REVISION: 'initial' };
  let outcome: Promise<{ error?: Error }> | undefined;
  const start = () => outcome = serveOpenCodeServerSupervisor(directory, environment).then(() => ({}), error => ({ error }));
  cleanup.push(async () => {
    try { const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as Owner; await control(owner, 'stop'); } catch {}
    let nativePid: number | undefined;
    try { nativePid = JSON.parse(await readFile(join(directory, 'native.json'), 'utf8')).pid; } catch {}
    if (nativePid) {
      try { process.kill(nativePid, 'SIGKILL'); } catch {}
      if (process.platform !== 'win32') { try { process.kill(-nativePid, 'SIGKILL'); } catch {} }
    }
    if (outcome) await outcome;
  });
  return { directory, url, start, environment,
    async marker() {
      let result: Owner | undefined;
      await expect.poll(async () => {
        const marker = (await readdir(directory)).find(name => name.startsWith('starting-'));
        if (!marker) return false;
        try { result = JSON.parse(await readFile(join(directory, marker), 'utf8')); return true; } catch { return false; }
      }, { timeout: 10_000 }).toBe(true);
      return result!;
    },
    async owner() {
      let result: Owner | undefined;
      await expect.poll(async () => { try { result = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(true);
      return result!;
    },
  };
}

it('owns a real authenticated native server and stops it only through its private control endpoint', async () => {
  const f = await fixture();
  const outcome = f.start();
  const owner = await f.owner();
  expect(owner).toMatchObject({ running: true, pid: process.pid, version: '2.0.25', url: f.url });
  expect(owner.nativePid).not.toBe(process.pid);
  expect(owner.generation).toBeTruthy();
  const report = JSON.parse(await readFile(join(f.directory, 'native.json'), 'utf8'));
  expect(report).toMatchObject({ password: 'private-native-password', args: ['serve', '--hostname', '127.0.0.1', '--port', new URL(f.url).port] });
  expect(report.secret).toBeUndefined();
  const unauthenticated = await fetch(`${f.url}/api/info`, { signal: AbortSignal.timeout(2000) });
  expect(unauthenticated.status).toBe(401);
  expect((await control(owner, 'stop', 'wrong-token')).status).toBe(403);
  const status = await (await control(owner)).json();
  expect(status).toEqual(Object.fromEntries(Object.entries(owner).filter(([key]) => key !== 'token')));
  expect(await (await control(owner, 'stop')).json()).toEqual({ running: false });
  expect(await outcome).toEqual({});
  await expect(fetch(`${f.url}/api/info`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  expect(JSON.parse(await readFile(join(f.directory, 'owner.json'), 'utf8')).generation).toBe(owner.generation);
}, 30000);

it.each(['exit', 'different-port', 'old-version', 'invalid-info', ...(process.platform === 'win32' ? [] : ['wrong-pid'])])('does not publish a server that fails readiness: %s', async mode => {
  const f = await fixture(mode);
  const result = await f.start();
  expect(result.error).toBeInstanceOf(Error);
  expect(result.error!.message).not.toContain('private-native-password');
  await expect(readFile(join(f.directory, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(f.directory)).some(name => name.startsWith('starting-'))).toBe(false);
}, 30000);

it('keeps the winning owner when two supervisors race for the same endpoint', async () => {
  const f = await fixture();
  const first = f.start();
  const owner = await f.owner();
  expect((await f.start()).error).toBeInstanceOf(Error);
  expect(JSON.parse(await readFile(join(f.directory, 'owner.json'), 'utf8'))).toEqual(owner);
  expect((await control(owner)).status).toBe(200);
  await control(owner, 'stop');
  expect(await first).toEqual({});
}, 30000);

it('can stop an in-progress startup through its management marker', async () => {
  const f = await fixture('no-listening');
  const outcome = f.start();
  const marker = await f.marker();
  expect(await (await control(marker)).json()).toMatchObject({ running: false, phase: 'starting' });
  expect(await (await control(marker, 'stop')).json()).toEqual({ running: false });
  expect((await outcome).error).toBeInstanceOf(Error);
  await expect(readFile(join(f.directory, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

it('honors a changed preference revision while starting', async () => {
  const f = await fixture('no-listening');
  const outcome = f.start();
  await f.marker();
  await writeFile(join(f.directory, 'prefs.json'), JSON.stringify({ enabled: false, revision: 'manual-stop' }));
  expect((await outcome).error?.message).toMatch(/superseded or disabled/);
  await expect(readFile(join(f.directory, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

it('does not spawn when a stale startup revision has already been disabled', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'prefs.json'), JSON.stringify({ enabled: false, revision: 'manual-stop' }));
  expect((await f.start()).error?.message).toMatch(/superseded or disabled/);
  await expect(readFile(join(f.directory, 'native.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

it('leaves a stale owner record after native exit without claiming a live server', async () => {
  const f = await fixture();
  const outcome = f.start();
  const owner = await f.owner();
  process.kill(owner.nativePid, 'SIGTERM');
  expect((await outcome).error?.message).toMatch(/exited unexpectedly/);
  await expect(control(owner)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(f.directory, 'owner.json'), 'utf8'))).toEqual(owner);
}, 30000);

it('drains noisy native output without losing the readiness announcement', async () => {
  const f = await fixture('noise');
  const outcome = f.start();
  const owner = await f.owner();
  expect((await control(owner)).status).toBe(200);
  await control(owner, 'stop');
  expect(await outcome).toEqual({});
}, 30000);

it.each(['stop', 'native exit'])('settles %s after publishing readiness while the owner write is still returning', async action => {
  const f = await fixture();
  const write = platform.atomicWriteFile;
  vi.spyOn(platform, 'atomicWriteFile').mockImplementation(async (...args) => {
    await write(...args);
    if (args[0] !== join(f.directory, 'owner.json')) return;
    const owner = JSON.parse(await readFile(args[0], 'utf8')) as Owner;
    if (action === 'stop') expect((await control(owner, 'stop')).status).toBe(200);
    else {
      process.kill(owner.nativePid, 'SIGTERM');
      await expect.poll(async () => (await (await control(owner)).json()).running, { timeout: 4000 }).toBe(false);
    }
  });
  const outcome = await f.start();
  if (action === 'stop') expect(outcome).toEqual({});
  else expect(outcome.error?.message).toMatch(/exited unexpectedly/);
}, 30000);

it('waits for forced termination when the native process ignores graceful stop', async () => {
  const f = await fixture('ignore-term');
  const outcome = f.start();
  const owner = await f.owner();
  const started = Date.now();
  expect(await (await control(owner, 'stop')).json()).toEqual({ running: false });
  if (process.platform !== 'win32') expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  expect(await outcome).toEqual({});
  expect(() => process.kill(owner.nativePid, 0)).toThrow();
}, 30000);

it('does not treat a healthy unrelated endpoint as evidence that its own child started', async () => {
  const f = await fixture('no-listening');
  const external = createHttpServer((_request, response) => response.end(JSON.stringify({ version: '2.0.25', pid: process.pid, urls: [], paths: { tmp: '/tmp' } })));
  cleanup.push(() => new Promise<void>(resolve => external.close(() => resolve())));
  await new Promise<void>(resolve => external.listen(Number(new URL(f.url).port), '127.0.0.1', resolve));
  const outcome = f.start();
  const marker = await f.marker();
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(await (await control(marker)).json()).toMatchObject({ running: false, phase: 'starting' });
  await expect(readFile(join(f.directory, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await control(marker, 'stop');
  expect((await outcome).error).toBeInstanceOf(Error);
  expect((await fetch(f.url, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
}, 30000);

it('bounds unauthenticated control requests without interrupting the native server', async () => {
  const f = await fixture();
  const outcome = f.start();
  const owner = await f.owner();
  const oversized = await fetch(`http://127.0.0.1:${owner.managementPort}/control`, { method: 'POST', body: 'x'.repeat(10000), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  if (oversized) expect(oversized.ok).toBe(false);
  const socket = createConnection(owner.managementPort, '127.0.0.1');
  cleanup.push(async () => socket.destroy());
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.on('error', () => {});
  socket.write('POST /control HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{');
  await closed;
  expect((await control(owner)).status).toBe(200);
  await control(owner, 'stop');
  expect(await outcome).toEqual({});
}, 10000);

it('uses an absolute deadline for a control body that keeps trickling bytes', async () => {
  const f = await fixture();
  const outcome = f.start();
  const owner = await f.owner();
  const socket = createConnection(owner.managementPort, '127.0.0.1');
  const timer = setInterval(() => socket.write('.'), 100);
  cleanup.push(async () => { clearInterval(timer); socket.destroy(); });
  socket.on('error', () => {});
  socket.write('POST /control HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{');
  let closed = false;
  socket.once('close', () => { closed = true; });
  await expect.poll(() => closed, { timeout: 3500 }).toBe(true);
  await control(owner, 'stop');
  expect(await outcome).toEqual({});
}, 10000);

it('ends a startup without a native readiness announcement within its deadline', async () => {
  const f = await fixture('no-listening');
  const started = Date.now();
  expect((await f.start()).error?.message).toMatch(/within 15 seconds/);
  expect(Date.now() - started).toBeLessThan(18000);
  const { pid } = JSON.parse(await readFile(join(f.directory, 'native.json'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await readdir(f.directory)).some(name => name.startsWith('starting-'))).toBe(false);
}, 25000);

it.skipIf(process.platform === 'win32')('runs the Windows job launcher with the supervisor as owner and preserves native output and credentials', async () => {
  const f = await fixture();
  const systemRoot = join(f.directory, 'windows');
  const powershellDirectory = join(systemRoot, 'System32/WindowsPowerShell/v1.0');
  await mkdir(powershellDirectory, { recursive: true });
  const executable = join(powershellDirectory, 'powershell.exe');
  const launchReport = join(f.directory, 'job-launch.json');
  await writeFile(executable, `#!${process.execPath}
    const {spawn}=require('node:child_process');
    const {writeFileSync}=require('node:fs');
    const args=process.argv.slice(2);
    writeFileSync(${JSON.stringify(launchReport)},JSON.stringify({args,script:Buffer.from(args.at(-1),'base64').toString('utf16le')}));
    const child=spawn(process.execPath,${JSON.stringify([f.environment.AGENT_HOST_OPENCODE, 'serve', '--hostname', '127.0.0.1', '--port', new URL(f.url).port])},{env:process.env,stdio:'inherit'});
    child.on('exit',code=>process.exit(code??0));
    process.on('SIGTERM',()=>child.kill('SIGTERM'));
  `);
  await chmod(executable, 0o700);
  vi.stubEnv('SystemRoot', systemRoot);
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
  const outcome = f.start();
  const owner = await Promise.race([f.owner(), outcome.then(result => { throw result.error ?? new Error('Supervisor exited before readiness.'); })]);
  const native = JSON.parse(await readFile(join(f.directory, 'native.json'), 'utf8'));
  expect(native.pid).toBe(owner.nativePid);
  const launch = JSON.parse(await readFile(launchReport, 'utf8'));
  expect(launch.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  expect(launch.script).toContain(`,${process.pid})`);
  expect(launch.script).not.toContain('private-native-password');
  expect(native.password).toBe('private-native-password');
  expect(native.secret).toBeUndefined();
  expect(await (await control(owner, 'stop')).json()).toEqual({ running: false });
  expect(await outcome).toEqual({});
}, 30000);

it.runIf(process.platform === 'win32')('reclaims Windows native descendants when the owned job launcher stops', async () => {
  const f = await fixture('descendant');
  const outcome = f.start();
  const owner = await f.owner();
  const native = JSON.parse(await readFile(join(f.directory, 'native.json'), 'utf8'));
  expect(native.descendant).toBeTypeOf('number');
  await control(owner, 'stop');
  expect(await outcome).toEqual({});
  await expect.poll(() => [owner.nativePid, native.pid, native.descendant].filter(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }), { timeout: 5000 }).toEqual([]);
}, 20000);

it.runIf(process.platform === 'win32')('reclaims Windows native descendants when their native parent exits first', async () => {
  const f = await fixture('descendant');
  const outcome = f.start();
  const owner = await f.owner();
  const native = JSON.parse(await readFile(join(f.directory, 'native.json'), 'utf8'));
  process.kill(native.pid, 'SIGTERM');
  await outcome;
  await expect.poll(() => [owner.nativePid, native.pid, native.descendant].filter(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }), { timeout: 5000 }).toEqual([]);
}, 20000);

it.skipIf(process.platform === 'win32').each(['stop', 'native exit'])('reclaims the owned POSIX process group after %s even when descendants ignore SIGTERM', async action => {
  const f = await fixture('descendant');
  const outcome = f.start();
  const owner = await f.owner();
  const native = JSON.parse(await readFile(join(f.directory, 'native.json'), 'utf8'));
  if (action === 'stop') expect(await (await control(owner, 'stop')).json()).toEqual({ running: false });
  else process.kill(native.pid, 'SIGTERM');
  await outcome;
  await expect.poll(() => [native.descendant, -native.pid].filter(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }), { timeout: 1000 }).toEqual([]);
}, 30000);
