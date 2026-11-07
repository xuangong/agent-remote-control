import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Instances live under one root outside every repository. */
export function localRoot(environment = process.env) {
  return environment.ARC_LOCAL_ROOT ? resolve(environment.ARC_LOCAL_ROOT) : join(homedir(), '.agent-remote-control-dev');
}

/** Stable for a checkout path and readable in listings. */
export function instanceName(source) {
  const label = basename(source).replace(/[^A-Za-z0-9._-]/g, '-') || 'checkout';
  return `${label}-${createHash('sha256').update(source).digest('hex').slice(0, 8)}`;
}

export function instanceFiles(directory) {
  return {
    directory,
    recordFile: join(directory, 'instance.json'),
    runtimeFile: join(directory, 'runtime.json'),
    relay: join(directory, 'relay'),
    controller: join(directory, 'controller'),
    workspace: join(directory, 'workspace'),
    logs: join(directory, 'logs'),
  };
}

export async function readJson(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try { return JSON.parse(text); }
  catch { throw new Error(`${path} is not valid JSON.`); }
}

export async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

/** Creates the file with its full content or leaves an existing one untouched; readers never see a partial file. */
async function createJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { await link(temporary, path); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { await rm(temporary, { force: true }); }
}

/** A sandbox answers EPERM or EACCES; that is the environment refusing, not a fact about the port or the process. */
export function sandboxRefusal(error, action) {
  if (!['EPERM', 'EACCES'].includes(error?.code)) return undefined;
  return new Error(`This environment does not allow ${action} (${error.code}). Run pnpm local from a session without the sandbox (YOLO mode).`, { cause: error });
}

/** Resolves with the child once it has started. Node reports a refused spawn by throwing or by an 'error' event; both are explained. */
export async function spawnDetached(spawnProcess, file, args, options) {
  try {
    const child = spawnProcess(file, args, options);
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    return child;
  } catch (error) { throw sandboxRefusal(error, 'starting background processes') ?? error; }
}

export async function freePort() {
  const server = createServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) { throw sandboxRefusal(error, 'listening on local ports') ?? error; }
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Whether a failed listen means "taken" (false) or "nothing there to take" (true); anything else is not an answer. */
export function listenOutcome(error, host) {
  if (error.code === 'EADDRINUSE') return false;
  if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) return true;
  throw sandboxRefusal(error, 'listening on local ports') ?? error;
}

async function canListen(port, host) {
  const server = createServer();
  try { server.listen(port, host); await once(server, 'listening'); return true; }
  catch (error) { return listenOutcome(error, host); }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

/** Browsers may resolve localhost to either loopback address, so both must be free. */
export async function portAvailable(port) {
  return await canListen(port, '127.0.0.1') && await canListen(port, '::1');
}

/** The port is chosen once: the local identity is bound to the instance origin. */
export async function prepareInstance(source, environment = process.env) {
  const files = instanceFiles(join(localRoot(environment), 'instances', instanceName(source)));
  for (const directory of [files.directory, files.relay, files.controller, files.workspace, files.logs]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  let record = await readJson(files.recordFile);
  if (record && record.source !== source) throw new Error(`${files.directory} belongs to ${record.source}.`);
  if (!record) {
    const port = await freePort();
    const created = { version: 1, name: basename(files.directory), source, port, origin: `http://localhost:${port}`, createdAt: new Date().toISOString() };
    record = await createJson(files.recordFile, created) ? created : await readJson(files.recordFile);
  }
  return { ...files, record };
}

export async function findInstance(source, environment = process.env) {
  const files = instanceFiles(join(localRoot(environment), 'instances', instanceName(source)));
  const record = await readJson(files.recordFile);
  return record?.source === source ? { ...files, record } : undefined;
}

export async function listInstances(environment = process.env) {
  const root = join(localRoot(environment), 'instances');
  let names;
  try { names = await readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const instances = [];
  for (const name of names.sort()) {
    const files = instanceFiles(join(root, name));
    const record = await readJson(files.recordFile).catch(() => undefined);
    if (record) instances.push({ ...files, record, runtime: await readJson(files.runtimeFile).catch(() => undefined) });
  }
  return instances;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function processCommand(pid) {
  if (!processAlive(pid)) return undefined;
  try {
    const { stdout } = await exec('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 15_000 });
    return stdout.trim() || undefined;
  } catch (error) {
    // ps exits 1 when the process is gone; anything else leaves the state unknown, not stopped.
    if (error.code === 1) return undefined;
    throw new Error(`Could not inspect process ${pid}: ${error.message}`);
  }
}

/** The runner is started as `node <checkout>/scripts/local/runner.mjs <directory>`. */
export function runsInstance(command, directory) {
  return Boolean(command?.includes('scripts/local/runner.mjs') && command.endsWith(` ${directory}`));
}

/** A recorded PID counts only while it still runs the command this instance started. */
export async function runState(directory, runtime) {
  if (!runtime) return 'stopped';
  if (runsInstance(await processCommand(runtime.runnerPid), directory)) return 'running';
  // Runs record the Controller script they started; an older record only names it as cli.js.
  return (await processCommand(runtime.controllerPid))?.includes(`${runtime.controllerScript ?? 'cli.js'} foreground`) ? 'orphaned' : 'stale';
}

const lockSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Operations on one instance run one at a time; a lock left by a killed command is reported, not taken over. */
export async function withLock(directory, action) {
  const lock = join(directory, 'operation.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(join(lock, 'owner.json')).catch(() => undefined);
    if (Number.isInteger(owner?.pid) && !processAlive(owner.pid)) {
      throw new Error(`A previous local command (pid ${owner.pid}) was interrupted and left its lock. Remove ${lock} and retry.`);
    }
    throw new Error(`Another local command is changing this instance. If none is running, remove ${lock}.`);
  }
  const release = () => rmSync(lock, { recursive: true, force: true });
  const interrupted = signal => { release(); process.kill(process.pid, signal); };
  for (const signal of lockSignals) process.once(signal, interrupted);
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }) + '\n', { mode: 0o600 });
    return await action();
  } finally {
    for (const signal of lockSignals) process.off(signal, interrupted);
    release();
  }
}
