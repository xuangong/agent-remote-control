import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { containerEnvironment } from '../controller/entrypoint.mjs';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';
import { controllerEnvironment } from './environment.mjs';
import { instanceFiles, readJson, writeJson } from './instance.mjs';

/** Settles like the promise, but rejects with the signal's reason as soon as the signal aborts. */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((settle, fail) => {
    const onAbort = () => fail(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // Attached either way, so a promise that loses the race cannot become an unhandled rejection.
    promise.then(settle, fail).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One runner owns one instance: the site first, then the Controller paired with it.
 * `runtime.json` exists from the first moment, so a runner that is still starting can be seen and stopped;
 * aborting `signal` ends a start that has not spawned the Controller yet.
 */
export async function startInstance({ directory, environment = process.env, createServer, controllerScript, signal, stopGraceMs = 15_000 }) {
  const files = instanceFiles(directory);
  const record = await readJson(files.recordFile);
  if (!record) throw new Error(`${directory} has no instance record.`);
  const script = controllerScript ?? join(record.source, 'packages/agent-host/dist/cli.js');
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  await writeJson(files.runtimeFile, { version: 1, runnerPid: process.pid, startedAt });
  let server;
  let child;
  let exited;
  let spawnError;
  try {
    // Refused before anything is served or spawned: a state directory saved for another origin cannot be reused.
    const parentEnvironment = controllerEnvironment(environment, { ...files, record });
    let native;
    try { native = await containerEnvironment({ ...parentEnvironment, AGENT_HOST_SERVER: record.origin }); }
    catch (error) {
      // Only the origin mismatch is cured by removing the instance; an unreadable or invalid file needs a look, not a wipe.
      throw new Error(/another Relay/.test(error.message)
        ? "This instance's Controller state belongs to another site origin. Remove the instance with pnpm local remove --yes."
        : `The instance's saved Controller connection is unreadable (${error.message}). Check ${join(files.controller, 'connection.json')}.`, { cause: error });
    }
    signal?.throwIfAborted();
    const factory = createServer ?? (await import(pathToFileURL(join(record.source, 'dist/devbox/server.mjs')).href)).createDevboxServer;
    server = await factory({ origin: record.origin, stateDir: files.relay,
      webDist: environment.ARC_LOCAL_WEB_DIST ?? join(record.source, 'dist/relay/web') });
    await server.listen(record.port, '127.0.0.1');
    // A saved device credential removed the server above; only a first start needs an invitation.
    const [invitation, provenance] = await abortable(Promise.all([
      native.AGENT_HOST_SERVER ? server.getConnection() : undefined,
      controllerBuildProvenance(record.source, {}).catch(() => ({ revision: 'unknown', dirty: true })),
    ]), signal);
    if (native.AGENT_HOST_SERVER) {
      if (invitation?.serverUrl !== record.origin || typeof invitation.remoteKey !== 'string' || !invitation.remoteKey) {
        throw new Error('The local site did not return a matching Controller invitation.');
      }
      native.AGENT_HOST_REMOTE_KEY = invitation.remoteKey;
    }
    signal?.throwIfAborted();
    const log = await open(join(files.logs, 'controller.log'), 'w', 0o600);
    try {
      // The last check and the spawn are adjacent, so an aborted start never spawns the Controller.
      signal?.throwIfAborted();
      child = spawn(process.execPath, [script, 'foreground'],
        { env: native, cwd: files.workspace, stdio: ['ignore', log.fd, log.fd], detached: true });
      // Listen before any await: a Controller that fails to spawn or exits at once must still end the runner,
      // and an 'error' event without a listener would crash it.
      child.on('error', error => { spawnError ??= error; });
      exited = new Promise(resolveExit => child.once('close', code => resolveExit(spawnError ? 1 : code ?? 1)));
    } finally { await log.close(); }
    if (child.pid === undefined) { await exited; throw spawnError; }
    await writeJson(files.runtimeFile, { version: 1, runnerPid: process.pid, controllerPid: child.pid, controllerScript: script,
      revision: provenance.revision, dirty: provenance.dirty, startedAt });
  } catch (error) {
    if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { await server?.close(); } catch {}
    await rm(files.runtimeFile, { force: true }).catch(() => {});
    throw error;
  }
  let stopping = false;
  let timer;
  const done = exited.then(async code => {
    clearTimeout(timer);
    // The Controller leads its own process group: whatever it left running goes with it.
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { await server.close(); }
    finally { await rm(files.runtimeFile, { force: true }).catch(() => {}); }
    if (stopping) return 0;
    process.stderr.write(`Controller exited with code ${code}; the site was stopped.\n`);
    return code || 1;
  });
  return {
    origin: record.origin,
    controllerPid: child.pid,
    done,
    async close() {
      if (!stopping && child.exitCode === null && child.signalCode === null) {
        stopping = true;
        child.kill('SIGTERM');
        // A Controller that ignores the request is killed together with everything it started.
        timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, stopGraceMs);
        timer.unref();
      }
      return done;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    process.stderr.write('Usage: node scripts/local/runner.mjs <instance directory>\n');
    process.exit(1);
  }
  const abort = new AbortController();
  let running;
  let interrupted = false;
  const stop = () => { interrupted = true; abort.abort(); running?.close().catch(() => undefined); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let code;
  try {
    running = await startInstance({ directory: resolve(process.argv[2]), signal: abort.signal });
    // A stop that landed while the Controller was being spawned could no longer abort the start.
    if (interrupted) await running.close();
    else process.stdout.write(`Serving ${running.origin}; Controller pid ${running.controllerPid}.\n`);
    code = await running.done;
  } catch (error) {
    if (abort.signal.aborted && error === abort.signal.reason) code = 0;
    else {
      process.stderr.write(`${error.stack ?? error.message}\n${error.cause ? `Caused by: ${error.cause.message}\n` : ''}`);
      code = 1;
    }
  }
  // The site may leave handles open after close(); nothing is left for the runner to do.
  process.exit(code);
}
