import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareInstance, runState } from './instance.mjs';
import { startInstance } from './runner.mjs';

const runnerScript = fileURLToPath(new URL('./runner.mjs', import.meta.url));

// Registers its stop handler and saves the issued credential before announcing the start.
const fakeController = `import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = process.env.AGENT_HOST_STATE_DIR;
if (process.argv[2] !== 'foreground') process.exit(5);
process.on('SIGTERM', async () => { await writeFile(join(state, 'stopped'), 'yes'); process.exit(0); });
await mkdir(state, { recursive: true });
try { await stat(join(state, 'exit-now')); process.exit(7); } catch {}
if (process.env.AGENT_HOST_REMOTE_KEY) {
  await writeFile(join(state, 'connection.json'), JSON.stringify({ serverUrl: process.env.AGENT_HOST_SERVER, remoteKey: 'issued-device', environment: {} }));
}
await appendFile(join(state, 'starts.jsonl'), JSON.stringify({ env: process.env, cwd: process.cwd() }) + '\\n');
setInterval(() => {}, 1000);
`;

// Leaves a descendant in its process group; files in its state directory select how it ends.
const leavesGrandchild = `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = process.env.AGENT_HOST_STATE_DIR;
process.on('SIGTERM', existsSync(join(state, 'ignore-stop')) ? () => {} : () => process.exit(0));
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await mkdir(state, { recursive: true });
await writeFile(join(state, 'grandchild'), String(grandchild.pid));
if (existsSync(join(state, 'exit-now'))) process.exit(3);
setInterval(() => {}, 1000);
`;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitUntil(condition, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

const exists = path => stat(path).then(() => true, () => false);

/** The runner's own report of an unrequested Controller exit is asserted, not printed into the test output. */
function captureStderr(t) {
  const written = [];
  t.mock.method(process.stderr, 'write', chunk => { written.push(String(chunk)); return true; });
  return written;
}

async function fixture(t, controller = fakeController) {
  const root = await mkdtemp(join(tmpdir(), 'arc-local-runner-'));
  const cleanups = [];
  // Cleanups run last-registered first, and every process is gone before the directory it runs in is removed.
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  const controllerScript = join(root, 'controller.mjs');
  await writeFile(controllerScript, controller);
  const environment = { ARC_LOCAL_ROOT: join(root, 'local'), HOME: join(root, 'home'), PATH: '/usr/bin:/bin', TMPDIR: tmpdir(),
    AGENT_HOST_TRUSTED_FULL_CONTROL: '1', CLAUDECODE: '1' };
  const instance = await prepareInstance(join(root, 'checkout'), environment);
  let invitations = 0;
  let listens = 0;
  const closed = [];
  const received = [];
  const behaviour = {};
  const createServer = async options => {
    received.push(options);
    assert.equal(options.origin, instance.record.origin);
    assert.equal(options.stateDir, instance.relay);
    const server = createHttpServer((_request, response) => response.end('ready'));
    return {
      listen: (port, bind) => new Promise((resolve, reject) => { listens++; server.once('error', reject); server.listen(port, bind, resolve); }),
      close: () => new Promise(resolve => { closed.push(true); server.close(() => resolve()); }),
      getConnection: async () => {
        invitations++;
        return behaviour.invite ? behaviour.invite(options.origin) : { serverUrl: options.origin, remoteKey: 'one-time-invite' };
      },
    };
  };
  const starts = async () => (await readFile(join(instance.controller, 'starts.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const waitForStarts = async count => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const seen = await starts();
      if (seen.length >= count) return seen;
      await delay(20);
    }
    throw new Error('The Controller fixture did not start.');
  };
  const start = async options => {
    const running = await startInstance({ directory: instance.directory, environment, createServer, controllerScript, ...options });
    let finished = false;
    running.done.then(() => { finished = true; }, () => { finished = true; });
    cleanups.push(async () => {
      if (!finished) try { process.kill(-running.controllerPid, 'SIGKILL'); } catch {}
      await running.done.catch(() => {});
    });
    return running;
  };
  /** Waits for the Controller's descendant and makes sure it cannot outlive the test. */
  const grandchild = async () => {
    const pid = Number(await waitUntil(() => readFile(join(instance.controller, 'grandchild'), 'utf8').catch(() => ''), 'The descendant did not start.'));
    cleanups.push(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
    return pid;
  };
  return { root, environment, instance, closed, received, behaviour, waitForStarts, grandchild, start,
    invitations: () => invitations, listens: () => listens, onCleanup: cleanup => cleanups.push(cleanup) };
}

test('pairs once, then restarts with the saved device credential', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let running = await f.start();
  assert.equal(await (await fetch(running.origin.replace('localhost', '127.0.0.1'))).text(), 'ready');
  const [first] = await f.waitForStarts(1);
  assert.equal(first.env.AGENT_HOST_REMOTE_KEY, 'one-time-invite');
  assert.equal(first.env.AGENT_HOST_SERVER, f.instance.record.origin);
  assert.equal(first.env.AGENT_HOST_ALLOWED_WORKSPACE_ROOTS, JSON.stringify([f.instance.workspace]));
  assert.equal(first.env.AGENT_HOST_TRUSTED_FULL_CONTROL, '0');
  assert.equal(first.env.CLAUDECODE, undefined);
  assert.equal(first.cwd, await realpath(f.instance.workspace));
  const runtime = JSON.parse(await readFile(f.instance.runtimeFile, 'utf8'));
  assert.equal(runtime.version, 1);
  assert.equal(runtime.runnerPid, process.pid);
  assert.equal(runtime.controllerPid, running.controllerPid);
  assert.equal(runtime.controllerScript, join(f.root, 'controller.mjs'));
  // The stand-in checkout is not a git repository, so its build identity is unknown.
  assert.equal(runtime.revision, 'unknown');
  assert.equal(runtime.dirty, true);
  assert.ok(Number.isFinite(Date.parse(runtime.startedAt)));
  assert.equal(await running.close(), 0);
  assert.equal(await readFile(join(f.instance.controller, 'stopped'), 'utf8'), 'yes');
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });

  running = await f.start();
  const [, second] = await f.waitForStarts(2);
  assert.equal(second.env.AGENT_HOST_REMOTE_KEY, undefined);
  assert.equal(second.env.AGENT_HOST_SERVER, undefined);
  assert.equal(f.invitations(), 1);
  assert.equal(await running.close(), 0);
});

test('hands the site its state directory and the built web files', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await (await f.start()).close();
  assert.equal(f.received[0].webDist, join(f.instance.record.source, 'dist/relay/web'));
  await (await f.start({ environment: { ...f.environment, ARC_LOCAL_WEB_DIST: '/elsewhere/web' } })).close();
  assert.equal(f.received[1].webDist, '/elsewhere/web');
});

test('stops serving when the Controller exits on its own', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const stderr = captureStderr(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  assert.equal(await running.done, 7);
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.deepEqual(stderr, ['Controller exited with code 7; the site was stopped.\n']);
});

test('close after the Controller already exited reports its code', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  captureStderr(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  assert.equal(await running.done, 7);
  assert.equal(await running.close(), 7);
  assert.equal(await running.close(), 7);
  assert.equal(f.closed.length, 1);
});

test('kills the whole Controller process group when it ignores the stop request', { timeout: 30000 }, async t => {
  const f = await fixture(t, leavesGrandchild);
  await writeFile(join(f.instance.controller, 'ignore-stop'), '');
  const running = await f.start({ stopGraceMs: 200 });
  const grandchild = await f.grandchild();
  assert.equal(alive(grandchild), true);
  assert.equal(await running.close(), 0);
  await waitUntil(() => !alive(grandchild), 'The descendant survived the stop.');
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('sweeps the Controller process group after it stops on request', { timeout: 30000 }, async t => {
  const f = await fixture(t, leavesGrandchild);
  const running = await f.start();
  const grandchild = await f.grandchild();
  assert.equal(await running.close(), 0);
  await waitUntil(() => !alive(grandchild), 'The descendant of a Controller that stopped cleanly survived.');
});

test('sweeps the Controller process group after it exits on its own', { timeout: 30000 }, async t => {
  const f = await fixture(t, leavesGrandchild);
  captureStderr(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  const grandchild = await f.grandchild();
  assert.equal(await running.done, 3);
  await waitUntil(() => !alive(grandchild), 'The descendant of a Controller that exited survived.');
});

test('a Controller that cannot be spawned ends the start and leaves nothing behind', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await rm(f.instance.workspace, { recursive: true });
  await assert.rejects(f.start(), /ENOENT/);
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('a site that cannot listen is closed and the start fails', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const occupied = createHttpServer();
  await new Promise(resolve => occupied.listen(f.instance.record.port, '127.0.0.1', resolve));
  f.onCleanup(() => new Promise(resolve => occupied.close(() => resolve())));
  await assert.rejects(f.start(), { code: 'EADDRINUSE' });
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('refuses an invitation for another site or without a key', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const { origin } = f.instance.record;
  for (const invitation of [{ serverUrl: 'http://localhost:1', remoteKey: 'key' }, { serverUrl: origin, remoteKey: '' }, { serverUrl: origin }, undefined]) {
    f.behaviour.invite = () => invitation;
    await assert.rejects(f.start(), /The local site did not return a matching Controller invitation\./);
  }
  assert.equal(f.closed.length, 4);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);
});

test('refuses Controller state saved for another site before serving or spawning', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.instance.controller, 'connection.json'),
    JSON.stringify({ serverUrl: 'http://localhost:1', remoteKey: 'saved-device', environment: {} }));
  await assert.rejects(f.start(), error => error.message === "This instance's Controller state belongs to another site origin. Remove the instance with pnpm local remove --yes."
    && /another Relay/.test(error.cause?.message));
  assert.equal(f.listens(), 0);
  assert.equal(f.invitations(), 0);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);
});

test('names an unusable saved Controller connection instead of blaming the origin', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const connection = join(f.instance.controller, 'connection.json');
  for (const content of ['{}', 'not json', JSON.stringify({ serverUrl: 'http://localhost:1', remoteKey: '' })]) {
    await writeFile(connection, content);
    await assert.rejects(f.start(), error => {
      assert.match(error.message, /^The instance's saved Controller connection is unreadable \(.+\)\. Check .*connection\.json\.$/);
      assert.ok(error.message.includes(connection), error.message);
      assert.doesNotMatch(error.message, /another site origin|pnpm local remove/);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
  assert.equal(f.listens(), 0);
  assert.equal(f.invitations(), 0);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);
});

test('an aborted start closes the site, removes the runtime file and never spawns the Controller', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.behaviour.invite = () => { abort.abort(); return new Promise(() => {}); };
  await assert.rejects(f.start({ signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await exists(join(f.instance.logs, 'controller.log')), false);

  // A start that is stopped before it began does nothing at all.
  f.received.length = 0;
  await assert.rejects(f.start({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(f.received.length, 0);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

// The command-line entry, run the way `pnpm local up` runs it, against a stand-in checkout.
const standInSite = `import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export async function createDevboxServer({ origin, stateDir }) {
  const server = createServer((_request, response) => response.end('ready'));
  // The real site can leave handles open after close(); the runner must still exit.
  setInterval(() => {}, 1000);
  return {
    listen: (port, bind) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); }),
    close: () => new Promise(resolve => server.close(() => resolve())),
    getConnection: async () => {
      await writeFile(join(stateDir, 'inviting'), '');
      await delay(Number(process.env.FIXTURE_INVITE_DELAY));
      return { serverUrl: origin, remoteKey: 'one-time-invite' };
    },
  };
}
`;

async function commandLine(t, { inviteDelayMs = 0, beforeStart } = {}) {
  const f = await fixture(t);
  const checkout = join(f.root, 'checkout');
  await mkdir(join(checkout, 'dist/devbox'), { recursive: true });
  await mkdir(join(checkout, 'packages/agent-host/dist'), { recursive: true });
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
  await writeFile(join(checkout, 'dist/devbox/server.mjs'), standInSite);
  await writeFile(join(checkout, 'packages/agent-host/dist/cli.js'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.AGENT_HOST_STATE_DIR + '/pid', String(process.pid));\n` + fakeController);
  await beforeStart?.(f);
  const child = spawn(process.execPath, [runnerScript, f.instance.directory],
    { env: { ...f.environment, FIXTURE_INVITE_DELAY: String(inviteDelayMs) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  // 'close' rather than 'exit': the output is complete once the streams have ended.
  const exit = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  const controllerPid = () => readFile(join(f.instance.controller, 'pid'), 'utf8').then(Number, () => undefined);
  f.onCleanup(async () => { const pid = await controllerPid(); if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  f.onCleanup(() => child.kill('SIGKILL'));
  const promptly = async () => {
    const result = await Promise.race([exit, delay(5000).then(() => 'still running')]);
    assert.notEqual(result, 'still running', 'The runner did not exit promptly.');
    return result;
  };
  return { f, child, exit, promptly, output: () => output, controllerPid };
}

test('a stop during startup never spawns the Controller and exits at once', { timeout: 30000 }, async t => {
  const c = await commandLine(t, { inviteDelayMs: 60_000 });
  await waitUntil(() => exists(join(c.f.instance.relay, 'inviting')), 'The runner did not reach the invitation.');
  // The instance is visible, and stoppable, from the first moment.
  const runtime = JSON.parse(await readFile(c.f.instance.runtimeFile, 'utf8'));
  assert.deepEqual(Object.keys(runtime).sort(), ['runnerPid', 'startedAt', 'version']);
  assert.equal(runtime.runnerPid, c.child.pid);
  assert.equal(await runState(c.f.instance.directory, runtime), 'running');
  c.child.kill('SIGTERM');
  assert.deepEqual(await c.promptly(), { code: 0, signal: null });
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
  assert.equal(await c.controllerPid(), undefined);
  assert.equal(await exists(join(c.f.instance.controller, 'starts.jsonl')), false);
  assert.equal(await exists(join(c.f.instance.logs, 'controller.log')), false);
  await assert.rejects(fetch(c.f.instance.record.origin.replace('localhost', '127.0.0.1')));
});

test('a stop sent to a running runner stops the Controller even if the site leaves handles open', { timeout: 30000 }, async t => {
  const c = await commandLine(t);
  await waitUntil(() => /Serving /.test(c.output()), 'The runner did not report that it was serving.');
  await c.f.waitForStarts(1);
  const pid = await c.controllerPid();
  assert.match(c.output(), new RegExp(`Controller pid ${pid}\\.`));
  const runtime = JSON.parse(await readFile(c.f.instance.runtimeFile, 'utf8'));
  assert.equal(runtime.runnerPid, c.child.pid);
  assert.equal(runtime.controllerPid, pid);
  assert.equal(await runState(c.f.instance.directory, runtime), 'running');
  c.child.kill('SIGTERM');
  assert.deepEqual(await c.promptly(), { code: 0, signal: null });
  assert.equal(await readFile(join(c.f.instance.controller, 'stopped'), 'utf8'), 'yes');
  assert.equal(alive(pid), false);
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
});

test('reports a Controller that exits on its own and exits with its code', { timeout: 30000 }, async t => {
  const c = await commandLine(t, { beforeStart: f => writeFile(join(f.instance.controller, 'exit-now'), '') });
  assert.deepEqual(await c.promptly(), { code: 7, signal: null });
  assert.match(c.output(), /Controller exited with code 7; the site was stopped\./);
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
  await assert.rejects(fetch(c.f.instance.record.origin.replace('localhost', '127.0.0.1')));
});

test('prints a usage line when no instance directory is given', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [runnerScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(output, /Usage: node scripts\/local\/runner\.mjs <instance directory>/);
});
