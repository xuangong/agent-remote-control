import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { loadOpenCodeServerCredentials, openCodeServerCommand, prepareOpenCodeServer, type OpenCodeServerStatus } from './opencode-server.js';

const cleanup: Array<() => Promise<unknown>> = [];
const options = { cli: fileURLToPath(new URL('../dist/cli.js', import.meta.url)) };
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 15_000);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function availableEndpoint(): Promise<string> {
  const server = createServer();
  const url = await listen(server);
  await close(server);
  return url;
}
interface NativeRun { pid: number; args: string[]; username?: string; password?: string }

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-opencode-manager-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const executable = join(directory, 'opencode.mjs');
  const report = join(directory, 'native.jsonl');
  await writeFile(executable, `
    import {createServer} from 'node:http';
    import {appendFileSync} from 'node:fs';
    const args = process.argv.slice(2);
    if (args.includes('--version')) { process.stdout.write((process.env.TEST_OPENCODE_CLI_VERSION ?? '2.0.25')+'\\n'); process.exit(0); }
    if (args[0] !== 'serve') process.exit(2);
    appendFileSync(process.env.TEST_OPENCODE_REPORT, JSON.stringify({pid:process.pid,args,
      username:'opencode',password:process.env.OPENCODE_PASSWORD})+'\\n');
    const username = 'opencode';
    const password = process.env.OPENCODE_PASSWORD;
    const authorization = 'Basic '+Buffer.from(username+':'+password).toString('base64');
    const hostname = args[args.indexOf('--hostname')+1];
    const port = Number(args[args.indexOf('--port')+1]);
    if (process.env.TEST_OPENCODE_STOP_DELAY) process.once('SIGTERM',()=>{
      appendFileSync(process.env.TEST_OPENCODE_REPORT+'.stopping',String(process.pid)+'\\n');
      setTimeout(()=>process.exit(0),Number(process.env.TEST_OPENCODE_STOP_DELAY));
    });
    const server = createServer((req,res)=>{
      if (password && req.headers.authorization !== authorization) { res.writeHead(401).end(); return; }
      if (req.url === '/crash') { res.end(); setTimeout(()=>process.exit(9),10); return; }
      if (req.url !== '/api/info') { res.writeHead(404).end(); return; }
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({version:'2.0.25',pid:process.pid,urls:[],paths:{tmp:'/tmp'}}));
    });
    server.on('error',()=>process.exit(12));
    setTimeout(()=>server.listen(port,hostname,()=>{
      setTimeout(()=>process.stdout.write('server listening on http://'+hostname+':'+server.address().port+'\\n'),
        Number(process.env.TEST_OPENCODE_ANNOUNCE_DELAY ?? 0));
    }),Number(process.env.TEST_OPENCODE_DELAY ?? 0));
  `);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_HOST_OPENCODE') || key.startsWith('OPENCODE_SERVER_')) delete env[key];
  Object.assign(env, {
    AGENT_HOST_OPENCODE: executable,
    AGENT_HOST_OPENCODE_URL: await availableEndpoint(),
    AGENT_HOST_OPENCODE_AUTO_START: '1',
    TEST_OPENCODE_REPORT: report,
  }, overrides);
  const initialEnv = { ...env };
  const supervisorPids = new Set<number>();
  const nativeRuns = async (): Promise<NativeRun[]> => {
    try { return (await readFile(report, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  cleanup.push(async () => {
    try { await openCodeServerCommand('stop', directory, env, options); } catch {}
    for (const pid of [...supervisorPids, ...(await nativeRuns()).map(run => run.pid)]) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
  const runInSeparateProcess = async (action: 'prepare' | 'start'): Promise<OpenCodeServerStatus> => {
    const script = `const manager=await import(process.argv[1]);
      const status=process.argv[4]==='prepare'
        ? await manager.prepareOpenCodeServer(process.argv[2],process.env,{cli:process.argv[3]})
        : await manager.openCodeServerCommand(process.argv[4],process.argv[2],process.env,{cli:process.argv[3]});
      process.stdout.write(JSON.stringify(status));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script,
      new URL('../dist/opencode-server.js', import.meta.url).href, directory, options.cli, action],
    { env: { ...initialEnv }, timeout: 12_000, maxBuffer: 64 * 1024, windowsHide: true });
    const result = JSON.parse(stdout) as OpenCodeServerStatus;
    if (result.pid) supervisorPids.add(result.pid);
    return result;
  };
  return {
    directory, env, initialEnv, nativeRuns, stoppingReport: `${report}.stopping`,
    url: env.AGENT_HOST_OPENCODE_URL!,
    async prepare(environment = env) {
      const result = await prepareOpenCodeServer(directory, environment, options);
      if (result.pid) supervisorPids.add(result.pid);
      return result;
    },
    async command(action: 'start' | 'stop' | 'restart' | 'status', environment = env) {
      const result = await openCodeServerCommand(action, directory, environment, options);
      if (result.pid) supervisorPids.add(result.pid);
      return result;
    },
    prepareInSeparateProcess: () => runInSeparateProcess('prepare'),
    startInSeparateProcess: () => runInSeparateProcess('start'),
    headers(environment = env) {
      return { authorization: `Basic ${Buffer.from(`${environment.AGENT_HOST_OPENCODE_USERNAME}:${environment.AGENT_HOST_OPENCODE_PASSWORD}`).toString('base64')}` };
    },
  };
}

it('starts a local authenticated native server and reuses it with fresh Controller credentials', async () => {
  const f = await fixture();
  const first = await f.prepare();
  expect(first).toMatchObject({ running: true, ownership: 'managed', url: f.url, version: '2.0.25', autoStart: true });
  expect(first.pid).toBeGreaterThan(0);
  expect(first.nativePid).toBeGreaterThan(0);
  expect(first.pid).not.toBe(first.nativePid);
  expect(f.env.AGENT_HOST_OPENCODE_PASSWORD).toBeTruthy();
  expect((await fetch(`${f.url}/api/info`, { signal: AbortSignal.timeout(2_000) })).status).toBe(401);
  const health = await fetch(`${f.url}/api/info`, { headers: f.headers(), signal: AbortSignal.timeout(2_000) });
  expect(await health.json()).toEqual({ version: '2.0.25', pid: first.nativePid, urls: [], paths: { tmp: '/tmp' } });
  const fresh = { ...f.initialEnv };
  expect(await f.prepare(fresh)).toMatchObject({ nativePid: first.nativePid, pid: first.pid });
  expect(fresh.AGENT_HOST_OPENCODE_PASSWORD).toBe(f.env.AGENT_HOST_OPENCODE_PASSWORD);
  expect((await f.prepare()).nativePid).toBe(first.nativePid);
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it.each(['2.0.25', 'v2.0.25', 'opencode v2.0.25'])('starts a compatible native server after CLI output %j', async version => {
  const f = await fixture({ TEST_OPENCODE_CLI_VERSION: version });
  expect(await f.prepare()).toMatchObject({ running: true, ownership: 'managed', version: '2.0.25' });
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it.each([
  ['opencode v1.19.0', 'opencode_api_unsupported'],
  ['3.0.0', 'opencode_api_unsupported'],
  ['2.0.24', 'opencode_version_unsupported'],
  ['another-agent v2.0.25', 'opencode_version_unsupported'],
])('rejects incompatible CLI output %j before executing serve', async (version, code) => {
  const f = await fixture({ TEST_OPENCODE_CLI_VERSION: version });
  await expect(f.prepare()).rejects.toMatchObject({ code, message: expect.stringContaining('OpenCode 2.x (2.0.25 or newer)') });
  expect(await f.nativeRuns()).toHaveLength(0);
  expect(await f.command('status')).toMatchObject({ running: false, ownership: 'none' });
}, 15_000);

it('deduplicates simultaneous startup into one native observation endpoint', async () => {
  const f = await fixture();
  const environments = Array.from({ length: 4 }, () => ({ ...f.initialEnv }));
  const statuses = await Promise.all(environments.map(env => f.prepare(env)));
  expect(statuses.every(status => status.running && status.ownership === 'managed')).toBe(true);
  expect(new Set(statuses.map(status => status.nativePid)).size).toBe(1);
  expect(new Set(environments.map(env => env.AGENT_HOST_OPENCODE_PASSWORD)).size).toBe(1);
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it('keeps the native session server alive after its starting Controller process exits', async () => {
  const f = await fixture();
  const started = await f.prepareInSeparateProcess();
  expect(started).toMatchObject({ running: true, ownership: 'managed' });
  const resumed = await f.prepare();
  expect(resumed).toMatchObject({ pid: started.pid, nativePid: started.nativePid, running: true });
  expect((await fetch(`${f.url}/api/info`, { headers: f.headers(), signal: AbortSignal.timeout(2_000) })).status).toBe(200);
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it('converges competing Controller processes onto one live native server', async () => {
  const f = await fixture();
  const results = await Promise.all([f.prepareInSeparateProcess(), f.prepareInSeparateProcess()]);
  expect(results.every(result => result.running && result.ownership === 'managed')).toBe(true);
  expect(new Set(results.map(result => result.nativePid)).size).toBe(1);
  const nativePid = results[0]!.nativePid;
  expect((await f.prepare()).nativePid).toBe(nativePid);
  for (const run of await f.nativeRuns()) {
    if (run.pid === nativePid) continue;
    await expect.poll(() => {
      try { process.kill(run.pid, 0); return true; } catch { return false; }
    }, { timeout: 4_000 }).toBe(false);
  }
}, 15_000);

it('waits for an existing managed startup before classifying its healthy endpoint', async () => {
  const f = await fixture({ TEST_OPENCODE_ANNOUNCE_DELAY: '1500' });
  const starting = f.prepareInSeparateProcess();
  await expect.poll(async () => (await f.nativeRuns()).length, { timeout: 4_000 }).toBe(1);
  await loadOpenCodeServerCredentials(f.directory, f.env);
  await expect.poll(async () => {
    try { return (await fetch(`${f.url}/api/info`, { headers: f.headers(), signal: AbortSignal.timeout(500) })).status; }
    catch { return 0; }
  }, { timeout: 2_000 }).toBe(200);
  const results = await Promise.all([starting, f.prepareInSeparateProcess()]);
  expect(results.every(result => result.running && result.ownership === 'managed')).toBe(true);
  expect(new Set(results.map(result => result.nativePid)).size).toBe(1);
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it('loads managed authentication for a separate CLI without starting or replacing the server', async () => {
  const f = await fixture();
  const uninitialized = { ...f.initialEnv };
  await loadOpenCodeServerCredentials(f.directory, uninitialized);
  expect(uninitialized.AGENT_HOST_OPENCODE_PASSWORD).toBeUndefined();
  expect(await f.nativeRuns()).toHaveLength(0);
  const started = await f.prepare();
  const fresh = { ...f.initialEnv };
  await loadOpenCodeServerCredentials(f.directory, fresh);
  expect(fresh.AGENT_HOST_OPENCODE_USERNAME).toBe(f.env.AGENT_HOST_OPENCODE_USERNAME);
  expect(fresh.AGENT_HOST_OPENCODE_PASSWORD).toBe(f.env.AGENT_HOST_OPENCODE_PASSWORD);
  expect((await fetch(`${f.url}/api/info`, { headers: f.headers(fresh), signal: AbortSignal.timeout(2_000) })).status).toBe(200);
  expect((await f.command('status')).nativePid).toBe(started.nativePid);
  await f.command('stop');
  await loadOpenCodeServerCredentials(f.directory, { ...f.initialEnv });
  expect((await f.command('status')).running).toBe(false);
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it('reuses an existing external server and never stops its process', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '2.0.25', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
  });
  const url = await listen(server);
  cleanup.push(() => close(server));
  const f = await fixture({ AGENT_HOST_OPENCODE_URL: url });
  expect(await f.prepare()).toMatchObject({ running: true, ownership: 'external', url, version: '2.0.25' });
  await expect(f.command('stop')).rejects.toMatchObject({ code: 'opencode_external_server' });
  await expect(f.command('restart')).rejects.toMatchObject({ code: 'opencode_external_server' });
  expect((await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2_000) })).status).toBe(200);
  expect(await f.command('status')).toMatchObject({ running: true, ownership: 'external' });
  expect(await f.nativeRuns()).toHaveLength(0);
}, 15_000);

it.each([undefined, '0'])('does not spawn for a custom endpoint with auto start set to %s', async autoStart => {
  const f = await fixture({ AGENT_HOST_OPENCODE_AUTO_START: autoStart });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'opencode_start_disabled' });
  expect(await f.command('status')).toMatchObject({ running: false, ownership: 'none', url: f.url, autoStart: false });
  expect(await f.nativeRuns()).toHaveLength(0);
}, 15_000);

it('recovers a crashed managed native process on the next detection', async () => {
  const f = await fixture();
  const first = await f.prepare();
  await fetch(`${f.url}/crash`, { headers: f.headers(), signal: AbortSignal.timeout(2_000) });
  await expect.poll(async () => (await f.command('status')).running, { timeout: 4_000 }).toBe(false);
  const next = await f.prepare({ ...f.initialEnv });
  expect(next).toMatchObject({ running: true, ownership: 'managed' });
  expect(next.nativePid).not.toBe(first.nativePid);
  expect(await f.nativeRuns()).toHaveLength(2);
}, 15_000);

it('keeps an explicit stop across fresh detection and resumes only after an explicit start', async () => {
  const f = await fixture();
  const first = await f.prepare();
  expect(await f.command('stop')).toMatchObject({ running: false });
  const fresh = { ...f.initialEnv };
  await expect(f.prepare(fresh)).rejects.toMatchObject({ code: 'opencode_start_disabled' });
  expect(await f.command('status', fresh)).toMatchObject({ running: false, autoStart: false });
  expect(await f.nativeRuns()).toHaveLength(1);
  const resumed = await f.command('start', fresh);
  expect(resumed).toMatchObject({ running: true, ownership: 'managed', autoStart: true });
  expect(resumed.nativePid).not.toBe(first.nativePid);
  expect(await f.nativeRuns()).toHaveLength(2);
}, 15_000);

it.each([401, 404])('does not spawn or claim an occupied endpoint returning HTTP %s', async status => {
  const server = createServer((_request, response) => response.writeHead(status).end('external service'));
  const url = await listen(server);
  cleanup.push(() => close(server));
  const f = await fixture({ AGENT_HOST_OPENCODE_URL: url });
  await expect(f.prepare()).rejects.toThrow();
  expect((await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2_000) })).status).toBe(status);
  expect(await f.nativeRuns()).toHaveLength(0);
}, 15_000);

it('can recover external authentication after an initial unauthorized detection', async () => {
  const expected = `Basic ${Buffer.from('opencode:existing-password').toString('base64')}`;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expected) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '2.0.25', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
  });
  const url = await listen(server);
  cleanup.push(() => close(server));
  const f = await fixture({ AGENT_HOST_OPENCODE_URL: url });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'opencode_auth_required' });
  const repaired = { ...f.initialEnv, AGENT_HOST_OPENCODE_USERNAME: 'opencode', AGENT_HOST_OPENCODE_PASSWORD: 'existing-password' };
  expect(await f.prepare(repaired)).toMatchObject({ running: true, ownership: 'external' });
  expect(await f.nativeRuns()).toHaveLength(0);
}, 15_000);

it.each([
  ['an empty username', { AGENT_HOST_OPENCODE_USERNAME: '' }],
  ['a custom username', { AGENT_HOST_OPENCODE_USERNAME: 'custom-user' }],
  ['a colon in the username', { AGENT_HOST_OPENCODE_USERNAME: 'invalid:user' }],
  ['an empty password', { AGENT_HOST_OPENCODE_PASSWORD: '' }],
  ['a newline in the password', { AGENT_HOST_OPENCODE_PASSWORD: 'invalid\npassword' }],
] as const)('rejects %s without persisting unusable credentials and permits correction', async (_label, invalid) => {
  const f = await fixture(invalid);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'opencode_state_invalid' });
  expect((await readdir(f.directory, { recursive: true })).filter(path => path.endsWith('config.json'))).toEqual([]);
  expect(await f.nativeRuns()).toHaveLength(0);
  Object.assign(f.env, { AGENT_HOST_OPENCODE_USERNAME: 'opencode', AGENT_HOST_OPENCODE_PASSWORD: 'corrected-password' });
  expect(await f.prepare()).toMatchObject({ running: true, ownership: 'managed' });
  expect((await fetch(`${f.url}/api/info`, { headers: f.headers(), signal: AbortSignal.timeout(2_000) })).status).toBe(200);
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it('cancels an in-flight native startup when stop is requested and does not resurrect it', async () => {
  const f = await fixture({ TEST_OPENCODE_DELAY: '2000' });
  const starting = f.prepare().then(status => ({ status }), error => ({ error }));
  await expect.poll(async () => (await f.nativeRuns()).length, { timeout: 4_000 }).toBe(1);
  const nativePid = (await f.nativeRuns())[0]!.pid;
  expect(await f.command('stop')).toMatchObject({ running: false });
  const outcome = await starting;
  expect('status' in outcome && outcome.status.running).toBe(false);
  await expect.poll(() => {
    try { process.kill(nativePid, 0); return true; } catch { return false; }
  }, { timeout: 4_000 }).toBe(false);
  await expect(f.prepare({ ...f.initialEnv })).rejects.toMatchObject({ code: 'opencode_start_disabled' });
  expect(await f.command('status')).toMatchObject({ running: false, autoStart: false });
  await expect(fetch(`${f.url}/api/info`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  expect(await f.nativeRuns()).toHaveLength(1);
}, 15_000);

it('waits for an in-flight stop before a different Controller reports a replacement as started', async () => {
  const f = await fixture({ TEST_OPENCODE_STOP_DELAY: '1000' });
  const original = await f.prepare();
  const stopping = f.command('stop').then(status => ({ status }), error => ({ error }));
  await expect.poll(async () => {
    try { return (await readFile(f.stoppingReport, 'utf8')).includes(String(original.nativePid)); } catch { return false; }
  }, { timeout: 3_000 }).toBe(true);
  const [stopped, replacement] = await Promise.all([stopping, f.startInSeparateProcess()]);
  expect(replacement).toMatchObject({ running: true, ownership: 'managed' });
  expect(replacement.nativePid).not.toBe(original.nativePid);
  expect(await f.command('status')).toMatchObject({ running: true, ownership: 'managed', nativePid: replacement.nativePid });
  if ('error' in stopped) expect(['opencode_start_cancelled', 'opencode_lifecycle_superseded']).toContain(stopped.error.code);
  else expect(stopped.status).toMatchObject({ running: false });
  expect(await f.nativeRuns()).toHaveLength(2);
}, 15_000);
