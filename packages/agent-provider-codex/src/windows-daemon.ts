import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodexAppServerTransport } from './app-server-transport.js';

export interface WindowsCodexDaemonState { pid: number; nativePid: number; token: string; pipe: string; url: string; version: string }
export const windowsCodexDaemonDirectory = (home: string) => join(resolve(home), 'agent-remote-daemon');

export async function readWindowsCodexDaemon(home: string): Promise<WindowsCodexDaemonState | undefined> {
  try { return JSON.parse(await readFile(join(windowsCodexDaemonDirectory(home), 'daemon.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function requestWindowsCodexDaemon(state: WindowsCodexDaemonState, action: 'status' | 'stop'): Promise<Record<string, unknown>> {
  return new Promise((done, reject) => {
    const socket = createConnection(state.pipe); let output = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Shared Codex daemon management timed out.')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ token: state.token, action }) + '\n'));
    socket.on('data', chunk => { output += chunk; });
    socket.on('close', () => {
      try { const value = JSON.parse(output); if (value.error) reject(new Error(value.error)); else done(value); }
      catch (error) { reject(error); }
    });
  });
}

export async function windowsCodexSharedEndpoint(home: string): Promise<{ url: string; token: string }> {
  const state = await readWindowsCodexDaemon(home);
  if (!state) throw new Error('Shared Codex daemon is not running. Run agent-remote-controller codex daemon start with the matching CODEX_HOME.');
  const status = await requestWindowsCodexDaemon(state, 'status');
  if (status.pid !== state.pid || status.url !== state.url) throw new Error('Shared Codex daemon identity changed. Retry the connection.');
  return { url: state.url, token: state.token };
}

/** Owns one independent native app-server; Host connections never own this lifecycle. */
export async function serveWindowsCodexDaemon(executable: string, home: string,
  spawnNative: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams
    = (command, args, options) => spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })): Promise<void> {
  const directory = windowsCodexDaemonDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const pipe = `\\\\.\\pipe\\arc-codex-${createHash('sha256').update(resolve(home).toLowerCase()).digest('hex').slice(0, 24)}`;
  let state: WindowsCodexDaemonState | undefined;
  let finish!: () => void;
  const stopped = new Promise<void>(done => { finish = done; });
  let stopping = false;
  const management = createServer(socket => {
    let input = ''; let handled = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 8192) { socket.destroy(); return; }
      if (handled || !input.includes('\n')) return;
      handled = true;
      try {
        const request = JSON.parse(input);
        if (request.token !== token) throw new Error('Unauthorized shared Codex management request.');
        if (request.action === 'status' && state) {
          const { token: _token, ...publicState } = state; socket.end(JSON.stringify({ running: true, ...publicState }));
        } else if (request.action === 'stop') socket.end(JSON.stringify({ stopping: true }), finish);
        else throw new Error('Shared Codex daemon is not ready or the action is invalid.');
      } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid request.' })); }
    });
  });
  await new Promise<void>((done, reject) => { management.once('error', reject); management.listen(pipe, done); });
  const tokenFile = join(directory, 'token');
  let transport: CodexAppServerTransport | undefined;
  const onSignal = () => finish();
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    await writeFile(tokenFile, token, { mode: 0o600 });
    const portServer = createServer();
    await new Promise<void>((done, reject) => { portServer.once('error', reject); portServer.listen(0, '127.0.0.1', done); });
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>(done => portServer.close(() => done()));
    const url = `ws://127.0.0.1:${port}`;
    const nodeEntry = /\.[cm]?js$/i.test(executable);
    const command = nodeEntry ? process.execPath : executable;
    const prefix = nodeEntry ? [executable] : [];
    const environment = { ...process.env, CODEX_HOME: resolve(home) };
    const { stdout } = await promisify(execFile)(command, [...prefix, '--version'], { env: environment, timeout: 5000, windowsHide: true });
    const child = spawnNative(command, [...prefix, 'app-server', '--listen', url, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile], {
      env: environment, cwd: home,
    });
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.once('exit', () => { if (!stopping) finish(); });
    transport = new CodexAppServerTransport(child);
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        const probe = await CodexAppServerTransport.connectSharedWebSocket(url, token, { requestTimeoutMs: 1000 });
        try {
          await probe.request('initialize', { clientInfo: { name: 'agent-remote-daemon', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        } finally { await probe.dispose(); }
        break;
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw error;
        await new Promise(done => setTimeout(done, 100));
      }
    }
    state = { pid: process.pid, nativePid: child.pid!, token, pipe, url, version: stdout.trim() };
    const temporary = join(directory, `.daemon-${process.pid}.json`);
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, join(directory, 'daemon.json'));
    await stopped;
  } finally {
    stopping = true;
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
    try { await transport?.dispose(); }
    finally {
      management.close();
      if ((await readWindowsCodexDaemon(home))?.pid === process.pid) await rm(join(directory, 'daemon.json'), { force: true });
      await rm(tokenFile, { force: true });
    }
  }
}
