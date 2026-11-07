import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { listInstances, processAlive, processCommand, runsInstance } from './instance.mjs';

const run = promisify(execFile);
const source = resolve(import.meta.dirname, '../..');
const command = join(source, 'scripts/local/command.mjs');
// The temporary HOME hides Playwright's default browser cache, so name the real one explicitly.
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  ?? join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
let root;
let environment;
const local = (...args) => run(process.execPath, [command, ...args], { cwd: source, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

/** Runs the command in an environment of its own and reports a non-zero exit as a result instead of throwing. */
async function localResult(overrides, ...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [command, ...args], { cwd: source, env: { ...environment, ...overrides }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** A readiness deadline of 1 ms makes up fail at once, which also records the instance and its port. */
const hurried = { ARC_LOCAL_READY_TIMEOUT_MS: '1' };

async function instanceStatus(overrides = {}) {
  return JSON.parse((await localResult(overrides, 'status', '--json')).stdout);
}

async function runnersOf(directory) {
  const { stdout } = await run('ps', ['-ww', '-axo', 'pid=,command=']);
  return stdout.split('\n').filter(line => runsInstance(line.replace(/^\s*\d+\s+/, ''), directory));
}

/** Kills the runner and Controller recorded for the test instance when a clean stop was not possible. */
async function killLeftovers() {
  for (const instance of await listInstances(environment)) {
    const { runnerPid, controllerPid } = instance.runtime ?? {};
    const runner = runsInstance(await processCommand(runnerPid).catch(() => undefined), instance.directory);
    const controller = (await processCommand(controllerPid).catch(() => undefined))?.includes('cli.js foreground');
    for (const [pid, ours] of [[runnerPid, runner], [controllerPid, controller]]) {
      if (!ours) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }
}

before(async () => {
  if (!existsSync(join(source, 'packages/agent-host/dist/cli.js'))) {
    throw new Error('Build the Controller first: pnpm --filter @orchardworks/agent-remote-controller... run build');
  }
  await run(process.execPath, [join(source, 'scripts/build-devbox.mjs')], { cwd: source, timeout: 60_000 });
  root = await mkdtemp(join(tmpdir(), 'arc-local-command-'));
  const web = join(root, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><html><head></head><body><main class="lab-shell">Local fixture</main></body></html>');
  environment = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: tmpdir(), ARC_LOCAL_ROOT: join(root, 'local'),
    ARC_LOCAL_WEB_DIST: web, ARC_LOCAL_READY_TIMEOUT_MS: '60000', PLAYWRIGHT_BROWSERS_PATH: browsers };
  await mkdir(environment.HOME);
});

after(async () => {
  if (environment) {
    try { await local('down'); }
    catch { await killLeftovers().catch(() => undefined); }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('serves a signed-in site with a registered development Controller and keeps its identity across restarts', { timeout: 240_000 }, async () => {
  const started = (await local('up', '--no-build')).stdout;
  assert.match(started, /Waiting for the site…\nWaiting for Controller registration…/);
  assert.match(started, /uplink registered/);
  const report = JSON.parse((await local('status', '--json')).stdout);
  assert.equal(report.state, 'running');
  assert.equal(report.localUser, true);
  assert.equal(report.controllerUplink, 'registered');
  assert.equal(report.commandLine, true);
  assert.equal((await (await fetch(report.origin + '/auth/status')).json()).user.id, 'devbox');

  // The Controller command line works against the instance: as the Host owner through the management socket,
  // and as the signed-in local user through the instance's Relay.
  assert.ok(Array.isArray(JSON.parse((await local('controller', 'session', 'list')).stdout).sessions));
  assert.deepEqual(JSON.parse((await local('controller', 'host', 'list')).stdout).hosts.map(host => host.name), [`Dev · ${basename(source)}`]);
  assert.equal(JSON.parse((await local('controller', 'login', 'status')).stdout).signedIn, true);
  assert.match((await local('controller', 'login')).stdout, /command line is signed in to http:\/\/localhost:\d+/);
  for (const [args, refusal] of [[['session', 'attach', 'local/claude/x'], /session attach runs a native CLI/], [['host', 'update'], /run pnpm local up instead/],
    [['host', 'tunnel', 'start', '--accept-license'], /only reports its status/], [['login', '--server', 'http://elsewhere'], /takes no options/]]) {
    const refused = await localResult({}, 'controller', ...args);
    assert.equal(refused.code, 1, args.join(' '));
    assert.match(refused.stderr, refusal, args.join(' '));
  }

  const hosts = JSON.parse((await local('api', 'v1/remote/hosts')).stdout).hosts;
  assert.deepEqual(hosts.map(host => [host.name, host.online]), [[`Dev · ${basename(source)}`, true]]);

  const image = join(root, 'page.png');
  await local('screenshot', '/', '--out', image, '--viewport', '800x600');
  assert.deepEqual([...(await readFile(image)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  await assert.rejects(local('controller', 'start'), /runner owns start/);
  await assert.rejects(local('remove', '--yes'), /pnpm local down first/);

  await local('down');
  assert.equal(processAlive(report.build.runnerPid), false);
  assert.equal(processAlive(report.build.controllerPid), false);
  assert.ok(existsSync(join(report.directory, 'relay', 'identity.json')));
  assert.ok(existsSync(join(report.directory, 'controller', 'connection.json')));

  await local('up', '--no-build');
  const restarted = JSON.parse((await local('status', '--json')).stdout);
  assert.equal(restarted.origin, report.origin);
  assert.equal(restarted.controllerUplink, 'registered');
  // The command line's sign-in is kept by the instance's site state across restarts.
  assert.equal(restarted.commandLine, true);
  assert.equal(JSON.parse((await local('api', 'v1/remote/hosts')).stdout).hosts.length, 1);

  await local('down');
  await local('remove', '--yes');
  assert.equal(existsSync(report.directory), false);
});

test('prints usage for help and an unknown command and explains the exit codes', async () => {
  for (const request of ['help', '--help', '-h']) {
    const result = await localResult({}, request);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: pnpm local <command>/);
    assert.match(result.stdout, /Exit codes: 0 success, 1 failure, 3 /);
  }
  const unknown = await localResult({}, 'frobnicate');
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Usage: pnpm local <command>/);
  assert.equal(unknown.stdout, '');
});

test('reports a missing instance without creating one', async () => {
  const empty = { ARC_LOCAL_ROOT: join(root, 'empty') };
  const status = await localResult(empty, 'status', '--json');
  assert.equal(status.code, 3);
  assert.deepEqual(JSON.parse(status.stdout), { state: 'none' });
  const text = await localResult(empty, 'status');
  assert.equal(text.code, 3);
  assert.match(text.stdout, /no local instance/);
  for (const args of [['down'], ['remove', '--yes'], ['logs'], ['controller', 'status']]) {
    const result = await localResult(empty, ...args);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /no local instance/, args.join(' '));
  }
  const invalid = await localResult(empty, 'api', 'v1/remote/hosts', '--data', '{not json');
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /--data must be JSON: /);
  assert.equal(existsSync(join(root, 'empty', 'instances')), false);
});

test('rejects an unusable readiness deadline before building or starting anything', async () => {
  for (const value of ['soon', '0', '-5', '1.5', '']) {
    const result = await localResult({ ARC_LOCAL_ROOT: join(root, 'unused'), ARC_LOCAL_READY_TIMEOUT_MS: value }, 'up', '--no-build');
    assert.equal(result.code, 1, value);
    assert.match(result.stderr, /ARC_LOCAL_READY_TIMEOUT_MS must be a positive whole number of milliseconds/, value);
  }
  assert.equal(existsSync(join(root, 'unused', 'instances')), false);
});

test('stops the runner and shows the log tails when the instance does not become ready', { timeout: 120_000 }, async () => {
  const failed = await localResult(hurried, 'up', '--no-build');
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /did not become ready within 0\.001 seconds while waiting for the site/);
  assert.match(failed.stderr, /--- runner\.log \(last 20 lines\) ---/);
  assert.match(failed.stderr, /--- controller\.log \(last 20 lines\) ---/);
  assert.doesNotMatch(failed.stderr, /Cause:/);
  const report = await instanceStatus();
  assert.ok(['stopped', 'stale'].includes(report.state), report.state);
  assert.deepEqual(await runnersOf(report.directory), []);
  assert.equal(report.controllerUplink, null);
});

test('refuses to start while another process holds the recorded port', { timeout: 120_000 }, async () => {
  await localResult(hurried, 'up', '--no-build');
  const report = await instanceStatus();
  const holder = createServer();
  holder.listen(Number(new URL(report.origin).port), '127.0.0.1');
  await once(holder, 'listening');
  try {
    const refused = await localResult({}, 'up', '--no-build');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Port \d+ is in use by another process/);
    assert.deepEqual(await runnersOf(report.directory), []);
    assert.ok(['stopped', 'stale'].includes((await instanceStatus()).state));
  } finally { await new Promise(resolveClose => holder.close(resolveClose)); }
});

test('says so when there is nothing to stop and asks for --yes before removing', { timeout: 120_000 }, async () => {
  await localResult(hurried, 'up', '--no-build');
  const report = await instanceStatus();
  const down = await localResult({}, 'down');
  assert.equal(down.code, 0);
  assert.equal(down.stdout, `${report.name} was not running.\n`);
  const refused = await localResult({}, 'remove');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Repeat with --yes/);
  assert.ok(existsSync(report.directory));
});
