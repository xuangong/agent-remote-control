import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';
import { packageManager } from '../lib/package-manager.mjs';
import { controllerEnvironment } from './environment.mjs';
import {
  findInstance, listInstances, portAvailable, prepareInstance, processAlive, processCommand, readJson, runState, runsInstance, spawnDetached, withLock,
} from './instance.mjs';
import { approveCommandLine, screenshot, signedInUser, userApi } from './session.mjs';

if (process.platform === 'win32') {
  process.stderr.write('pnpm local supports macOS and Linux.\n');
  process.exit(1);
}

const source = realpathSync(resolve(import.meta.dirname, '../..'));
const controllerCli = join(source, 'packages/agent-host/dist/cli.js');
const controllerCommands = new Set(['status', 'diagnostics', 'session', 'host', 'window', 'api', 'login', 'logout', '--skill', 'help', '--help', '-h', '--version']);
const usage = `Usage: pnpm local <command>
  up [--no-build]        Build, then start or restart this checkout's instance
  down                   Stop this checkout's instance; its state is kept
  status [--json]        URL, running build, local user and Controller registration; exits 3 unless all are ready
  logs [--follow]        Runner and Controller output of the current run
  list [--json]          Every local instance on this machine
  remove --yes           Delete this checkout's stopped instance
  controller <args>      Controller CLI for this instance: session, host, window, api, login, status, diagnostics, --skill
  api <v1/path> [--method M] [--data JSON]   Signed-in JSON request to the instance
  screenshot <path> --out FILE [--viewport WxH] [--wait-for CSS] [--full-page]
Exit codes: 0 success, 1 failure, 3 status found no instance or one that is not ready.
`;

async function requireInstance() {
  const instance = await findInstance(source);
  if (!instance) throw new Error('This checkout has no local instance. Run pnpm local up.');
  return instance;
}

async function requireRunning() {
  const instance = await requireInstance();
  if (await runState(instance.directory, await readJson(instance.runtimeFile)) !== 'running') {
    throw new Error('The instance is not running. Run pnpm local up.');
  }
  return instance;
}

/** Runs a child on this terminal and resolves with its exit code; a child that cannot start rejects with the reason. */
async function runAttached(file, args, options) {
  const child = spawn(file, args, { stdio: 'inherit', ...options });
  return await new Promise((resolveExit, reject) => {
    child.once('error', error => reject(new Error(`Could not run ${file}: ${error.message}`)));
    child.once('exit', code => resolveExit(code ?? 1));
  });
}

async function runStep(command, args) {
  const [file, argv] = command === 'pnpm' ? packageManager('pnpm', args) : [command, args];
  const code = await runAttached(file, argv, { cwd: source });
  if (code !== 0) throw new Error(`Build step failed: ${[command, ...args].join(' ')}. A running instance was left unchanged.`);
}

async function build() {
  if (!existsSync(join(source, 'node_modules'))) await runStep('pnpm', ['install', '--frozen-lockfile']);
  await runStep('pnpm', ['--filter', '@orchardworks/agent-remote-controller...', 'run', 'build']);
  await runStep('pnpm', ['build:relay']);
  await runStep(process.execPath, [join(source, 'scripts/build-devbox.mjs')]);
}

function assertBuilt() {
  const web = process.env.ARC_LOCAL_WEB_DIST ?? join(source, 'dist/relay/web');
  const missing = [controllerCli, join(source, 'dist/devbox/server.mjs'), join(web, 'index.html')].filter(path => !existsSync(path));
  if (missing.length) throw new Error(`Build artifacts are missing (${missing.join(', ')}). Run pnpm local up without --no-build.`);
}

async function controllerUplink(instance) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [controllerCli, 'status'],
      { env: controllerEnvironment(process.env, instance), cwd: instance.workspace, timeout: 10_000, maxBuffer: 65536 });
    return /uplink: ([a-z_-]+)/.exec(stdout)?.[1];
  } catch { return undefined; }
}

function controllerOutput(instance, args) {
  return promisify(execFile)(process.execPath, [controllerCli, ...args],
    { env: controllerEnvironment(process.env, instance), cwd: instance.workspace, timeout: 15_000, maxBuffer: 65536 });
}

/** Whether the instance's Controller command line holds a sign-in the site still accepts. */
async function commandLineSignedIn(instance) {
  try { return JSON.parse((await controllerOutput(instance, ['login', 'status'])).stdout).signedIn === true; }
  catch { return false; }
}

/**
 * Signs the instance's Controller command line in as the local user, so that window, api and the commands the
 * Relay answers work: it starts the product's own login and allows its code as the approval page would.
 */
async function signInCommandLine(instance) {
  if (await commandLineSignedIn(instance)) return;
  const child = spawn(process.execPath, [controllerCli, 'login', '--server', instance.record.origin, '--no-browser'],
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

async function siteAlive(origin) {
  try {
    const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

async function logTails(instance, lines) {
  const parts = [];
  for (const name of ['runner.log', 'controller.log']) {
    const text = await readFile(join(instance.logs, name), 'utf8').catch(() => '');
    parts.push(`--- ${name} (last ${lines} lines) ---\n${text.trimEnd().split('\n').slice(-lines).join('\n')}`);
  }
  return parts.join('\n');
}

async function exitedWithin(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) return false;
    await delay(200);
  }
  return true;
}

async function stopRunnerProcess(pid, instance, timeoutMs = 30_000) {
  if (!runsInstance(await processCommand(pid), instance.directory)) return;
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (await exitedWithin(pid, timeoutMs)) return;
  const runtime = await readJson(instance.runtimeFile).catch(() => undefined);
  // A runner that has not started its Controller holds nothing that needs a clean stop.
  if (runtime?.controllerPid && processAlive(runtime.controllerPid)) {
    throw new Error(`Runner pid ${pid} did not stop within ${timeoutMs / 1000} seconds; its Controller pid ${runtime.controllerPid} is still running.`);
  }
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (!(await exitedWithin(pid, 5000))) throw new Error(`Runner pid ${pid} could not be stopped.`);
}

async function stopRunner(instance) {
  const runtime = await readJson(instance.runtimeFile);
  const state = await runState(instance.directory, runtime);
  if (state === 'orphaned') {
    throw new Error(`The runner is gone but Controller pid ${runtime.controllerPid} still runs. Stop that process, then retry.`);
  }
  if (state === 'running') await stopRunnerProcess(runtime.runnerPid, instance);
  await rm(instance.runtimeFile, { force: true });
  return state === 'running';
}

async function startRunner(instance) {
  // A runner that fails before opening its Controller log must not leave the previous run's output looking current.
  await rm(join(instance.logs, 'controller.log'), { force: true });
  const log = await open(join(instance.logs, 'runner.log'), 'w', 0o600);
  try {
    const child = await spawnDetached(spawn, process.execPath, [join(source, 'scripts/local/runner.mjs'), instance.directory],
      { cwd: instance.directory, env: process.env, stdio: ['ignore', log.fd, log.fd], detached: true });
    child.unref();
    return child.pid;
  } finally { await log.close(); }
}

function readyTimeoutMs() {
  const value = process.env.ARC_LOCAL_READY_TIMEOUT_MS;
  if (value === undefined) return 90_000;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`ARC_LOCAL_READY_TIMEOUT_MS must be a positive whole number of milliseconds, not "${value}".`);
  return Number(value);
}

async function waitUntilReady(instance, runnerPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let waiting;
  const waitFor = phase => {
    if (waiting === phase) return;
    waiting = phase;
    process.stdout.write(`Waiting for ${phase}…\n`);
  };
  waitFor('the site');
  while (Date.now() < deadline) {
    if (!processAlive(runnerPid)) throw new Error('The runner exited during startup.');
    // Polling avoids signing in: every sign-in counts against the instance's 30-per-minute limit.
    if (await siteAlive(instance.record.origin)) {
      waitFor('Controller registration');
      if (await controllerUplink(instance) === 'registered') {
        await signedInUser(instance.record.origin);
        return;
      }
    } else waitFor('the site');
    await delay(500);
  }
  throw new Error(`The instance did not become ready within ${timeoutMs / 1000} seconds while waiting for ${waiting}.`);
}

async function describe(instance) {
  let runtime;
  let state;
  let problem = null;
  try {
    runtime = await readJson(instance.runtimeFile);
    state = await runState(instance.directory, runtime);
  } catch (error) { state = 'unknown'; problem = error.message; }
  const running = state === 'running';
  const [localUser, uplink, commandLine, checkout] = await Promise.all([
    running ? signedInUser(instance.record.origin).catch(() => false) : false,
    running ? controllerUplink(instance) : undefined,
    running ? commandLineSignedIn(instance) : false,
    controllerBuildProvenance(instance.record.source, {}).catch(() => undefined),
  ]);
  return {
    name: instance.record.name, source: instance.record.source, directory: instance.directory, origin: instance.record.origin,
    state, problem, localUser, controllerUplink: uplink ?? null, commandLine,
    build: runtime ? { revision: runtime.revision ?? null, dirty: runtime.dirty ?? null, startedAt: runtime.startedAt, runnerPid: runtime.runnerPid, controllerPid: runtime.controllerPid ?? null } : null,
    checkout: checkout ?? null,
  };
}

const revision = value => value?.revision ? `${value.revision.slice(0, 12)}${value.dirty ? ' (dirty)' : ''}` : 'unknown';

async function printStatus(instance, json) {
  const report = await describe(instance);
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write([
    `Instance: ${report.name} (${report.state})${report.problem ? ` — ${report.problem}` : ''}`,
    `Site: ${report.origin}  local user: ${report.localUser ? 'signed in' : 'unavailable'}`,
    `Controller: ${report.controllerUplink ? `uplink ${report.controllerUplink}` : 'not running'}${report.build?.controllerPid ? ` (pid ${report.build.controllerPid})` : ''}  command line: ${report.commandLine ? 'signed in' : 'signed out'}`,
    `Running build: ${report.build ? `${revision(report.build)} since ${report.build.startedAt}` : 'none'}; checkout now ${revision(report.checkout)}`,
    `State: ${report.directory}`,
  ].join('\n') + '\n');
  return report;
}

async function up(options) {
  const timeoutMs = readyTimeoutMs();
  const instance = await prepareInstance(source);
  await withLock(instance.directory, async () => {
    if (options['no-build']) assertBuilt();
    else await build();
    await stopRunner(instance);
    if (!(await portAvailable(instance.record.port))) {
      throw new Error(`Port ${instance.record.port} is in use by another process. The origin ${instance.record.origin} cannot change; free the port and run up again.`);
    }
    const runnerPid = await startRunner(instance);
    try { await waitUntilReady(instance, runnerPid, timeoutMs); }
    catch (error) {
      let stopFailure;
      try { await stopRunnerProcess(runnerPid, instance); } catch (stopError) { stopFailure = stopError; }
      const tails = await logTails(instance, 20);
      throw new Error(`${error.message}\n${tails}${stopFailure ? `\nThe runner could not be stopped: ${stopFailure.message}` : ''}`, { cause: error });
    }
    try { await signInCommandLine(instance); }
    catch (error) { process.stderr.write(`The Controller command line is not signed in: ${error.message} Run pnpm local controller login to retry.\n`); }
  });
  await printStatus(instance, false);
}

async function down() {
  const instance = await requireInstance();
  const stopped = await withLock(instance.directory, () => stopRunner(instance));
  process.stdout.write(stopped
    ? `Stopped ${instance.record.name}. Its state remains in ${instance.directory}.\n`
    : `${instance.record.name} was not running.\n`);
}

async function status(options) {
  const instance = await findInstance(source);
  if (!instance) {
    process.stdout.write(options.json ? '{"state":"none"}\n' : 'This checkout has no local instance. Run pnpm local up.\n');
    process.exitCode = 3;
    return;
  }
  const report = await printStatus(instance, options.json);
  if (report.state !== 'running' || !report.localUser || report.controllerUplink !== 'registered') process.exitCode = 3;
}

async function logs(options) {
  const instance = await requireInstance();
  if (!options.follow) { process.stdout.write(await logTails(instance, 80) + '\n'); return; }
  await runAttached('tail', ['-n', '40', '-F', join(instance.logs, 'runner.log'), join(instance.logs, 'controller.log')]);
}

async function list(options) {
  const current = (await findInstance(source))?.directory;
  const rows = [];
  for (const instance of await listInstances()) {
    const state = await runState(instance.directory, instance.runtime).catch(() => 'unknown');
    rows.push({ name: instance.record.name, state, origin: instance.record.origin, source: instance.record.source, current: instance.directory === current });
  }
  if (options.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  else if (!rows.length) process.stdout.write('No local instances.\n');
  else for (const row of rows) process.stdout.write(`${row.current ? '*' : ' '} ${row.name}  ${row.state}  ${row.origin}  ${row.source}\n`);
}

async function remove(options) {
  const instance = await requireInstance();
  if (!options.yes) throw new Error(`This deletes ${instance.directory}, including its site state and Controller pairing. Repeat with --yes.`);
  await withLock(instance.directory, async () => {
    const state = await runState(instance.directory, await readJson(instance.runtimeFile));
    if (state === 'running' || state === 'orphaned') throw new Error('Stop the instance with pnpm local down first.');
    await rm(instance.directory, { recursive: true, force: true });
  });
  process.stdout.write(`Removed ${instance.directory}. Test sessions remain in the shared native histories.\n`);
}

/** Why a Controller command is not run for the instance, or undefined when it is. */
function controllerRefusal([group, action, detail]) {
  if (!controllerCommands.has(group ?? '')) {
    return 'pnpm local controller runs session, host, window, api, login, logout, status, diagnostics and --skill. The runner owns start, stop, pairing and updates, and the native CLIs could take over shared sessions.';
  }
  if (group === 'session' && action === 'attach') return 'session attach runs a native CLI on the shared profiles and can take a session over from its other clients; open the session in the instance website instead.';
  if (group === 'host' && action === 'update') return "The runner owns the instance's build: run pnpm local up instead of host update.";
  if (group === 'host' && action === 'tunnel' && detail !== undefined && detail !== 'status') return 'The VS Code tunnel is shared with your own Controller; here host tunnel only reports its status.';
  if (group === 'login' && action !== undefined && action !== 'status' && action !== '--help') return 'pnpm local controller login signs in as the local user by itself and takes no options; login status reports the sign-in.';
  return undefined;
}

async function controller(args) {
  const instance = await requireInstance();
  const refusal = controllerRefusal(args);
  if (refusal) throw new Error(refusal);
  if (args[0] === 'login' && args.length === 1) {
    await requireRunning();
    await withLock(instance.directory, () => signInCommandLine(instance));
    process.stdout.write(`The Controller command line is signed in to ${instance.record.origin}.\n`);
    return;
  }
  process.exitCode = await runAttached(process.execPath, [controllerCli, ...args], { env: controllerEnvironment(process.env, instance), cwd: instance.workspace });
}

async function api(positionals, options) {
  const [path] = positionals;
  if (!path) throw new Error('Name an API path, for example: pnpm local api v1/remote/hosts');
  if (options.data !== undefined) {
    try { JSON.parse(options.data); }
    catch (error) { throw new Error(`--data must be JSON: ${error.message}`); }
  }
  const instance = await requireRunning();
  const result = await userApi(instance.record.origin, path, { method: options.method ?? (options.data === undefined ? 'GET' : 'POST'), data: options.data });
  process.stdout.write(result.body.endsWith('\n') ? result.body : result.body + '\n');
  if (result.status >= 400) { process.stderr.write(`HTTP ${result.status}\n`); process.exitCode = 1; }
}

async function capture(positionals, options) {
  const instance = await requireRunning();
  if (!options.out) throw new Error('Choose an output file with --out FILE.png.');
  const output = resolve(process.env.INIT_CWD ?? process.cwd(), options.out);
  await screenshot({ source, origin: instance.record.origin, path: positionals[0] ?? '/', output,
    viewport: options.viewport, waitFor: options['wait-for'], fullPage: options['full-page'] });
  process.stdout.write(`Saved ${output}\n`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'controller') await controller(rest);
  else {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      'no-build': { type: 'boolean' }, json: { type: 'boolean' }, follow: { type: 'boolean' }, yes: { type: 'boolean' },
      method: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' }, viewport: { type: 'string' },
      'wait-for': { type: 'string' }, 'full-page': { type: 'boolean' },
    } });
    if (command === 'up') await up(values);
    else if (command === 'down') await down();
    else if (command === 'status') await status(values);
    else if (command === 'logs') await logs(values);
    else if (command === 'list') await list(values);
    else if (command === 'remove') await remove(values);
    else if (command === 'api') await api(positionals, values);
    else if (command === 'screenshot') await capture(positionals, values);
    else if (!command || ['help', '--help', '-h'].includes(command)) process.stdout.write(usage);
    else {
      process.stderr.write(usage);
      process.exitCode = 1;
    }
  }
} catch (error) {
  // A cause already quoted in the message is not repeated.
  const cause = error.cause?.message && !error.message.includes(error.cause.message) ? `\nCause: ${error.cause.message}` : '';
  process.stderr.write(`${error.message}${cause}\n`);
  process.exitCode = 1;
}
