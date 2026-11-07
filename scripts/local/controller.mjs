import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { controllerEnvironment } from './environment.mjs';
import { readJson, runState, withLock } from './instance.mjs';
import { approveCommandLine } from './session.mjs';

/** The Controller command line of a checkout, run against an instance's state. */
export const controllerCli = source => join(source, 'packages/agent-host/dist/cli.js');

const controllerCommands = new Set(['status', 'diagnostics', 'session', 'host', 'window', 'api', 'role', 'login', 'logout', '--skill', 'help', '--help', '-h', '--version']);

/** Why a Controller command is not run for the instance, or undefined when it is. */
export function controllerRefusal([group, action, detail]) {
  if (!controllerCommands.has(group ?? '')) {
    return 'The local instance runs session, host, window, api, role, login, logout, status, diagnostics and --skill. The runner owns start, stop, pairing and updates (run pnpm local up), and the native CLIs could take over shared sessions.';
  }
  if (group === 'session' && action === 'attach') return 'session attach runs a native CLI on the shared profiles and can take a session over from its other clients; open the session in the instance website instead.';
  if (group === 'host' && action === 'update') return "The runner owns the instance's build: run pnpm local up instead of host update.";
  if (group === 'host' && action === 'tunnel' && detail !== undefined && detail !== 'status') return 'The VS Code tunnel is shared with your own Controller; here host tunnel only reports its status.';
  if (group === 'login' && action !== undefined && action !== 'status' && action !== '--help') return 'login signs in as the local user by itself and takes no options; login status reports the sign-in.';
  return undefined;
}

/** The file name of the instance Controller's session socket, as the Controller derives it from its state directory. */
export function instanceSessionSocket(instance) {
  return `arc-sessions-${createHash('sha256').update(instance.controller).digest('hex').slice(0, 16)}.sock`;
}

/**
 * The environment of a Controller command for the instance. A calling session keeps its identity only when it is a
 * session of this instance; any other session's credential, such as one of the user's own Controller, is dropped.
 */
export function commandEnvironment(parent, instance) {
  const environment = controllerEnvironment(parent, instance);
  const { AGENT_REMOTE_SESSION_SOCKET: socket, AGENT_REMOTE_SESSION_TOKEN: token } = parent;
  if (socket && token && basename(socket) === instanceSessionSocket(instance)) {
    Object.assign(environment, { AGENT_REMOTE_SESSION_SOCKET: socket, AGENT_REMOTE_SESSION_TOKEN: token });
  }
  return environment;
}

function controllerOutput(source, instance, args) {
  return promisify(execFile)(process.execPath, [controllerCli(source), ...args],
    { env: controllerEnvironment(process.env, instance), cwd: instance.workspace, timeout: 15_000, maxBuffer: 65536 });
}

export async function controllerUplink(source, instance) {
  try { return /uplink: ([a-z_-]+)/.exec((await controllerOutput(source, instance, ['status'])).stdout)?.[1]; }
  catch { return undefined; }
}

/** Whether the instance's Controller command line holds a sign-in the site still accepts. */
export async function commandLineSignedIn(source, instance) {
  try { return JSON.parse((await controllerOutput(source, instance, ['login', 'status'])).stdout).signedIn === true; }
  catch { return false; }
}

/**
 * Signs the instance's Controller command line in as the local user, so that window, api and the commands the
 * Relay answers work: it starts the product's own login and allows its code as the approval page would.
 */
export async function signInCommandLine(source, instance) {
  if (await commandLineSignedIn(source, instance)) return;
  const child = spawn(process.execPath, [controllerCli(source), 'login', '--server', instance.record.origin, '--no-browser'],
    { env: controllerEnvironment(process.env, instance), cwd: instance.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolveExit => {
    child.once('error', () => resolveExit(1));
    child.once('close', code => resolveExit(code ?? 1));
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  let output = '';
  let approval;
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    const code = /allow code ([A-Z]{8})\./.exec(output)?.[1];
    // A failed approval ends the login at once instead of letting it poll until the code expires.
    if (code && !approval) approval = approveCommandLine(instance.record.origin, code).then(() => undefined, error => { child.kill('SIGTERM'); return error; });
  });
  try {
    const code = await exited;
    const failure = await approval;
    if (failure) throw failure;
    let result;
    // The login prints its code on one line, then one JSON result over several lines.
    try { result = JSON.parse(output.replace(/^Open .*\n/, '')); } catch { result = undefined; }
    if (code !== 0 || result?.signedIn !== true) {
      throw new Error(result?.error?.message ?? `The Controller command line did not sign in (exit ${code}).`);
    }
  } finally { clearTimeout(timer); }
}

/** Runs a child on this terminal and resolves with its exit code; a child that cannot start rejects with the reason. */
export async function runAttached(file, args, options) {
  const child = spawn(file, args, { stdio: 'inherit', ...options });
  return await new Promise((resolveExit, reject) => {
    child.once('error', error => reject(new Error(`Could not run ${file}: ${error.message}`)));
    child.once('exit', code => resolveExit(code ?? 1));
  });
}

/** Runs one Controller command for the instance and resolves with its exit code; a refused command throws. */
export async function controllerCommand({ source, instance, args, parent = process.env, write = text => process.stdout.write(text) }) {
  const refusal = controllerRefusal(args);
  if (refusal) throw new Error(refusal);
  if (args[0] === 'login' && args.length === 1) {
    if (await runState(instance.directory, await readJson(instance.runtimeFile)) !== 'running') throw new Error('The instance is not running. Run pnpm local up.');
    await withLock(instance.directory, () => signInCommandLine(source, instance));
    write(`The Controller command line is signed in to ${instance.record.origin}.\n`);
    return 0;
  }
  return runAttached(process.execPath, [controllerCli(source), ...args], { env: commandEnvironment(parent, instance), cwd: instance.workspace });
}
