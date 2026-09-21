import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveHostEnvironment } from './connection-config.js';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { loadGatewayCodexEnvironment } from './gateway-codex.js';

/** Runs the native CLI with inherited terminal streams; never owns the shared daemon implicitly. */
export async function runCodexCommand(args: string[], stateDir: string, environment: NodeJS.ProcessEnv): Promise<number> {
  if (args[0] === 'app-server' && args[1] === 'daemon') args = ['daemon', ...args.slice(2)];
  const configured = await loadGatewayCodexEnvironment(stateDir, await resolveHostEnvironment(stateDir, environment));
  const executable = configured.AGENT_HOST_CODEX ?? configured.AGENT_REMOTE_CODEX_EXECUTABLE ?? 'codex';
  const home = configured.AGENT_REMOTE_CODEX_HOME ?? configured.CODEX_HOME ?? join(homedir(), '.codex');
  const defaultSocket = join(resolve(home), 'app-server-control', 'app-server-control.sock');
  const socket = configured.AGENT_HOST_CODEX_SOCKET ?? defaultSocket;
  if (!isAbsolute(socket)) throw new Error('AGENT_HOST_CODEX_SOCKET must be an absolute local path.');
  const env = { ...sanitizeNativeEnvironment(configured), CODEX_HOME: home, LC_ALL: 'C' };
  const separator = args.indexOf('--');
  const options = args.slice(0, separator < 0 ? args.length : separator);
  let nativeArgs: string[];
  const daemon = args[0] === 'daemon';
  if (daemon) {
    if (resolve(socket) !== defaultSocket) throw new Error('Cannot manage a daemon for a custom socket. Use the native daemon owner directly, or configure the matching CODEX_HOME and default socket.');
    const action = args[1] ?? 'status';
    if (!['start', 'restart', 'stop', 'status', 'version', '--help', '-h'].includes(action)) throw new Error('Use codex daemon start, restart, stop, or status.');
    nativeArgs = ['app-server', 'daemon', action === 'status' ? 'version' : action, ...args.slice(2)];
  } else if (options.some(arg => ['--help', '-h', '--version', '-V'].includes(arg)) || ['help', 'app-server', 'remote-control', 'login', 'logout', 'doctor', 'update', 'completion', 'mcp', 'plugin', 'features'].includes(args[0] ?? '')) {
    nativeArgs = args;
  } else {
    // Explicit --remote remains available for intentional one-off connections.
    const hasRemote = options.some(arg => arg === '--remote' || arg.startsWith('--remote='));
    const shared = !hasRemote && configured.AGENT_HOST_CODEX_CONNECTION !== 'private';
    // A shared server cannot infer the invoking shell's directory from the CLI process cwd.
    const sessionArgs = shared && needsShellWorkspace(args) ? ['--cd', process.cwd(), ...args] : args;
    nativeArgs = shared ? ['--remote', `unix://${socket}`, ...sessionArgs] : args;
  }
  let command = executable;
  const limit = configured.AGENT_HOST_CODEX_NOFILE ?? '8192';
  if (daemon && ['start', 'restart'].includes(args[1] ?? '')) {
    if (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) throw new Error('AGENT_HOST_CODEX_NOFILE must be a positive integer.');
    if (process.platform === 'win32') throw new Error('AGENT_HOST_CODEX_NOFILE is only supported on Unix.');
    command = '/bin/sh';
    nativeArgs = ['-c', 'if ! ulimit -Sn "$1"; then echo "Cannot set Codex daemon file descriptor limit to $1. Daemon was not started or restarted. Check the system hard limit or set AGENT_HOST_CODEX_NOFILE." >&2; exit 1; fi; shift; exec "$@"', 'agent-remote-controller', limit, executable, ...nativeArgs];
  }
  return new Promise<number>((resolveResult, reject) => {
    const child = spawn(command, nativeArgs, { env, stdio: 'inherit' });
    const interrupt = () => { child.kill('SIGINT'); };
    const terminate = () => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolveResult(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)); });
  });
}

const nativeCommands = new Set([
  'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control',
  'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'resume', 'queue', 'archive',
  'delete', 'migrate-rollouts', 'unarchive', 'fork', 'cloud', 'exec-server', 'features', 'help',
]);
const valueOptions = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '--add-dir', '-a', '--ask-for-approval',
]);

/** Only a new interactive session receives a default; native subcommands retain their own cwd rules. */
function needsShellWorkspace(args: readonly string[]): boolean {
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') break;
    if (arg === '--cd' || arg.startsWith('--cd=') || arg.startsWith('-C')) return false;
    if (valueOptions.has(arg)) { index += 1; continue; }
    if (arg.startsWith('-')) continue;
    if (!positional && nativeCommands.has(arg)) return false;
    positional = true;
  }
  return true;
}
