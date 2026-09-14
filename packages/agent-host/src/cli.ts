#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentHost, type AgentHost } from './host.js';
import { createHostRegistrations } from './registrations.js';
import { resolveHostConnection, saveRegisteredConnection, type HostConnection } from './connection-config.js';

interface DaemonState { pid: number; token: string; socket: string; startedAt: string }
const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const stateDir = process.env.AGENT_HOST_STATE_DIR ?? join(homedir(), '.agent-remote-control', 'agent-host');
const stateFile = join(stateDir, 'daemon.json');
const installationFile = join(stateDir, 'installation-id');
const daemonLogFile = join(stateDir, 'agent-host.log');

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (command === 'help' || command === '--help' || command === '-h') help();
  else if (command === 'foreground') await serve(false);
  else if (command === '_serve') await serve(true);
  else if (command === 'start') await start();
  else if (command === 'status') await status();
  else if (command === 'stop') await manage({ action: 'stop' });
  else if (command === 'pair') await pair();
  else throw new Error(`Unknown command: ${command}. Run agent-remote-controller --help.`);
}

function help(): void {
  process.stdout.write(`Usage: agent-remote-controller <command> [options]\n\nCommands:\n  foreground  Run in the foreground\n  start       Start the background daemon\n  status      Report process and uplink state\n  pair        Replace the uplink key/URL without restarting sessions\n  stop        Stop the background daemon\n\nOptions are supplied through AGENT_HOST_SERVER, AGENT_HOST_REMOTE_KEY, AGENT_HOST_PROVIDERS,\nAGENT_HOST_CODEX, AGENT_HOST_CLAUDE, AGENT_HOST_CLAUDE_HOME, AGENT_HOST_COPILOT, AGENT_HOST_COPILOT_HOME,\nAGENT_HOST_WORKSPACE, AGENT_HOST_NAME, and AGENT_HOST_STATE_DIR. AGENT_REMOTE_CODEX_EXECUTABLE,\nAGENT_REMOTE_CODEX_HOME, and AGENT_REMOTE_WORKSPACE remain supported. Keys are never accepted\non the command line. Providers default to codex; select a comma-separated list of codex, claude, copilot explicitly.\nAccepted connection settings are saved privately for later starts without environment settings.\nSet AGENT_HOST_SERVER to your Relay URL (for example https://agents.xianliao.de5.net).\nThe first pairing requires that URL and AGENT_HOST_REMOTE_KEY; no Relay is selected by default.\nSet server and key together to replace a connection. A rejected key requires pairing again, then running pair.\n`);
}

async function serve(daemon: boolean): Promise<void> {
  const configuration = await resolveHostConnection(stateDir, process.env);
  const { serverUrl, remoteKey, environment } = configuration;
  await privateDirectory();
  const installationId = await installation();
  const diagnosticSecrets = new Set([remoteKey, process.env.AGENT_HOST_MANAGEMENT_TOKEN ?? '']);
  const registrations = await createHostRegistrations(environment,
    (line) => process.stderr.write(daemonDiagnosticLine(line, diagnosticSecrets)));
  const host = createAgentHost({ registrations, installationId, name: environment.AGENT_HOST_NAME?.trim() || hostname(),
    uplink: { url: uplinkUrl(serverUrl), remoteKey }, shutdownTimeoutMs: shutdownTimeout() });
  if (!daemon) {
    process.stdout.write('Agent Host is running in the foreground.\n');
    await saveRegisteredConnection(stateDir, configuration, host.ready);
    process.stdout.write('Agent Host uplink is registered.\n');
    await waitForSignal(host);
    return;
  }
  void saveRegisteredConnection(stateDir, configuration, host.ready).catch(error => {
    process.stderr.write(daemonDiagnosticLine(error instanceof Error ? error.message : 'Could not save registered Host connection.', diagnosticSecrets));
  });
  const token = process.env.AGENT_HOST_MANAGEMENT_TOKEN;
  if (!token) throw new Error('Daemon management token is missing.');
  const scope = createHash('sha256').update(stateDir).digest('hex').slice(0, 16);
  const socket = join(tmpdir(), `agent-host-${scope}-${process.pid}.sock`);
  await rm(socket, { force: true });
  const management = createServer({ allowHalfOpen: true }, (connection) => {
    let input = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => { input += chunk; if (input.length > 64 * 1024) connection.destroy(); });
    connection.on('end', () => void handleManagement(input, token, host, configuration, diagnosticSecrets, connection));
  });
  await new Promise<void>((resolve, reject) => { management.once('error', reject); management.listen(socket, resolve); });
  await chmod(socket, 0o600);
  await atomicJson(stateFile, { pid: process.pid, token, socket, startedAt: new Date().toISOString() });
  const shutdown = async () => {
    management.close();
    try { await within(host.close(), shutdownTimeout()); } finally { await rm(socket, { force: true }); await rm(stateFile, { force: true }); }
  };
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit()));
  process.once('SIGINT', () => void shutdown().finally(() => process.exit()));
  await new Promise<void>(() => undefined);
}

async function handleManagement(input: string, token: string, host: AgentHost, configuration: HostConnection, diagnosticSecrets: Set<string>, connection: import('node:net').Socket): Promise<void> {
  try {
    const request = JSON.parse(input) as { token?: string; action?: string; server?: string; key?: string };
    if (request.token !== token) throw new Error('Unauthorized local management request.');
    if (request.action === 'status') connection.end(JSON.stringify({ running: true, uplink: host.state }));
    else if (request.action === 'pair') {
      if (!request.server || !request.key) throw new Error('Repair requires a server and key.');
      diagnosticSecrets.add(request.key);
      const registered = await saveRegisteredConnection(stateDir, { ...configuration, serverUrl: request.server, remoteKey: request.key },
        host.replaceUplink({ url: uplinkUrl(request.server), remoteKey: request.key }));
      connection.end(JSON.stringify({ running: true, uplink: host.state, hostId: registered.hostId }));
    } else if (request.action === 'stop') { connection.end(JSON.stringify({ stopping: true })); process.kill(process.pid, 'SIGTERM'); }
    else throw new Error('Unknown local management action.');
  } catch (error) { connection.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
}

async function start(): Promise<void> {
  await resolveHostConnection(stateDir, process.env);
  await privateDirectory();
  const lock = join(stateDir, 'startup.lock');
  await acquireStartupLock(lock);
  try {
    const existing = await readState();
    if (existing && await authenticateSavedDaemon(existing)) throw new Error(`Agent Host daemon is already running (pid ${existing.pid}).`);
    if (existing) await rm(stateFile, { force: true });
    const token = randomBytes(32).toString('hex');
    const log = await open(daemonLogFile, 'a', 0o600);
    await log.chmod(0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_serve'], { detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, AGENT_HOST_MANAGEMENT_TOKEN: token } });
    await log.close();
    child.unref();
    // Allow all selected native version probes to finish, including a cold Copilot launch.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const state = await readState();
      if (state && state.pid === child.pid) { process.stdout.write(`Agent Host daemon started (pid ${state.pid}); log: ${daemonLogFile}.\n`); return; }
      if (!processAlive(child.pid!)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Agent Host daemon did not become ready. Run foreground with the same environment for startup diagnostics.');
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function status(): Promise<void> {
  const state = await readState();
  if (!state || !processAlive(state.pid)) { process.stdout.write('Agent Host daemon is not running.\n'); process.exitCode = 3; return; }
  const response = await request(state, { action: 'status' });
  process.stdout.write(`Agent Host daemon is running (pid ${state.pid}); uplink: ${String(response.uplink)}.\n`);
}
async function pair(): Promise<void> {
  const server = requiredEnv('AGENT_HOST_SERVER'); const key = requiredEnv('AGENT_HOST_REMOTE_KEY');
  const state = await requiredState();
  const response = await request(state, { action: 'pair', server, key });
  process.stdout.write(`Agent Host uplink registered as ${String(response.hostId)} without restarting sessions.\n`);
}
async function manage(payload: Record<string, unknown>): Promise<void> {
  const state = await requiredState(); await request(state, payload); process.stdout.write('Agent Host daemon is stopping.\n');
}
async function request(state: DaemonState, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(state.socket); let output = '';
    connection.setTimeout(5000, () => connection.destroy(new Error('Local management request timed out.')));
    connection.on('connect', () => connection.end(JSON.stringify({ ...payload, token: state.token })));
    connection.setEncoding('utf8'); connection.on('data', (chunk) => { output += chunk; });
    connection.on('error', reject); connection.on('close', () => {
      try { const response = JSON.parse(output) as Record<string, unknown>; if (response.error) reject(new Error(String(response.error))); else resolve(response); }
      catch { reject(new Error('Agent Host daemon returned an invalid management response.')); }
    });
  });
}
async function requiredState(): Promise<DaemonState> { const state = await readState(); if (!state || !processAlive(state.pid)) throw new Error('Agent Host daemon is not running.'); return state; }
async function readState(): Promise<DaemonState | undefined> { try { return JSON.parse(await readFile(stateFile, 'utf8')) as DaemonState; } catch { return undefined; } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export async function authenticateSavedDaemon(state: DaemonState, call: typeof request = request): Promise<boolean> {
  if (!processAlive(state.pid)) return false;
  try { await call(state, { action: 'status' }); return true; } catch { return false; }
}
export async function acquireStartupLock(lock: string): Promise<void> {
  try { await mkdir(lock); }
  catch {
    throw new Error(`Another Agent Host start owns ${lock}. If no start command is running, remove this private stale lock and retry.`);
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
}
async function privateDirectory(): Promise<void> { await mkdir(stateDir, { recursive: true, mode: 0o700 }); await chmod(stateDir, 0o700); }
async function installation(): Promise<string> { try { return (await readFile(installationFile, 'utf8')).trim(); } catch { const id = randomUUID(); await writeFile(installationFile, `${id}\n`, { mode: 0o600 }); return id; } }
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = join(dirname(path), `.daemon-${process.pid}.tmp`); await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path); }
function requiredEnv(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }
function uplinkUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Agent Host server URL is invalid.'); url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'; url.pathname = '/ws/remote-host'; url.search = ''; url.hash = ''; return url.href; }
async function waitForSignal(host: AgentHost): Promise<void> { await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); }); await host.close(); }
function shutdownTimeout(): number { const value = Number(process.env.AGENT_HOST_SHUTDOWN_TIMEOUT_MS ?? 5000); return Number.isSafeInteger(value) && value > 0 ? value : 5000; }
export async function within(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
export function daemonDiagnosticLine(line: string, secrets: Iterable<string>): string {
  let sanitized = line.replace(/[\r\n]+/g, ' ');
  for (const secret of secrets) if (secret) sanitized = sanitized.split(secret).join('[redacted]');
  return `${sanitized}\n`;
}
