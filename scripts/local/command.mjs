import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';
import { packageManager } from '../lib/package-manager.mjs';
import { controllerEnvironment } from './environment.mjs';
import { findInstance, listInstances, portAvailable, prepareInstance, processAlive, processCommand, readJson, runState, runsInstance, withLock } from './instance.mjs';
import { screenshot, signedInUser, userApi } from './session.mjs';

const source = realpathSync(resolve(import.meta.dirname, '../..'));
const controllerCli = join(source, 'packages/agent-host/dist/cli.js');
const controllerCommands = new Set(['status', 'diagnostics', 'window', 'session', 'environment', 'help', '--help', '-h', '--version']);
const usage = `Usage: pnpm local <command>
  up [--no-build]        Build, then start or restart this checkout's instance
  down                   Stop this checkout's instance; its state is kept
  status [--json]        URL, running build, local user and Controller registration
  logs [--follow]        Runner and Controller output of the current run
  list [--json]          Every local instance on this machine
  remove --yes           Delete this checkout's stopped instance
  controller <args>      Controller CLI for this instance: status, diagnostics, window, session, environment
  api <v1/path> [--method M] [--data JSON]   Signed-in JSON request to the instance
  screenshot <path> --out FILE [--viewport WxH] [--wait-for CSS] [--full-page]
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

async function runStep(command, args) {
  const [file, argv] = command === 'pnpm' ? packageManager('pnpm', args) : [command, args];
  const child = spawn(file, argv, { cwd: source, stdio: 'inherit' });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
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
}

async function startRunner(instance) {
  // A runner that fails before opening its Controller log must not leave the previous run's output looking current.
  await rm(join(instance.logs, 'controller.log'), { force: true });
  const log = await open(join(instance.logs, 'runner.log'), 'w', 0o600);
  try {
    const child = spawn(process.execPath, [join(source, 'scripts/local/runner.mjs'), instance.directory],
      { cwd: instance.directory, env: process.env, stdio: ['ignore', log.fd, log.fd], detached: true });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { await log.close(); }
}

async function waitUntilReady(instance, runnerPid) {
  const timeoutMs = Number(process.env.ARC_LOCAL_READY_TIMEOUT_MS ?? 90_000);
  const deadline = Date.now() + timeoutMs;
  let waiting = 'the site';
  while (Date.now() < deadline) {
    if (!processAlive(runnerPid)) throw new Error('The runner exited during startup.');
    // Polling avoids signing in: every sign-in counts against the instance's 30-per-minute limit.
    if (await siteAlive(instance.record.origin)) {
      waiting = 'Controller registration';
      if (await controllerUplink(instance) === 'registered') {
        await signedInUser(instance.record.origin);
        return;
      }
    }
    await delay(500);
  }
  throw new Error(`The instance did not become ready within ${timeoutMs / 1000} seconds while waiting for ${waiting}.`);
}

async function describe(instance) {
  const runtime = await readJson(instance.runtimeFile).catch(() => undefined);
  let state;
  let problem = null;
  try { state = await runState(instance.directory, runtime); }
  catch (error) { state = 'unknown'; problem = error.message; }
  const running = state === 'running';
  const [localUser, uplink, checkout] = await Promise.all([
    running ? signedInUser(instance.record.origin).catch(() => false) : false,
    running ? controllerUplink(instance) : undefined,
    controllerBuildProvenance(instance.record.source, {}).catch(() => undefined),
  ]);
  return {
    name: instance.record.name, source: instance.record.source, directory: instance.directory, origin: instance.record.origin,
    state, problem, localUser, controllerUplink: uplink ?? null,
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
    `Controller: ${report.controllerUplink ? `uplink ${report.controllerUplink}` : 'not running'}${report.build?.controllerPid ? ` (pid ${report.build.controllerPid})` : ''}`,
    `Running build: ${report.build ? `${revision(report.build)} since ${report.build.startedAt}` : 'none'}; checkout now ${revision(report.checkout)}`,
    `State: ${report.directory}`,
  ].join('\n') + '\n');
  return report;
}

async function up(options) {
  const instance = await prepareInstance(source);
  await withLock(instance.directory, async () => {
    if (options['no-build']) assertBuilt();
    else await build();
    await stopRunner(instance);
    if (!(await portAvailable(instance.record.port))) {
      throw new Error(`Port ${instance.record.port} is in use by another process. The origin ${instance.record.origin} cannot change; free the port and run up again.`);
    }
    const runnerPid = await startRunner(instance);
    try { await waitUntilReady(instance, runnerPid); }
    catch (error) {
      await stopRunnerProcess(runnerPid, instance).catch(() => undefined);
      throw new Error(`${error.message}\n${await logTails(instance, 20)}`, { cause: error.cause });
    }
  });
  await printStatus(instance, false);
}

async function down() {
  const instance = await requireInstance();
  await withLock(instance.directory, () => stopRunner(instance));
  process.stdout.write(`Stopped ${instance.record.name}. Its state remains in ${instance.directory}.\n`);
}

async function status(options) {
  const instance = await findInstance(source);
  if (!instance) {
    process.stdout.write('This checkout has no local instance. Run pnpm local up.\n');
    process.exitCode = 3;
    return;
  }
  const report = await printStatus(instance, options.json);
  if (report.state !== 'running' || !report.localUser || report.controllerUplink !== 'registered') process.exitCode = 3;
}

async function logs(options) {
  const instance = await requireInstance();
  if (!options.follow) { process.stdout.write(await logTails(instance, 80) + '\n'); return; }
  const child = spawn('tail', ['-n', '40', '-F', join(instance.logs, 'runner.log'), join(instance.logs, 'controller.log')], { stdio: 'inherit' });
  await new Promise(resolveExit => child.once('exit', resolveExit));
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
  });
  await rm(instance.directory, { recursive: true, force: true });
  process.stdout.write(`Removed ${instance.directory}. Test sessions remain in the shared native histories.\n`);
}

async function controller(args) {
  const instance = await requireInstance();
  if (!controllerCommands.has(args[0] ?? '')) {
    throw new Error('pnpm local controller runs status, diagnostics, window, session or environment. The runner owns start, stop, pairing and updates, and native subcommands could take over shared sessions.');
  }
  const child = spawn(process.execPath, [controllerCli, ...args], { env: controllerEnvironment(process.env, instance), cwd: instance.workspace, stdio: 'inherit' });
  process.exitCode = await new Promise(resolveExit => child.once('exit', code => resolveExit(code ?? 1)));
}

async function api(positionals, options) {
  const instance = await requireRunning();
  const [path] = positionals;
  if (!path) throw new Error('Name an API path, for example: pnpm local api v1/remote/hosts');
  if (options.data !== undefined) JSON.parse(options.data);
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
    else {
      process.stdout.write(usage);
      if (command && command !== 'help') process.exitCode = 1;
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}${error.cause?.message ? `\nCause: ${error.cause.message}` : ''}\n`);
  process.exitCode = 1;
}
