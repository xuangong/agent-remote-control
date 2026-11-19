// Process faults for the `pnpm local` instance of this checkout: stop its Controller the way a crash or a deploy would, and
// restart the instance, with or without its Relay journal store. Only the instance's own processes are touched, found from its
// own `runtime.json`, and the Controller's command line is checked against the checkout before any signal is sent.
//
// The runner ties the lifetimes together: it stops the site when its Controller exits, so a Controller fault takes the Relay
// down with it and the instance must be started again. The e2e stack (`stack/stack.ts`) stops its Controller alone.
import { execFile } from 'node:child_process';
import { readFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);

/** The Controller command line the runner starts for `source`, as `ps` prints it after the node executable. */
export const controllerCommandSuffix = source => `${join(source, 'packages/agent-controller/dist/cli.js')} foreground`;

/** The instance of the checkout the process runs in, from the development command's `--build-info` (it never signs in). */
export async function readInstance({ exec = (file, args, options) => run(file, args, options) } = {}) {
  const { stdout } = await exec('agent-remote-controller-dev', ['--build-info'], { encoding: 'utf8' });
  const info = JSON.parse(stdout);
  return { name: info.instance, directory: info.directory, origin: info.origin, source: info.source, state: info.state, workspace: join(info.directory, 'workspace') };
}

const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

async function readRuntime(instance) {
  try { return JSON.parse(await readFile(join(instance.directory, 'runtime.json'), 'utf8')); } catch { return undefined; }
}

/**
 * Stops the instance's Controller: `kill` sends SIGKILL (a crash), `graceful` sends SIGTERM (a deploy). Refuses unless the
 * recorded pid runs this checkout's Controller. Resolves once the runner has stopped the site, which it does when its
 * Controller exits. Returns how the stop went.
 */
export async function stopController(instance, { mode, ps = async pid => (await run('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })).stdout.trim(), signalProcess = (pid, signal) => process.kill(pid, signal), alive = isAlive, waitMs = 30_000, readRuntimeFile = readRuntime } = {}) {
  if (mode !== 'kill' && mode !== 'graceful') throw new Error(`Unknown Controller stop mode ${mode}.`);
  const runtime = await readRuntimeFile(instance);
  if (!runtime?.controllerPid || !runtime.runnerPid) throw new Error('The instance has no recorded runner and Controller; start it with pnpm local up.');
  const command = await ps(runtime.controllerPid).catch(() => '');
  if (!command.endsWith(controllerCommandSuffix(instance.source))) throw new Error(`Pid ${runtime.controllerPid} is not this checkout's Controller; nothing was signalled.`);
  const startedAt = Date.now();
  signalProcess(runtime.controllerPid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM');
  while (alive(runtime.runnerPid) && Date.now() - startedAt < waitMs) await delay(100);
  return { mode, controllerPid: runtime.controllerPid, runnerStopped: !alive(runtime.runnerPid), ms: Date.now() - startedAt };
}

/** The journal store files of the instance's Relay, which an "empty store" restart removes. Never anything else. */
export async function journalStoreFiles(instance) {
  const directory = join(instance.directory, 'relay', 'relay');
  const files = await readdir(directory).catch(() => []);
  return files.filter(name => /^journals\.sqlite(-wal|-shm)?$/.test(name)).map(name => join(directory, name));
}

/**
 * Restarts the instance from its existing build (`pnpm local up --no-build`) with journals on. With `journalLimits` the Relay runs
 * with those limits (`ARC_LOCAL_JOURNAL_LIMITS`); without, with its defaults, whatever the caller's own environment says. With `emptyStore` it is stopped
 * first and its Relay journal files are removed, so the Relay starts with no journals and the Controller must republish.
 * The command line is signed in again when the restart left it signed out.
 */
export async function restartInstance(instance, { checkout, emptyStore = false, journalLimits, exec = (file, args, options) => run(file, args, options), remove = rm, signInWaitMs = 20_000 } = {}) {
  const { ARC_LOCAL_JOURNAL_LIMITS: _inherited, ...inherited } = process.env;
  const env = { ...inherited, ARC_LOCAL_JOURNALS: '1', ...(journalLimits ? { ARC_LOCAL_JOURNAL_LIMITS: JSON.stringify(journalLimits) } : {}) };
  const local = (...args) => exec('pnpm', ['--silent', 'local', ...args], { cwd: checkout, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
  const startedAt = Date.now();
  let removed = [];
  if (emptyStore) {
    await local('down').catch(() => undefined);
    removed = await journalStoreFiles(instance);
    for (const file of removed) {
      if (!resolve(file).startsWith(resolve(instance.directory) + sep)) throw new Error(`Refusing to remove ${file}: it is outside the instance.`);
      await remove(file, { force: true });
    }
  }
  await local('up', '--no-build');
  const commandLine = await ensureCommandLineSignedIn({ checkout, exec, waitMs: signInWaitMs });
  return { emptyStore, removedFiles: removed.length, journalLimits: journalLimits ?? null, commandLine, ms: Date.now() - startedAt };
}

/**
 * Makes sure the instance's command line is signed in, which `up` tries once and only reports when it fails (a restart that
 * meets the site's sign-in limit, for example). It asks the user API (`host list`), not `login status`: credentials the
 * user API refuses can still pass `/auth/status`, and `login` keeps them. So a refused command line is signed out and in
 * again, waiting `waitMs` between attempts, before this gives up with an error.
 */
export async function ensureCommandLineSignedIn({ checkout, exec = (file, args, options) => run(file, args, options), attempts = 4, waitMs = 20_000, wait = delay } = {}) {
  const dev = (...args) => exec('agent-remote-controller-dev', args, { cwd: checkout, encoding: 'utf8', timeout: 60_000 });
  const accepted = async () => {
    try { await dev('host', 'list'); return true; }
    catch (error) { return !/"signed_out"/.test(String(error?.stdout ?? '')) && !/signed_out/.test(String(error?.message ?? '')) ? Promise.reject(error) : false; }
  };
  if (await accepted()) return 'signed-in';
  let failure = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { await dev('logout'); await dev('login'); } catch (error) { failure = String(error?.stdout || error?.message || error).slice(0, 300); }
    if (await accepted()) return 'signed-in-again';
    if (attempt < attempts) await wait(waitMs);
  }
  throw new Error(`The instance's command line stayed signed out after ${attempts} sign-ins${failure ? ` (${failure})` : ''}; run agent-remote-controller-dev logout, then login.`);
}

