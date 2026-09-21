#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentHost, type AgentHost, type AgentHostUplinkDiagnostic } from './host.js';
import { detectHostEnvironment } from './environment.js';
import { createHostRegistrations } from './registrations.js';
import { createHostExecutionPolicy } from './execution-policy.js';
import { boundedDiagnosticLine, createDiagnosticLog, type DiagnosticLog } from './diagnostic-log.js';
import { resolveHostConnection, resolveHostEnvironment, saveIssuedCredential, saveRegisteredConnection, type HostConnection } from './connection-config.js';
import { runCodexCommand } from './codex-command.js';
import { createLaunchdAutostart } from './launchd.js';
import { autostartEnabled, clearAutostartConnection, prepareAutostartConnection, resolveAutostartConnection } from './autostart-state.js';
import { createSystemdAutostart, systemdUnavailable } from './systemd.js';
import { createWindowsAutostart } from './windows-autostart.js';
import { serveWindowsCodexDaemon } from '@orchardworks/agent-provider-codex';
import { spawnWindowsJob } from './windows-job.js';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { configureGatewayProviders } from './gateway-setup.js';
import { runShare } from './share-command.js';
import { selectTerminalChoice } from './terminal-select.js';
import { createInterface } from 'node:readline';
import { renderSessionQr } from './share-qr.js';

interface DaemonState { pid: number; token: string; socket: string; startedAt: string; supervisor?: 'launchd' | 'systemd' | 'windows' }
const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const stateDir = resolve(process.env.AGENT_HOST_STATE_DIR ?? join(homedir(), '.agent-remote-control', 'agent-host'));
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
  else if (command === 'codex') process.exitCode = await runCodexCommand(args.slice(1), stateDir, process.env);
  else if (command === 'environment') process.stdout.write(`${JSON.stringify(await detectHostEnvironment(), null, 2)}\n`);
  else if (command === 'foreground') await serve(false);
  else if (command === '_serve') await serve(true);
  else if (command === '_login') { if (await autostartEnabled(stateDir)) await start(); }
  else if (command === '_codex-daemon') {
    if (process.platform !== 'win32' || !args[1] || !args[2]) throw new Error('Invalid Windows Codex daemon invocation.');
    await serveWindowsCodexDaemon(args[1], args[2], spawnWindowsJob);
  }
  else if (command === 'start') await start();
  else if (command === 'status') await status();
  else if (command === 'stop') await stop();
  else if (command === 'autostart') await autostart(args[1] ?? 'status');
  else if (command === 'pair') await pair();
  else if (command === 'share') await share();
  else throw new Error(`Unknown command: ${command}. Run agent-remote-controller --help.`);
}

function help(): void {
  process.stdout.write(`Usage: agent-remote-controller <command> [options]\n\nCommands:\n  share       Choose a provider and enter a session ID to generate a QR code\n  share list-sessions  Browse recent sessions and generate a QR code\n  environment Print detected Host OS, shells, browsers and VS Code as JSON\n  codex [args...]  Run native Codex with the configured shared socket and LC_ALL=C\n  codex daemon start|restart|stop|status  Manage the matching shared Codex daemon\n  foreground  Run in the foreground\n  start       Start the daemon; Login startup defaults on with the platform login manager\n  status      Report process and uplink state\n  pair        Replace the uplink key/URL without restarting sessions\n  stop        Stop the daemon and release its resources; retain login startup\n  autostart enable   Enable login startup (crash recovery on macOS/Linux)\n  autostart disable  Disable login startup and stop the managed daemon\n  autostart status   Report login startup and supervisor state\n\nOptions are supplied through AGENT_HOST_SERVER, AGENT_HOST_REMOTE_KEY, AGENT_HOST_PROVIDERS,\nAGENT_HOST_CODEX, AGENT_HOST_CODEX_CONNECTION, AGENT_HOST_CODEX_SOCKET, AGENT_HOST_CODEX_TRUST_SHARED, AGENT_HOST_CLAUDE, AGENT_HOST_CLAUDE_HOME, AGENT_HOST_COPILOT, AGENT_HOST_COPILOT_HOME,\nAGENT_HOST_VSCODE (VS Code CLI executable), AGENT_HOST_VSCODE_DISCONNECT_TIMEOUT_MS (default 300000), AGENT_HOST_WORKSPACE, AGENT_HOST_ALLOWED_WORKSPACE_ROOTS (JSON paths), AGENT_HOST_NAME, and AGENT_HOST_STATE_DIR. AGENT_REMOTE_CODEX_EXECUTABLE,\nAGENT_REMOTE_CODEX_HOME, and AGENT_REMOTE_WORKSPACE remain supported. Keys are never accepted\non the command line. Providers default to codex; select a comma-separated list of codex, claude, copilot explicitly.\nAccepted connection settings are saved privately for later starts without environment settings.\nSet AGENT_HOST_SERVER to your Relay URL (for example https://agents.xianliao.de5.net).\nThe first pairing requires that URL and AGENT_HOST_REMOTE_KEY; no Relay is selected by default.\nThe workspace defaults to the launch directory; remote permission controls are locked.\nAGENT_HOST_TRUSTED_FULL_CONTROL=1 locally opts out of workspace and native sandbox defaults.\nAGENT_HOST_CODEX_CONNECTION=shared attaches to an existing local Codex daemon; private is the default.\nShared Codex requires AGENT_HOST_CODEX_TRUST_SHARED=1 and uses the daemon permissions.\nAGENT_HOST_CODEX_SOCKET optionally selects an absolute local socket path.\nAGENT_HOST_CODEX_NOFILE sets the Codex daemon soft file limit on start/restart (default 8192).\nA workspace check does not isolate the filesystem; Copilot has no enforced native sandbox.\nSet server and key together to replace a connection. A rejected key requires pairing again, then running pair.\nOn macOS/Linux/Windows, stop stops the managed job without disabling future login startup.\nWindows uses the current user Startup folder; shared Codex uses a managed authenticated local WebSocket.\nWindows managed VS Code tunnels require code-tunnel.exe and Windows PowerShell.\nLinux requires an accessible systemd user manager for autostart; otherwise start runs manually.\nFor Linux startup before login and after logout, ask the administrator to enable user lingering.\nContainers can run foreground under their own restart policy.\nAutostart disable persists; later start runs manually until autostart enable.\nAn already running manual daemon is left running when login startup is enabled.\n`);
}

async function serve(daemon: boolean): Promise<void> {
  await privateDirectory();
  const diagnosticLog = daemon ? createDiagnosticLog({ path: daemonLogFile }) : undefined;
  const diagnosticSecrets = new Set<string>();
  try {
    await serveConfigured(daemon, diagnosticLog, diagnosticSecrets);
  } catch (error) {
    diagnosticLog?.dispose();
    throw new Error(boundedDiagnosticLine(error instanceof Error ? error.message : String(error), diagnosticSecrets).trimEnd());
  }
}

async function serveConfigured(daemon: boolean, diagnosticLog: DiagnosticLog | undefined, diagnosticSecrets: Set<string>): Promise<void> {
  const writeDiagnostic = (line: string, secrets: Iterable<string> = []) => {
    if (diagnosticLog) diagnosticLog.write(line, secrets);
    else process.stderr.write(daemonDiagnosticLine(line, secrets));
  };
  const supervisor = daemon ? (process.env.AGENT_HOST_SUPERVISOR === 'windows' ? 'windows' : process.env.AGENT_HOST_SUPERVISOR === 'systemd' ? 'systemd'
    : process.env.AGENT_HOST_LAUNCHD === '1' ? 'launchd' : undefined) : undefined;
  const launch = supervisor ? await resolveAutostartConnection(stateDir, process.env) : undefined;
  const configuration = launch?.connection ?? await resolveHostConnection(stateDir, process.env);
  const { serverUrl, environment } = configuration;
  const hostEnvironment = await detectHostEnvironment(undefined, environment);
  if (daemon) {
    const existing = await readState();
    if (existing && existing.pid !== process.pid && processAlive(existing.pid))
      throw new Error(`A saved Agent Host process is still alive (pid ${existing.pid}); wait for it to exit before starting another daemon.`);
  }
  const installationId = await installation();
  const token = process.env.AGENT_HOST_MANAGEMENT_TOKEN ?? randomBytes(32).toString('hex');
  diagnosticSecrets.add(configuration.remoteKey); diagnosticSecrets.add(token);
  await enrollHost(configuration, installationId, hostEnvironment, diagnosticSecrets, async hostId => {
    if (configuration.pairingPurpose === 'gateway-setup') {
      const managed = await configureGatewayProviders(stateDir, configuration, hostId, secret => diagnosticSecrets.add(secret));
      Object.assign(environment, managed);
    }
  });
  const executionPolicy = await createHostExecutionPolicy(environment);
  if (executionPolicy) environment.AGENT_HOST_WORKSPACE = executionPolicy.defaultWorkspace;
  const registrations = await createHostRegistrations(environment,
    (line) => writeDiagnostic(line, diagnosticSecrets));
  const host = createAgentHost({ registrations, environment: hostEnvironment, installationId, name: environment.AGENT_HOST_NAME?.trim() || hostname(),
    vscodeTunnel: { stateDirectory: stateDir, executable: environment.AGENT_HOST_VSCODE?.trim() || undefined,
      disconnectTimeoutMs: environment.AGENT_HOST_VSCODE_DISCONNECT_TIMEOUT_MS ? Number(environment.AGENT_HOST_VSCODE_DISCONNECT_TIMEOUT_MS) : undefined },
    preview: { stateDirectory: stateDir, ttlMs: Number(environment.AGENT_HOST_PREVIEW_TTL_MS ?? 3_600_000),
      protectedPorts: (environment.AGENT_HOST_PREVIEW_PROTECTED_PORTS ?? '').split(',').filter(Boolean).map(Number),
      diagnostic: event => { writeDiagnostic(JSON.stringify({ event, time: new Date().toISOString() }), diagnosticSecrets); } },
    onRequestDiagnostic: diagnostic => { writeDiagnostic(JSON.stringify({ ...diagnostic, timestamp: new Date().toISOString(), pid: process.pid }), diagnosticSecrets); },
    onDiagnostic: diagnostic => { writeDiagnostic(uplinkDiagnosticLine(diagnostic), diagnosticSecrets); },
    executionPolicy, uplink: { url: uplinkUrl(serverUrl), remoteKey: configuration.remoteKey, onCredential: credential => {
      diagnosticSecrets.add(credential); return saveIssuedCredential(stateDir, configuration, credential);
    } }, shutdownTimeoutMs: shutdownTimeout() });
  if (!daemon) {
    process.stdout.write('Agent Host is running in the foreground.\n');
    await saveRegisteredConnection(stateDir, configuration, host.ready);
    process.stdout.write('Agent Host uplink is registered.\n');
    await waitForSignal(host);
    return;
  }
  void saveRegisteredConnection(stateDir, configuration, host.ready).then(() => clearAutostartConnection(stateDir, launch?.pendingId)).catch(error => {
    writeDiagnostic(error instanceof Error ? error.message : 'Could not save registered Host connection.', diagnosticSecrets);
  });
  const scope = createHash('sha256').update(stateDir).digest('hex').slice(0, 16);
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-host-${scope}-${process.pid}`
    : join(tmpdir(), `agent-host-${scope}-${process.pid}.sock`);
  if (process.platform !== 'win32') await rm(socket, { force: true });
  const management = createServer({ allowHalfOpen: true }, (connection) => {
    let input = '';
    let handled = false;
    const handle = () => {
      if (handled || connection.destroyed) return;
      handled = true;
      void handleManagement(input, token, host, configuration, diagnosticSecrets, connection, stopDaemon);
    };
    connection.setEncoding('utf8');
    connection.setTimeout(30_000, () => connection.destroy());
    connection.on('data', (chunk) => {
      input += chunk;
      if (input.length > 64 * 1024) connection.destroy();
      else if (input.includes('\n')) handle();
    });
    connection.on('error', () => connection.destroy());
    connection.on('end', handle);
  });
  await new Promise<void>((resolve, reject) => { management.once('error', reject); management.listen(socket, resolve); });
  if (process.platform !== 'win32') await chmod(socket, 0o600);
  await atomicJson(stateFile, { pid: process.pid, token, socket, startedAt: new Date().toISOString(), ...(supervisor ? { supervisor } : {}) });
  const shutdown = async () => {
    management.close();
    try { await within(host.close(), shutdownTimeout()); }
    finally {
      diagnosticLog?.dispose();
      if (process.platform !== 'win32') await rm(socket, { force: true });
      await removeOwnedDaemonState(stateFile, { pid: process.pid, token });
    }
  };
  let stopping = false;
  function stopDaemon() {
    if (stopping) return;
    stopping = true;
    void shutdown().finally(() => process.exit());
  }
  process.once('SIGTERM', stopDaemon);
  process.once('SIGINT', stopDaemon);
  await new Promise<void>(() => undefined);
}

async function enrollHost(configuration: HostConnection, installationId: string, hostEnvironment: Awaited<ReturnType<typeof detectHostEnvironment>>,
  diagnosticSecrets: Set<string>, onAccepted?: (hostId: string) => Promise<void>) {
  const { environment } = configuration;
  const relay = createAgentRemoteRelay({ providers: [] });
  const enrollment = createRemoteHostUplinkClient({ relay, installationId, name: environment.AGENT_HOST_NAME?.trim() || hostname(),
    environment: hostEnvironment, providers: [], url: uplinkUrl(configuration.serverUrl), remoteKey: configuration.remoteKey,
    resolveSession: () => undefined, control: async () => ({ status: 503, body: JSON.stringify({ error: 'Host initialization is in progress.' }) }),
    onCredential: credential => { diagnosticSecrets.add(credential); return saveIssuedCredential(stateDir, configuration, credential); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const accepted = await Promise.race([enrollment.ready, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Host enrollment timed out. Restart the Controller to retry.')), 15_000);
    })]);
    clearTimeout(timer);
    configuration.pairingPurpose = accepted.pairingPurpose ?? 'host-only';
    delete environment.AGENT_HOST_BOOTSTRAP_CODEX;
    delete environment.AGENT_HOST_GATEWAY_SETUP;
    if (configuration.pairingPurpose === 'gateway-setup') environment.AGENT_HOST_GATEWAY_SETUP = '1';
    await saveRegisteredConnection(stateDir, configuration, Promise.resolve(accepted));
    await onAccepted?.(accepted.hostId);
    return accepted;
  } finally {
    clearTimeout(timer);
    try { await within(enrollment.close(), shutdownTimeout()); }
    finally { await within(relay.close(), shutdownTimeout()); }
  }
}

async function handleManagement(input: string, token: string, host: AgentHost, configuration: HostConnection, diagnosticSecrets: Set<string>, connection: import('node:net').Socket, stopDaemon: () => void): Promise<void> {
  try {
    const request = JSON.parse(input) as { token?: string; action?: string; server?: string; key?: string; hostId?: string; providerId?: string; nativeSessionId?: string; cursor?: string; serverUrl?: string };
    if (request.token !== token) throw new Error('Unauthorized local management request.');
    if (request.action === 'status') connection.end(JSON.stringify({ running: true, uplink: host.state }));
    else if (request.action === 'share-context') connection.end(JSON.stringify({ ...await host.shareContext(), serverUrl: configuration.serverUrl }));
    else if (request.action === 'share-catalog') {
      if (request.serverUrl !== configuration.serverUrl) throw new Error('The Host connection changed. Run share again.');
      if (typeof request.hostId !== 'string' || typeof request.providerId !== 'string'
        || (request.nativeSessionId !== undefined && typeof request.nativeSessionId !== 'string')
        || (request.cursor !== undefined && typeof request.cursor !== 'string')) throw new Error('Invalid share catalog request.');
      const result = await host.shareCatalog({ hostId: request.hostId, providerId: request.providerId,
        nativeSessionId: request.nativeSessionId, cursor: request.cursor });
      if (request.serverUrl !== configuration.serverUrl) throw new Error('The Host connection changed. Run share again.');
      connection.end(JSON.stringify(result));
    }
    else if (request.action === 'pair') {
      let response: Record<string, unknown> = {};
      let restartRequired = false;
      await withDaemonLifecycleLock(stateDir, async () => {
        assertLivePairAllowed(configuration.environment);
        if (!request.server || !request.key) throw new Error('Repair requires a server and key.');
        diagnosticSecrets.add(request.key);
        const replacement = { ...configuration, environment: { ...configuration.environment }, serverUrl: request.server, remoteKey: request.key };
        const accepted = await enrollHost(replacement, await installation(), await detectHostEnvironment(undefined, replacement.environment), diagnosticSecrets);
        if (replacement.pairingPurpose === 'gateway-setup') {
          Object.assign(configuration, replacement);
          await within(host.close(), shutdownTimeout());
          restartRequired = true;
          response = { running: false, restartRequired: true, hostId: accepted.hostId };
        } else {
          const registered = await saveRegisteredConnection(stateDir, replacement,
            host.replaceUplink({ url: uplinkUrl(replacement.serverUrl), remoteKey: replacement.remoteKey, onCredential: credential => {
              diagnosticSecrets.add(credential); return saveIssuedCredential(stateDir, replacement, credential);
            } }));
          Object.assign(configuration, replacement);
          response = { running: true, uplink: host.state, hostId: registered.hostId };
        }
      });
      connection.end(JSON.stringify(response), () => { if (restartRequired) stopDaemon(); });
    } else if (request.action === 'stop') { connection.end(JSON.stringify({ stopping: true }), stopDaemon); }
    else throw new Error('Unknown local management action.');
  } catch (error) { connection.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
}

async function start(enableAutostart = false): Promise<void> {
  await withDaemonLifecycleLock(stateDir, async () => {
    const configuration = await resolveHostConnection(stateDir, process.env);
    configuration.environment.AGENT_HOST_WORKSPACE ??= configuration.environment.AGENT_REMOTE_WORKSPACE ?? process.cwd();
    const supervisor = loginStartup(configuration);
    let managed = supervisor !== undefined && (enableAutostart || await autostartEnabled(stateDir));
    const existing = await readState();
    if (managed && supervisor?.kind === 'systemd' && !await supervisor.available()) {
      if (enableAutostart || existing?.supervisor === 'systemd' || (await supervisor.status()).installed) throw new Error(systemdUnavailable);
      process.stderr.write('systemd user startup is unavailable; starting a manual background daemon without login startup or crash recovery. Use foreground in containers.\n');
      managed = false;
    }
    if (existing && await authenticateSavedDaemon(existing)) {
      if (!managed) throw new Error(`Agent Host daemon is already running (pid ${existing.pid}).`);
      await supervisor!.install();
      process.stdout.write(existing.supervisor === supervisor!.kind
        ? `Agent Host daemon is already running (pid ${existing.pid}); login startup is enabled.\n`
        : `Login startup is enabled for the next login. The manually started daemon (pid ${existing.pid}) is unchanged; stop then start to use ${supervisor!.kind} now.\n`);
      return;
    }
    if (existing && processAlive(existing.pid)) throw new Error(`Saved Agent Host process ${existing.pid} is alive but its management socket is unavailable. Wait for shutdown; inspect private daemon state before retrying.`);
    if (existing) await rm(stateFile, { force: true });
    const log = await open(daemonLogFile, 'a', 0o600);
    await log.chmod(0o600);
    const logOffset = (await log.stat()).size;
    let childPid: number | undefined;
    try {
      if (managed) {
        await prepareAutostartConnection(stateDir, configuration);
        await supervisor!.install();
        if (supervisor!.kind === 'windows') childPid = await supervisor!.start();
        else await supervisor!.start();
      } else {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_serve'], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...configuration.environment, AGENT_HOST_MANAGEMENT_TOKEN: randomBytes(32).toString('hex'), AGENT_HOST_LAUNCHD: undefined, AGENT_HOST_SUPERVISOR: undefined } });
        childPid = child.pid;
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      }
    } finally { await log.close(); }
    // Allow all selected native version probes to finish, including a cold Copilot launch.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const state = await readState();
      if (state && (managed ? state.supervisor === supervisor!.kind : state.pid === childPid) && await authenticateSavedDaemon(state)) {
        process.stdout.write(`Agent Host daemon started (pid ${state.pid}); ${managed ? 'login startup enabled; ' : ''}log: ${daemonLogFile}.\n`); return;
      }
      if (childPid && !processAlive(childPid)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let diagnostic = '';
    const reader = await open(daemonLogFile, 'r');
    try {
      const size = (await reader.stat()).size;
      const offset = Math.max(logOffset, size - 4096);
      if (size > offset) {
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await reader.read(buffer, 0, buffer.length, offset);
        diagnostic = boundedDiagnosticLine(buffer.subarray(0, bytesRead).toString('utf8'), [configuration.remoteKey]).trim();
      }
    } finally { await reader.close(); }
    const advice = diagnostic.includes('authorization was rejected')
      ? 'Generate a new pairing key on the Relay, set AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY together, then run start again.'
      : 'Run foreground with the same environment for startup diagnostics.';
    throw new Error(`Agent Host daemon did not become ready.${diagnostic ? ` ${diagnostic}` : ''} ${advice} Log: ${daemonLogFile}`);
  });
}

async function share(): Promise<void> {
  if (args.length > 2 || (args[1] !== undefined && args[1] !== 'list-sessions')) throw new Error('Usage: agent-remote-controller share [list-sessions]');
  const state = await requiredState();
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY;
  let lines: ReturnType<typeof createInterface> | undefined;
  let answers: AsyncIterator<string> | undefined;
  const startTextInput = () => {
    lines = createInterface({ input: process.stdin, output: process.stdout, terminal });
    answers = lines[Symbol.asyncIterator]();
    lines.on('SIGINT', () => lines!.close());
  };
  // Buffer piped answers immediately; interactive text input starts after keyboard selection.
  if (!terminal) startTextInput();
  try {
    await runShare(args.slice(1), payload => request(state, payload), {
      write: text => { process.stdout.write(text); },
      ask: async prompt => {
        if (!answers) startTextInput();
        process.stdout.write(prompt);
        try {
          const answer = await answers!.next();
          return answer.done ? 'q' : answer.value;
        } finally {
          // Release readline before a search result returns to raw keyboard selection.
          if (terminal) { lines?.close(); lines = undefined; answers = undefined; }
        }
      },
      select: terminal ? selectTerminalChoice : undefined,
      qr: renderSessionQr,
    });
  } finally { lines?.close(); }
}
async function status(): Promise<void> {
  const state = await readState();
  if (!state || !processAlive(state.pid)) { process.stdout.write('Agent Host daemon is not running.\n'); process.exitCode = 3; return; }
  const response = await request(state, { action: 'status' });
  process.stdout.write(`Agent Host daemon is running (pid ${state.pid}); uplink: ${String(response.uplink)}; supervisor: ${state.supervisor ?? 'manual'}.\n`);
}
function assertLivePairAllowed(environment: NodeJS.ProcessEnv): void {
  if (environment.AGENT_HOST_GATEWAY_SETUP === '1' || environment.AGENT_HOST_BOOTSTRAP_CODEX === '1') {
    throw new Error('Gateway-managed Hosts cannot replace their live pairing. Initialize a new Host with a separate AGENT_HOST_STATE_DIR to change accounts or Relays.');
  }
}
async function pair(): Promise<void> {
  assertLivePairAllowed(await resolveHostEnvironment(stateDir, {}));
  assertLivePairAllowed(process.env);
  const server = requiredEnv('AGENT_HOST_SERVER'); const key = requiredEnv('AGENT_HOST_REMOTE_KEY');
  const state = await requiredState();
  const response = await request(state, { action: 'pair', server, key });
  process.stdout.write(response.restartRequired
    ? `Agent Host pairing saved as ${String(response.hostId)}. The daemon stopped; restart with agent-remote-controller start to initialize Gateway providers using the saved device credential.\n`
    : `Agent Host uplink registered as ${String(response.hostId)} without restarting sessions.\n`);
}
function loginStartup(configuration?: HostConnection) {
  const options = { stateDir, home: homedir(), nodePath: realpathSync(process.execPath), cliPath: fileURLToPath(import.meta.url),
    cwd: configuration?.environment.AGENT_HOST_WORKSPACE ?? configuration?.environment.AGENT_REMOTE_WORKSPACE ?? process.cwd(),
    path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
  if (process.platform === 'linux') return { kind: 'systemd' as const,
    ...createSystemdAutostart({ ...options, configHome: process.env.XDG_CONFIG_HOME }) };
  if (process.platform === 'darwin') return { kind: 'launchd' as const,
    ...createLaunchdAutostart({ ...options, uid: process.getuid!() }) };
  if (process.platform === 'win32') return { kind: 'windows' as const, ...createWindowsAutostart(options) };
  return undefined;
}
async function autostart(action: string): Promise<void> {
  const supervisor = loginStartup();
  if (!supervisor) throw new Error('Agent Host login startup requires macOS, Linux or Windows.');
  if (action === 'enable') { await start(true); return; }
  if (action === 'status') {
    const value = await supervisor.status();
    const details = 'unitFile' in value
      ? `systemd user manager ${value.available ? 'available' : 'unavailable'}; service ${value.serviceEnabled ? 'enabled' : 'not enabled'}; unit: ${value.unitFile}`
      : 'startupFile' in value ? `startup file: ${value.startupFile}` : `plist: ${value.plist}`;
    process.stdout.write(`Agent Host autostart is ${value.enabled ? 'enabled' : 'disabled'}; ${value.installed ? 'installed' : 'not installed'}; ${supervisor.kind} job ${value.loaded ? 'loaded' : 'not loaded'}; ${details}.\n`);
    return;
  }
  if (action !== 'disable') throw new Error('Use autostart enable, disable, or status.');
  await withDaemonLifecycleLock(stateDir, async () => {
    const state = await readState();
    const running = state && await authenticateSavedDaemon(state);
    if (state?.supervisor === 'systemd' && processAlive(state.pid) && supervisor.kind === 'systemd' && !await supervisor.available()) throw new Error(systemdUnavailable);
    await supervisor.disable();
    if (running && state.supervisor === supervisor.kind) await waitForDaemonExit(state);
    process.stdout.write(state && state.supervisor !== supervisor.kind && await authenticateSavedDaemon(state)
      ? 'Agent Host autostart is disabled; the manually started daemon is still running.\n'
      : 'Agent Host autostart is disabled; the managed daemon is stopped.\n');
  });
}
async function stop(): Promise<void> {
  await withDaemonLifecycleLock(stateDir, async () => {
    const state = await readState();
    const running = state && processAlive(state.pid);
    const supervisor = loginStartup();
    if (supervisor?.kind === 'windows' || supervisor?.kind === 'launchd' || (supervisor?.kind === 'systemd' && (state?.supervisor === 'systemd' || await supervisor.available()))) await supervisor.stop();
    if (state && await authenticateSavedDaemon(state)) await request(state, { action: 'stop' });
    if (running) await waitForDaemonExit(state);
    process.stdout.write('Agent Host daemon is stopped. Login startup preference is unchanged.\n');
  });
}
async function waitForDaemonExit(state: DaemonState): Promise<void> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (!processAlive(state.pid)) return;
    const current = await readState();
    if (current && (current.pid !== state.pid || current.token !== state.token)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Agent Host daemon has not exited; inspect its private log for shutdown diagnostics.');
}
async function request(state: DaemonState, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(state.socket); let output = '';
    connection.setTimeout(payload.action === 'pair' || payload.action === 'share-catalog' ? 30_000 : 5000, () => connection.destroy(new Error(payload.action === 'pair'
      ? 'Pairing result is unknown: the invitation may already be consumed and saved. Check agent-remote-controller status and private saved connection settings before retrying. Restart with saved settings to finish pending Gateway setup; do not blindly reuse the invitation.'
      : 'Local management request timed out.')));
    // Windows named pipes do not support the Unix socket half-close request framing.
    connection.on('connect', () => {
      const message = JSON.stringify({ ...payload, token: state.token });
      if (process.platform === 'win32') connection.write(`${message}\n`);
      else connection.end(message);
    });
    connection.setEncoding('utf8'); connection.on('data', (chunk) => { output += chunk; });
    connection.on('error', reject); connection.on('close', () => {
      let response: Record<string, unknown>;
      try { response = JSON.parse(output) as Record<string, unknown>; }
      catch { reject(new Error('Agent Host daemon returned an invalid management response.')); return; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) { reject(new Error('Agent Host daemon returned an invalid management response.')); return; }
      if (response.error) reject(new Error(response.error === 'Unknown local management action.' && String(payload.action).startsWith('share-')
        ? 'The running Controller does not support share yet. Update it and restart the Controller, then try again.' : String(response.error)));
      else resolve(response);
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
    throw new Error(`Another Agent Host lifecycle command owns ${lock}. If no lifecycle command is running, remove this private stale lock and retry.`);
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
}
export async function withDaemonLifecycleLock(directory: string, operation: () => Promise<void>): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const lock = join(directory, 'startup.lock');
  await acquireStartupLock(lock);
  try { await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function removeOwnedDaemonState(path: string, owner: { pid: number; token: string }): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as DaemonState;
    if (saved.pid === owner.pid && saved.token === owner.token) await rm(path, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
export function daemonDiagnosticLine(line: string, secrets: Iterable<string>, maxBytes?: number): string {
  return boundedDiagnosticLine(line, secrets, maxBytes);
}
export function uplinkDiagnosticLine(diagnostic: AgentHostUplinkDiagnostic): string {
  const { event, uplinkGeneration, connectionId, registered, reason, peerReason, closeCode, httpStatus, errorCode, retryAttempt,
    retryDelayMs, heartbeatTimeoutMs, lastHeartbeatAgeMs } = diagnostic;
  return `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event: `uplink_${event}`,
    uplinkGeneration, connectionId, registered, reason, peerReason, closeCode, httpStatus, errorCode, retryAttempt,
    retryDelayMs, heartbeatTimeoutMs, lastHeartbeatAgeMs })}\n`;
}
