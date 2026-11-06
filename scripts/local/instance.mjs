import { execFile } from 'node:child_process';
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
  await rename(temporary, path);
}

/** Creates the file with its full content or leaves an existing one untouched; readers never see a partial file. */
async function createJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { await link(temporary, path); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { await rm(temporary, { force: true }); }
}

export async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function canListen(port, host) {
  const server = createServer();
  try { server.listen(port, host); await once(server, 'listening'); return true; }
  catch (error) { return host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code); }
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

/** A recorded PID counts only while it still runs the command this instance started. */
export async function runState(directory, runtime) {
  if (!runtime) return 'stopped';
  const runner = await processCommand(runtime.runnerPid);
  if (runner?.includes('scripts/local/runner.mjs') && runner.endsWith(` ${directory}`)) return 'running';
  return (await processCommand(runtime.controllerPid))?.includes('cli.js foreground') ? 'orphaned' : 'stale';
}

/** Operations on one instance run one at a time; a lock left by a killed command is reported, not taken over. */
export async function withLock(directory, action) {
  const lock = join(directory, 'operation.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another local command is changing this instance. If none is running, remove ${lock}.`);
  }
  const release = () => rmSync(lock, { recursive: true, force: true });
  const interrupted = signal => { release(); process.kill(process.pid, signal); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try { return await action(); }
  finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    release();
  }
}
