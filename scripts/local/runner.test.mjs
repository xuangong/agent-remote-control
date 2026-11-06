import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { prepareInstance } from './instance.mjs';
import { startInstance } from './runner.mjs';

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
await appendFile(join(state, 'starts.jsonl'), JSON.stringify(process.env) + '\\n');
setInterval(() => {}, 1000);
`;

async function fixture(t, controller = fakeController) {
  const root = await mkdtemp(join(tmpdir(), 'arc-local-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controllerScript = join(root, 'controller.mjs');
  await writeFile(controllerScript, controller);
  const environment = { ARC_LOCAL_ROOT: join(root, 'local'), HOME: join(root, 'home'), PATH: '/usr/bin:/bin', TMPDIR: tmpdir(),
    AGENT_HOST_TRUSTED_FULL_CONTROL: '1', CLAUDECODE: '1' };
  const instance = await prepareInstance(join(root, 'checkout'), environment);
  let invitations = 0;
  const closed = [];
  const createServer = async ({ origin, stateDir }) => {
    assert.equal(origin, instance.record.origin);
    assert.equal(stateDir, instance.relay);
    const server = createHttpServer((_request, response) => response.end('ready'));
    return {
      listen: (port, bind) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); }),
      close: () => new Promise(resolve => { closed.push(true); server.close(() => resolve()); }),
      getConnection: async () => { invitations++; return { serverUrl: origin, remoteKey: 'one-time-invite' }; },
    };
  };
  const starts = async () => (await readFile(join(instance.controller, 'starts.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const waitForStarts = async count => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const seen = await starts();
      if (seen.length >= count) return seen;
      await delay(20);
    }
    throw new Error('The Controller fixture did not start.');
  };
  return { root, environment, instance, closed, waitForStarts, invitations: () => invitations,
    start: options => startInstance({ directory: instance.directory, environment, createServer, controllerScript, ...options }) };
}

test('pairs once, then restarts with the saved device credential', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let running = await f.start();
  try {
    assert.equal(await (await fetch(running.origin.replace('localhost', '127.0.0.1'))).text(), 'ready');
    const [first] = await f.waitForStarts(1);
    assert.equal(first.AGENT_HOST_REMOTE_KEY, 'one-time-invite');
    assert.equal(first.AGENT_HOST_SERVER, f.instance.record.origin);
    assert.equal(first.AGENT_HOST_ALLOWED_WORKSPACE_ROOTS, JSON.stringify([f.instance.workspace]));
    assert.equal(first.AGENT_HOST_TRUSTED_FULL_CONTROL, '0');
    assert.equal(first.CLAUDECODE, undefined);
    const runtime = JSON.parse(await readFile(f.instance.runtimeFile, 'utf8'));
    assert.equal(runtime.runnerPid, process.pid);
    assert.equal(runtime.controllerPid, running.controllerPid);
    assert.equal(await running.close(), 0);
    assert.equal(await readFile(join(f.instance.controller, 'stopped'), 'utf8'), 'yes');
    assert.equal(f.closed.length, 1);
    await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });

    running = await f.start();
    const [, second] = await f.waitForStarts(2);
    assert.equal(second.AGENT_HOST_REMOTE_KEY, undefined);
    assert.equal(second.AGENT_HOST_SERVER, undefined);
    assert.equal(f.invitations(), 1);
  } finally { await running.close(); }
});

test('stops serving when the Controller exits on its own', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  assert.equal(await running.done, 7);
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(condition, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

// Ignores the stop request and keeps a descendant in its own process group.
const stubbornController = `import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = process.env.AGENT_HOST_STATE_DIR;
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await mkdir(state, { recursive: true });
await writeFile(join(state, 'grandchild'), String(grandchild.pid));
setInterval(() => {}, 1000);
`;

test('kills the whole Controller process group when it ignores the stop request', { timeout: 20000 }, async t => {
  const f = await fixture(t, stubbornController);
  const running = await f.start({ stopGraceMs: 200 });
  t.after(() => { try { process.kill(-running.controllerPid, 'SIGKILL'); } catch {} });
  const grandchild = Number(await waitUntil(() => readFile(join(f.instance.controller, 'grandchild'), 'utf8').catch(() => ''), 'The descendant did not start.'));
  assert.equal(alive(grandchild), true);
  assert.equal(await running.close(), 0);
  await waitUntil(() => !alive(grandchild), 'The descendant survived the stop.');
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('close after the Controller already exited reports its code', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.instance.controller, 'exit-now'), '');
  const running = await f.start();
  assert.equal(await running.done, 7);
  assert.equal(await running.close(), 7);
  assert.equal(await running.close(), 7);
  assert.equal(f.closed.length, 1);
});

test('a Controller that cannot be spawned ends the start and leaves nothing behind', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await rm(f.instance.workspace, { recursive: true });
  await assert.rejects(f.start(), /ENOENT/);
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

test('a site that cannot listen is closed and the start fails', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const occupied = createHttpServer();
  await new Promise(resolve => occupied.listen(f.instance.record.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(() => resolve())));
  await assert.rejects(f.start(), { code: 'EADDRINUSE' });
  assert.equal(f.closed.length, 1);
  await assert.rejects(stat(f.instance.runtimeFile), { code: 'ENOENT' });
});

// The command-line entry, run the way `pnpm local up` runs it, against a stand-in checkout.
const slowSite = `import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export async function createDevboxServer({ origin, stateDir }) {
  const server = createServer((_request, response) => response.end('ready'));
  return {
    listen: (port, bind) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); }),
    close: () => new Promise(resolve => server.close(() => resolve())),
    getConnection: async () => { await writeFile(join(stateDir, 'inviting'), ''); await delay(400); return { serverUrl: origin, remoteKey: 'one-time-invite' }; },
  };
}
`;

async function commandLine(t) {
  const f = await fixture(t);
  const checkout = join(f.root, 'checkout');
  await mkdir(join(checkout, 'dist/devbox'), { recursive: true });
  await mkdir(join(checkout, 'packages/agent-host/dist'), { recursive: true });
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
  await writeFile(join(checkout, 'dist/devbox/server.mjs'), slowSite);
  await writeFile(join(checkout, 'packages/agent-host/dist/cli.js'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.AGENT_HOST_STATE_DIR + '/pid', String(process.pid));\n` + fakeController);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url)), f.instance.directory],
    { env: f.environment, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const controllerPid = () => readFile(join(f.instance.controller, 'pid'), 'utf8').then(Number, () => undefined);
  t.after(async () => { const pid = await controllerPid(); if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  return { f, child, exit, output: () => output, controllerPid };
}

test('a stop that arrives while the runner is still starting stops the Controller and the site', { timeout: 20000 }, async t => {
  const c = await commandLine(t);
  await waitUntil(() => stat(join(c.f.instance.relay, 'inviting')).then(() => true, () => false), 'The runner did not start.');
  c.child.kill('SIGTERM');
  assert.deepEqual(await c.exit, { code: 0, signal: null });
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
  const pid = await c.controllerPid();
  if (pid !== undefined) assert.equal(alive(pid), false);
  await assert.rejects(fetch(c.f.instance.record.origin.replace('localhost', '127.0.0.1')));
});

test('a stop sent to a running runner stops the Controller and removes the runtime file', { timeout: 20000 }, async t => {
  const c = await commandLine(t);
  await waitUntil(() => /Serving /.test(c.output()), 'The runner did not report that it was serving.');
  await c.f.waitForStarts(1);
  const pid = await c.controllerPid();
  assert.match(c.output(), new RegExp(`Controller pid ${pid}\\.`));
  c.child.kill('SIGTERM');
  assert.deepEqual(await c.exit, { code: 0, signal: null });
  assert.equal(await readFile(join(c.f.instance.controller, 'stopped'), 'utf8'), 'yes');
  assert.equal(alive(pid), false);
  await assert.rejects(stat(c.f.instance.runtimeFile), { code: 'ENOENT' });
});
