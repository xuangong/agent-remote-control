import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { containerEnvironment } from '../controller/entrypoint.mjs';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';
import { controllerEnvironment } from './environment.mjs';
import { instanceFiles, readJson, writeJson } from './instance.mjs';

/** One runner owns one instance: the site first, then the Controller paired with it. */
export async function startInstance({ directory, environment = process.env, createServer, controllerScript, stopGraceMs = 15_000 }) {
  const files = instanceFiles(directory);
  const record = await readJson(files.recordFile);
  if (!record) throw new Error(`${directory} has no instance record.`);
  const factory = createServer ?? (await import(pathToFileURL(join(record.source, 'dist/devbox/server.mjs')).href)).createDevboxServer;
  const server = await factory({ origin: record.origin, stateDir: files.relay,
    webDist: environment.ARC_LOCAL_WEB_DIST ?? join(record.source, 'dist/relay/web') });
  let child;
  let exited;
  let spawnError;
  let written = Promise.resolve();
  try {
    await server.listen(record.port, '127.0.0.1');
    const native = await containerEnvironment({ ...controllerEnvironment(environment, { ...files, record }), AGENT_HOST_SERVER: record.origin });
    // A saved device credential removes the server; only a first start needs an invitation.
    if (native.AGENT_HOST_SERVER) native.AGENT_HOST_REMOTE_KEY = (await server.getConnection()).remoteKey;
    const provenance = await controllerBuildProvenance(record.source, {}).catch(() => ({ revision: 'unknown', dirty: true }));
    const log = await open(join(files.logs, 'controller.log'), 'w', 0o600);
    try {
      child = spawn(process.execPath, [controllerScript ?? join(record.source, 'packages/agent-host/dist/cli.js'), 'foreground'],
        { env: native, cwd: files.workspace, stdio: ['ignore', log.fd, log.fd], detached: true });
      // Listen before any await: a Controller that fails to spawn or exits at once must still end the runner,
      // and an 'error' event without a listener would crash it.
      child.on('error', error => { spawnError ??= error; });
      exited = new Promise(resolveExit => child.once('close', code => resolveExit(spawnError ? 1 : code ?? 1)));
    } finally { await log.close(); }
    if (child.pid === undefined) { await exited; throw spawnError; }
    written = writeJson(files.runtimeFile, { version: 1, runnerPid: process.pid, controllerPid: child.pid,
      revision: provenance.revision, dirty: provenance.dirty, startedAt: new Date().toISOString() });
    await written;
  } catch (error) {
    if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { await server.close(); } catch {}
    await rm(files.runtimeFile, { force: true });
    throw error;
  }
  let stopping = false;
  let timer;
  const done = exited.then(async code => {
    clearTimeout(timer);
    try { await server.close(); }
    finally {
      await written.catch(() => undefined);
      await rm(files.runtimeFile, { force: true });
    }
    return stopping ? 0 : code || 1;
  });
  return {
    origin: record.origin,
    controllerPid: child.pid,
    done,
    async close() {
      if (!stopping && child.exitCode === null && child.signalCode === null) {
        stopping = true;
        child.kill('SIGTERM');
        // The Controller leads its own process group, so the fallback also reaches everything it started.
        timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, stopGraceMs);
        timer.unref();
      }
      return done;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let running;
  let interrupted = false;
  const stop = () => { interrupted = true; running?.close().catch(() => undefined); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    running = await startInstance({ directory: resolve(process.argv[2]) });
    if (interrupted) await running.close();
    else process.stdout.write(`Serving ${running.origin}; Controller pid ${running.controllerPid}.\n`);
    process.exitCode = await running.done;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
