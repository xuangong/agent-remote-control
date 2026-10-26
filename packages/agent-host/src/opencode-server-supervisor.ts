import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { nativeInvocation } from './platform/executables/index.js';
import { resolveOpenCodeExecutable } from './opencode-executable.js';
import { probeOpenCodeServer } from './opencode-server-state.js';
import { spawnWindowsJob } from './platform/processes/windows-job.js';

const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
// A killed tree only has to be reaped, but a loaded machine can take seconds to do that.
const KILL_CONFIRMATION_MS = 3_000;
const CONTROL_TIMEOUT_MS = 2_000;
const MAX_CONTROL_BYTES = 2_048;
const MAX_NATIVE_LINE_BYTES = 8_192;
type NativeExit = { code: number | null; signal: NodeJS.Signals | null; spawnError?: true };

async function preferenceRevision(directory: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, 'prefs.json'), 'utf8'));
    return value.enabled === true && typeof value.revision === 'string' ? value.revision : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'initial';
    return undefined;
  }
}
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
function validToken(value: unknown, token: string): boolean {
  if (typeof value !== 'string' || value.length !== token.length) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function controlBody(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_CONTROL_BYTES) throw new Error('Control request too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Owns one native process independently of the Controller's connection lifecycle. */
export async function serveOpenCodeServerSupervisor(directory: string, environment: NodeJS.ProcessEnv): Promise<void> {
  let config: { url: string; username: string; password: string };
  let endpoint: URL;
  try {
    config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    endpoint = new URL(config.url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || config.username !== 'opencode' || typeof config.password !== 'string' || !config.password) throw new Error();
  } catch { throw new Error('The managed OpenCode server configuration is invalid.'); }
  const expectedRevision = environment.AGENT_HOST_OPENCODE_START_REVISION ?? 'initial';
  const generation = randomUUID();
  const token = randomBytes(32).toString('hex');
  const marker = join(directory, `starting-${generation}.json`);
  let child: ChildProcess | undefined;
  let exited: NativeExit | undefined;
  let finishNative!: (exit: NativeExit) => void;
  const nativeExit = new Promise<NativeExit>(resolve => { finishNative = resolve; });
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let ready = false;
  let version = '';
  let nativePid = 0;
  let managementPort = 0;
  let announced = false;
  let wrongEndpoint = false;
  let nativeLine = '';
  const identity = () => ({ pid: process.pid, generation, url: config.url, managementPort });
  const status = () => ready && !stopping && !exited
    ? { running: true, ...identity(), nativePid, version }
    : { running: false, phase: stopping ? 'stopping' : 'starting', ...identity() };
  const signalNative = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else if (!exited) child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('The managed OpenCode process could not be signalled.');
    }
  };
  const treeStopped = () => {
    if (!child?.pid) return !!exited || !child;
    if (!exited) return false;
    if (process.platform === 'win32') return true;
    try { process.kill(-child.pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw new Error('The managed OpenCode process group could not confirm that it stopped.');
    }
  };
  const waitForTree = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!treeStopped()) {
      if (Date.now() >= deadline) return false;
      await delay(25);
    }
    return true;
  };
  const stop = (): Promise<void> => {
    stopping = true;
    return stopPromise ??= (async () => {
      if (treeStopped()) return;
      signalNative('SIGTERM');
      if (await waitForTree(STOP_TIMEOUT_MS)) return;
      signalNative('SIGKILL');
      if (!await waitForTree(KILL_CONFIRMATION_MS)) throw new Error('The managed OpenCode process tree did not confirm that it stopped.');
    })();
  };
  const handleSignal = () => { void stop().catch(() => undefined); };
  const assertStartupAllowed = async () => {
    const revision = await preferenceRevision(directory);
    if (stopping || revision !== expectedRevision) throw new Error('Managed OpenCode startup was superseded or disabled.');
  };
  const management = createServer({ headersTimeout: CONTROL_TIMEOUT_MS, requestTimeout: CONTROL_TIMEOUT_MS, connectionsCheckingInterval: 500 }, (request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/control') { reply(response, 404, { error: 'not_found' }); return; }
      const deadline = setTimeout(() => request.destroy(), CONTROL_TIMEOUT_MS);
      let body: unknown;
      try { body = await controlBody(request); } catch { if (!response.destroyed) reply(response, 400, { error: 'invalid_request' }); return; }
      finally { clearTimeout(deadline); }
      if (!body || typeof body !== 'object' || !validToken((body as { token?: unknown }).token, token)) { reply(response, 403, { error: 'forbidden' }); return; }
      const action = (body as { action?: unknown }).action;
      if (action === 'status') { reply(response, 200, status()); return; }
      if (action !== 'stop') { reply(response, 400, { error: 'invalid_action' }); return; }
      try { await stop(); reply(response, 200, { running: false }); }
      catch { reply(response, 503, { error: 'stop_unconfirmed' }); }
    })().catch(() => { if (!response.destroyed) reply(response, 500, { error: 'control_failed' }); });
  });
  management.maxHeadersCount = 20;
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
  try {
    await new Promise<void>((resolve, reject) => { management.once('error', reject); management.listen(0, '127.0.0.1', resolve); });
    managementPort = (management.address() as { port: number }).port;
    await atomicWriteFile(marker, JSON.stringify({ ...identity(), token }) + '\n');
    await assertStartupAllowed();
    const env = { ...sanitizeNativeEnvironment(environment), OPENCODE_PASSWORD: config.password };
    const executable = resolveOpenCodeExecutable({ ...env, AGENT_HOST_OPENCODE: environment.AGENT_HOST_OPENCODE });
    const invocation = nativeInvocation(executable, ['serve', '--hostname', endpoint.hostname.replace(/^\[|\]$/g, ''), '--port', endpoint.port]);
    // The job owns native descendants and watches this supervisor, not the Controller.
    child = process.platform === 'win32' ? spawnWindowsJob(...invocation, { cwd: process.cwd(), env })
      : spawn(...invocation, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdin?.end();
    const completeNative = (result: NativeExit) => { if (!exited) { exited = result; finishNative(result); } };
    child.once('error', () => completeNative({ code: null, signal: null, spawnError: true }));
    child.once('exit', (code, signal) => completeNative({ code, signal }));
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      nativeLine += chunk;
      let end: number;
      while ((end = nativeLine.indexOf('\n')) !== -1) {
        const line = nativeLine.slice(0, end).replace(/\x1b\[[0-9;]*m/g, '').trim();
        nativeLine = nativeLine.slice(end + 1);
        const match = /^server listening on (http:\/\/\S+)$/.exec(line);
        if (!match) continue;
        try { if (new URL(match[1]!).toString() === endpoint.toString()) announced = true; else wrongEndpoint = true; }
        catch { wrongEndpoint = true; }
      }
      if (nativeLine.length > MAX_NATIVE_LINE_BYTES) nativeLine = nativeLine.slice(-MAX_NATIVE_LINE_BYTES);
    });
    // Native output may contain credentials; drain it without copying it to diagnostics.
    child.stderr!.resume();
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await assertStartupAllowed();
      if (exited) throw new Error('OpenCode exited before its managed server became ready.');
      if (wrongEndpoint) throw new Error('OpenCode did not bind the requested local endpoint.');
      if (announced) {
        const info = await probeOpenCodeServer(config.url, { AGENT_HOST_OPENCODE_USERNAME: config.username, AGENT_HOST_OPENCODE_PASSWORD: config.password });
        if (info.running) {
          // Windows launches through an owned Job Object wrapper; the API reports its native child.
          if (info.nativePid <= 0 || process.platform !== 'win32' && info.nativePid !== child.pid)
            throw new Error('OpenCode server identity does not match the owned native process.');
          version = info.version;
          nativePid = info.nativePid;
          break;
        }
      }
      await within(nativeExit, 100);
    }
    if (!version) throw new Error('The managed OpenCode server did not become ready within 15 seconds.');
    await assertStartupAllowed();
    if (exited) throw new Error('OpenCode exited before its managed server became ready.');
    ready = true;
    await atomicWriteFile(join(directory, 'owner.json'), JSON.stringify({ ...status(), token }) + '\n');
    // Published readiness admits normal stop requests, including during the owner write.
    const publishedRevision = await preferenceRevision(directory);
    if (!stopping && publishedRevision !== expectedRevision) throw new Error('Managed OpenCode startup was superseded or disabled.');
    const result = await nativeExit;
    if (!stopping && (result.spawnError || result.code !== 0)) throw new Error('The managed OpenCode server exited unexpectedly.');
  } finally {
    process.off('SIGTERM', handleSignal);
    process.off('SIGINT', handleSignal);
    try { await stop(); }
    finally {
      await rm(marker, { force: true });
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { management.closeAllConnections(); resolve(); }, 1000);
        management.close(() => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
