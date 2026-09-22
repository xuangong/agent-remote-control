import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { vscodeTunnelLink, type VscodeTunnelSnapshot } from '@orchardworks/agent-remote-protocol';
import type { RemoteHostControlRequest } from '@orchardworks/agent-remote-relay';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { vscodeTunnelSupervisorSource } from './vscode-tunnel-supervisor.js';
import { parseTunnelOutput, tunnelOutputLines } from './vscode-tunnel-output.js';
import { resolveVscodeExecutable } from './platform/executables/index.js';

export interface VscodeTunnelOptions {
  stateDirectory: string;
  installationId: string;
  executable?: string;
  executableArgs?: string[];
  statusIntervalMs?: number;
  stopTimeoutMs?: number;
  disconnectTimeoutMs?: number;
}

export function createVscodeTunnelManager(options: VscodeTunnelOptions) {
  const home = resolve(options.stateDirectory);
  const dataDirectory = join(home, 'vscode-tunnel');
  const name = `arc-${createHash('sha256').update(options.installationId).digest('hex').slice(0, 12)}`;
  let state: VscodeTunnelSnapshot = { status: 'checking', processAlive: false, revision: 0 };
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  const disconnectTimeoutMs = options.disconnectTimeoutMs ?? 5 * 60_000;
  if (!Number.isFinite(disconnectTimeoutMs) || disconnectTimeoutMs <= 0) throw new Error('VS Code disconnect timeout must be positive.');
  let connectedToRelay = true;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  let probeChild: ChildProcess | undefined;
  let capabilityChild: ChildProcess | undefined;
  let capabilityCheck: Promise<void> | undefined;
  const owned = new Map<ChildProcess, Promise<void>>();
  let checkedAt = 0;
  const executable = options.executable ?? 'code';
  let stopping = false;
  let closed = false;
  let operations: Promise<unknown> = Promise.resolve();
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = operations.then(run); operations = result.catch(() => undefined); return result;
  }
  function update(next: Omit<VscodeTunnelSnapshot, 'revision'>) { state = { ...next, revision: state.revision + 1 }; }
  const snapshot = (): VscodeTunnelSnapshot => structuredClone(state);
  function environment() {
    const env = sanitizeNativeEnvironment(process.env);
    for (const key of ['VSCODE_CLI_ACCESS_TOKEN', 'VSCODE_CLI_REFRESH_TOKEN', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_CLI_DATA_DIR']) delete env[key];
    return { ...env, VSCODE_CLI_MACHINE_STATUS: '1' };
  }
  function spawnOwned(args: string[], timeoutMs?: number) {
    const child = spawn(process.execPath, ['-e', vscodeTunnelSupervisorSource, JSON.stringify({
      executable: resolveVscodeExecutable(executable), args: [...(options.executableArgs ?? []), ...args], cwd: home,
      stopTimeoutMs: options.stopTimeoutMs ?? 2000, timeoutMs,
    })], { cwd: home, env: environment(), stdio: ['pipe', 'pipe', 'pipe', 'ipc'], detached: true, windowsHide: true });
    owned.set(child, new Promise<void>(done => child.once('close', () => { owned.delete(child); done(); })));
    return child;
  }
  function terminate(target: ChildProcess, signal: NodeJS.Signals) {
    if (!target.pid) return;
    try {
      if (process.platform === 'win32') target.kill(signal);
      else process.kill(-target.pid, signal);
    } catch { try { target.kill(signal); } catch { /* Process already exited. */ } }
  }
  function clearTimers() {
    clearInterval(timer); timer = undefined; clearTimeout(authTimer); authTimer = undefined;
    if (probeChild) probeChild.stdin?.end(); probeChild = undefined;
  }
  function connected(tunnelName: string, attached = state.attached) {
    const link = vscodeTunnelLink(tunnelName);
    if (!link || !child || stopping) return;
    if (attached) {
      const owner = child;
      void serialize(async () => {
        if (child !== owner) return;
        await stopProcess();
        update({ status: 'failed', processAlive: false, message: 'Another tunnel owns the Controller CLI directory. This Controller will not attach to an unmanaged process.' });
      });
      return;
    }
    clearTimeout(authTimer); authTimer = undefined;
    update({ status: 'connected', processAlive: true, pid: child.pid, tunnelName, link, attached });
  }
  function output(owner: ChildProcess, line: string) {
    if (child !== owner || stopping) return;
    const event = parseTunnelOutput(line);
    if (event?.type === 'authorization') {
      update({ status: 'awaiting_auth', processAlive: true, pid: child.pid, authorization: { url: event.url, code: event.code } });
      clearTimeout(authTimer);
      authTimer = setTimeout(() => { void serialize(async () => {
        if (child !== owner || state.status !== 'awaiting_auth') return;
        await stopProcess();
        update({ status: 'failed', processAlive: false, message: 'Authorization timed out. Start the tunnel to try again.' });
      }); }, 15 * 60_000);
      authTimer.unref?.();
    } else if (event?.type === 'connected') connected(event.name, event.attached);
    else if (event?.type === 'tokenError') update({ status: 'connecting', processAlive: true, pid: child.pid, message: 'VS Code authentication needs attention. Stop and start the tunnel to sign in again.' });
  }
  function probe(owner: ChildProcess) {
    if (child !== owner || stopping || probeChild || state.status === 'awaiting_auth') return;
    const query = spawnOwned(['tunnel', 'status', '--cli-data-dir', dataDirectory], 3000);
    probeChild = query;
    let body = ''; let excessive = false;
    query.stdout!.setEncoding('utf8'); query.stderr!.resume();
    query.stdout!.on('data', (chunk: string) => {
      if (body.length + chunk.length > 16_384) { excessive = true; query.stdin?.end(); }
      else body += chunk;
    });
    const deadline = setTimeout(() => query.stdin?.end(), 3000); deadline.unref?.();
    query.once('error', () => undefined);
    query.once('close', code => {
      clearTimeout(deadline); if (probeChild === query) probeChild = undefined;
      if (child !== owner || stopping || state.status === 'awaiting_auth') return;
      let tunnel: { name?: string; tunnel?: string } | undefined;
      try { if (code === 0 && !excessive) tunnel = JSON.parse(body).tunnel; } catch { /* Unknown CLI status cannot prove connectivity. */ }
      if (tunnel?.tunnel === 'Connected' && tunnel.name) connected(tunnel.name);
      else update({ status: 'connecting', processAlive: true, pid: owner.pid, attached: state.attached,
        message: code === 0 ? 'Waiting for the VS Code tunnel connection.' : 'Could not verify the VS Code tunnel connection.' });
    });
  }

  async function inspectCapability() {
    checkedAt = Date.now();
    try {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      if (closed) return;
      const query = spawnOwned(['tunnel', '--help'], 3000);
      capabilityChild = query;
      let help = ''; let spawnFailed = false;
      for (const stream of [query.stdout!, query.stderr!]) {
        stream.setEncoding('utf8'); stream.on('data', (chunk: string) => {
          if (help.length + chunk.length <= 65_536) help += chunk;
          else query.stdin?.end();
        });
      }
      query.on('message', value => { if ((value as { type?: string }).type === 'spawnError') spawnFailed = true; });
      query.on('error', () => { spawnFailed = true; });
      const code = await new Promise<number | null>(resolve => query.once('close', resolve));
      if (capabilityChild === query) capabilityChild = undefined;
      if (closed) return;
      const supported = code === 0 && /Usage:[^\n]*\btunnel\b/i.test(help) && help.includes('--accept-server-license-terms') && help.includes('--cli-data-dir');
      update(supported ? { status: 'stopped', processAlive: false } : { status: 'unavailable', processAlive: false,
        message: spawnFailed ? 'VS Code CLI was not found or could not be executed. Install it or configure AGENT_HOST_VSCODE.'
          : 'This CLI does not provide a supported code tunnel command. Install a VS Code CLI with Remote Tunnels support.' });
    } catch (error) {
      if (!closed) update({ status: 'unavailable', processAlive: false, message: error instanceof Error && error.message.includes('not found')
        ? error.message : 'Could not check VS Code tunnel support. Verify the CLI and Controller directory permissions.' });
    }
  }
  function ensureCapability() {
    if (!capabilityCheck || (state.status === 'unavailable' && Date.now() - checkedAt >= 60_000)) capabilityCheck = inspectCapability();
    return capabilityCheck;
  }

  async function startProcess(acceptLicense: boolean) {
    if (closed) throw new Error('VS Code tunnel manager is closed.');
    if (child) return snapshot();
    if (!connectedToRelay) throw new Error('Reconnect the Controller to the Relay before starting a tunnel.');
    if (!acceptLicense) throw new Error('Accept the VS Code Server license terms before starting.');
    await ensureCapability();
    if (closed) throw new Error('VS Code tunnel manager is closed.');
    if (state.status === 'unavailable') return snapshot();
    if (!connectedToRelay) throw new Error('Reconnect the Controller to the Relay before starting a tunnel.');
    stopping = false;
    update({ status: 'starting', processAlive: false });
    const spawned = spawnOwned(['tunnel', '--cli-data-dir', dataDirectory,
      '--name', name, '--parent-process-id', '__ARC_PARENT_PID__', '--accept-server-license-terms']);
    child = spawned;
    for (const stream of [spawned.stdout!, spawned.stderr!]) {
      stream.setEncoding('utf8'); stream.on('data', tunnelOutputLines(line => output(spawned, line)));
    }
    let failure = false;
    let nativePid: number | undefined;
    let exitResult: { code: number | null; signal?: string } | undefined;
    spawned.on('message', message => {
      const value = message as { type: string; code?: number | null; signal?: string; pid?: number };
      if (value.type === 'spawn') nativePid = value.pid;
      if (value.type === 'spawnError') failure = true;
      if (value.type === 'exit') exitResult = { code: value.code ?? null, signal: value.signal ?? undefined };
    });
    exited = new Promise<void>(done => {
      const finish = (code: number | null, signal?: string) => {
        if (child === spawned) {
          if (nativePid) { try { process.kill(-nativePid, 'SIGKILL'); } catch { /* The owned process group is already gone. */ } }
          clearTimers(); child = undefined;
          update({ status: failure ? 'failed' : stopping ? 'stopped' : 'exited', processAlive: false,
            exitCode: code, ...(signal ? { signal } : {}), ...(failure ? { message: 'Could not start VS Code. Install its CLI or configure AGENT_HOST_VSCODE.' } : {}) });
        }
        done();
      };
      spawned.once('error', () => { failure = true; finish(null); });
      spawned.once('exit', (code, signal) => finish(exitResult?.code ?? code, exitResult?.signal ?? signal ?? undefined));
    });
    await new Promise<void>(resolve => { spawned.once('spawn', resolve); spawned.once('error', () => resolve()); });
    if (child === spawned) {
      update({ status: 'connecting', processAlive: true, pid: spawned.pid });
      timer = setInterval(() => probe(spawned), options.statusIntervalMs ?? 5000); timer.unref?.();
    }
    return snapshot();
  }

  async function stopProcess() {
    if (!child) return snapshot();
    const target = child; stopping = true; clearTimers();
    update({ status: 'stopping', processAlive: true, pid: target.pid, attached: state.attached });
    target.stdin?.end();
    const deadline = setTimeout(() => terminate(target, 'SIGKILL'), (options.stopTimeoutMs ?? 2000) + 3000);
    try { await exited; } finally { clearTimeout(deadline); }
    return snapshot();
  }
  const start = (acceptLicense: boolean) => serialize(() => startProcess(acceptLicense));
  const stop = () => serialize(stopProcess);
  function setRelayConnected(online: boolean) {
    connectedToRelay = online;
    if (online) { clearTimeout(disconnectTimer); disconnectTimer = undefined; return; }
    if (disconnectTimer || closed) return;
    disconnectTimer = setTimeout(() => { void serialize(async () => {
      if (connectedToRelay || closed || !child) return;
      await stopProcess();
      update({ status: 'stopped', processAlive: false, message: 'Tunnel stopped because the Controller was disconnected from the Relay for too long. Start it again to reconnect.' });
    }); }, disconnectTimeoutMs);
    disconnectTimer.unref?.();
  }
  return {
    snapshot, start, stop, setRelayConnected,
    async control(request: RemoteHostControlRequest) {
      try {
        let result: VscodeTunnelSnapshot;
        if (request.path === '/remote/vscode-tunnel' && request.method === 'GET') { await ensureCapability(); result = snapshot(); }
        else if (request.path === '/remote/vscode-tunnel/start' && request.method === 'POST') result = await start(JSON.parse(request.body ?? '{}').acceptLicense === true);
        else if (request.path === '/remote/vscode-tunnel/stop' && request.method === 'POST') result = await stop();
        else return { status: 404, body: JSON.stringify({ error: 'Unknown VS Code tunnel operation.' }) };
        return { status: 200, body: JSON.stringify(result) };
      } catch (error) { return { status: 400, body: JSON.stringify({ error: error instanceof Error ? error.message : 'VS Code tunnel operation failed.' }) }; }
    },
    async close() {
      closed = true; clearTimeout(disconnectTimer); capabilityChild?.stdin?.end();
      await Promise.all([stop(), capabilityCheck]);
      for (const child of owned.keys()) child.stdin?.end();
      await Promise.all(owned.values());
    },
  };
}
