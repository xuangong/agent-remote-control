import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { CodexAppServerProvider, readWindowsCodexDaemon, requestWindowsCodexDaemon, windowsCodexSharedEndpoint } from '@orchardworks/agent-provider-codex';
import { CodexAppServerTransport } from '../../codex-daemon-client/src/app-server-transport.js';

const exec = promisify(execFile);
const wsPath = createRequire(import.meta.url).resolve('ws');

async function exercise(native?: string) {
  const home = await mkdtemp(join(tmpdir(), 'arc shared codex '));
  const fake = join(home, 'codex.cjs');
  const capture = join(home, 'proxy.json');
  await writeFile(fake, `
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(); }
if (args[0] !== 'app-server') {
  require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args, hasToken:!!process.env.CODEX_REMOTE_AUTH_TOKEN})); process.exit();
}
const {WebSocketServer} = require(${JSON.stringify(wsPath)});
const url = new URL(args[args.indexOf('--listen')+1]);
const token = require('node:fs').readFileSync(args[args.indexOf('--ws-token-file')+1], 'utf8');
let thread;
const server = new WebSocketServer({host:url.hostname,port:Number(url.port),verifyClient:info=>info.req.headers.authorization==='Bearer '+token});
server.on('connection', socket=>socket.on('message', raw=>{
  const message=JSON.parse(String(raw)); if(message.id===undefined)return;
  let result={};
  if(message.method==='initialize') result={userAgent:'fake-codex/0.153.4'};
  if(message.method==='thread/start') result={thread:thread={id:'shared-test-thread',cwd:${JSON.stringify(home)},turns:[]}};
  if(message.method==='thread/read') result={thread};
  if(message.method==='thread/list') result={data:[],nextCursor:null};
  socket.send(JSON.stringify({id:message.id,result}));
}));
`);
  const env = { ...process.env, CODEX_HOME: home, AGENT_REMOTE_CODEX_HOME: home, AGENT_HOST_STATE_DIR: join(home, 'host'),
    OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_GATEWAY_API_KEY: undefined,
    AGENT_HOST_CODEX: native ?? fake, AGENT_HOST_CODEX_CONNECTION: 'shared', AGENT_HOST_CODEX_TRUST_SHARED: '1',
    AGENT_HOST_CODEX_SOCKET: undefined, AGENT_HOST_CODEX_NOFILE: undefined };
  const run = (args: string[]) => exec(process.execPath, [resolve('dist/cli.js'), 'codex', ...args], { env, timeout: 35000, windowsHide: true });
  let first: CodexAppServerTransport | undefined; let second: CodexAppServerTransport | undefined;
  try {
    expect((await run(['daemon', 'start'])).stdout).toContain('started');
    const state = (await readWindowsCodexDaemon(home))!;
    expect((await run(['daemon', 'start'])).stdout).toContain('already running');
    expect(JSON.parse((await run(['daemon', 'status'])).stdout)).toMatchObject({ running: true, pid: state.pid });
    await expect(requestWindowsCodexDaemon({ ...state, token: 'wrong' }, 'stop')).rejects.toThrow('Unauthorized');
    await expect(CodexAppServerTransport.connectSharedWebSocket(state.url, 'wrong')).rejects.toThrow('Could not connect');
    const endpoint = await windowsCodexSharedEndpoint(home);
    first = await CodexAppServerTransport.connectSharedWebSocket(endpoint.url, endpoint.token);
    second = await CodexAppServerTransport.connectSharedWebSocket(endpoint.url, endpoint.token);
    const init = { clientInfo: { name: 'arc-shared-test', version: '0.1.0' }, capabilities: { experimentalApi: true } };
    await first.request('initialize', init); first.notify('initialized');
    await second.request('initialize', init); second.notify('initialized');
    const created = await first.request('thread/start', { cwd: home, model: 'gpt-5.4', approvalPolicy: 'never', sandbox: 'read-only' }) as { thread: { id: string } };
    const observed = await second.request('thread/read', { threadId: created.thread.id, includeTurns: false }) as { thread: { id: string } };
    expect(observed.thread.id).toBe(created.thread.id);
    await first.dispose(); first = undefined;
    expect((await second.request('thread/read', { threadId: created.thread.id, includeTurns: false }) as { thread: { id: string } }).thread.id).toBe(created.thread.id);
    const provider = new CodexAppServerProvider({ connectionMode: 'shared', env: { CODEX_HOME: home }, requestTimeoutMs: 5000 });
    await provider.listSessions();
    expect((await requestWindowsCodexDaemon(state, 'status')).pid).toBe(state.pid);
    if (!native) {
      await run(['resume', 'shared-test-thread']);
      const proxy = JSON.parse(await readFile(capture, 'utf8'));
      expect(proxy).toEqual({ args: ['--remote', state.url, '--remote-auth-token-env', 'CODEX_REMOTE_AUTH_TOKEN', 'resume', 'shared-test-thread'], hasToken: true });
    }
    await second.dispose(); second = undefined;
    expect((await run(['daemon', 'restart'])).stdout).toContain('started');
    const restarted = (await readWindowsCodexDaemon(home))!;
    expect(restarted.pid).not.toBe(state.pid); expect(restarted.token).not.toBe(state.token);
    const recovering = new CodexAppServerProvider({ connectionMode: 'shared', env: { CODEX_HOME: home }, requestTimeoutMs: 5000 });
    await recovering.listSessions();
    if (!native) {
      process.kill(restarted.pid, 'SIGKILL');
      await expect.poll(() => { try { process.kill(restarted.nativePid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
      await expect.poll(() => { try { process.kill(restarted.pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
      await run(['daemon', 'start']);
    }
    await run(['daemon', 'stop']);
    expect(await readWindowsCodexDaemon(home)).toBeUndefined();
    expect(() => process.kill(restarted.nativePid, 0)).toThrow();
  } finally {
    await first?.dispose(); await second?.dispose();
    try { await run(['daemon', 'stop']); } catch {}
    const saved = await readWindowsCodexDaemon(home);
    if (saved) for (const pid of [saved.nativePid, saved.pid]) { try { process.kill(pid); } catch {} }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

it.runIf(process.platform === 'win32')('shares an authenticated daemon across independent clients and survives Host disposal and restart', () => exercise(), 60000);
it.runIf(process.platform === 'win32' && !!process.env.AGENT_REMOTE_WINDOWS_CODEX_TEST_EXECUTABLE)(
  'shares a real native Codex thread without model requests or user credentials', () => exercise(process.env.AGENT_REMOTE_WINDOWS_CODEX_TEST_EXECUTABLE), 60000);
