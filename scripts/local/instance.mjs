import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

/** Instances live under one root outside every repository. */
export function localRoot(environment = process.env) {
  return environment.ARC_LOCAL_ROOT ?? join(homedir(), '.agent-remote-control-dev');
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
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function portAvailable(port) {
  const server = createServer();
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    return true;
  } catch { return false; }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
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
    record = { version: 1, name: basename(files.directory), source, port, origin: `http://localhost:${port}`, createdAt: new Date().toISOString() };
    await writeJson(files.recordFile, record);
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
    const { stdout } = await promisify(execFile)('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 5000 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

/** A recorded PID counts only while it still runs the command this instance started. */
export async function runState(directory, runtime) {
  if (!runtime) return 'stopped';
  if ((await processCommand(runtime.runnerPid))?.includes(directory)) return 'running';
  return (await processCommand(runtime.controllerPid))?.includes('cli.js foreground') ? 'orphaned' : 'stale';
}

export async function withLock(directory, action) {
  const lock = join(directory, 'operation.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(join(lock, 'owner.json')).catch(() => undefined);
    // A lock without an owner is either being created now or was left before its owner was written.
    const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
    if (owner ? processAlive(owner.pid) : age < 10_000) throw new Error('Another local command is changing this instance.');
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
  }
  await writeJson(join(lock, 'owner.json'), { pid: process.pid });
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
