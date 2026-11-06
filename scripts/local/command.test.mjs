import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { processAlive } from './instance.mjs';

const run = promisify(execFile);
const source = resolve(import.meta.dirname, '../..');
const command = join(source, 'scripts/local/command.mjs');
// The temporary HOME hides Playwright's default browser cache, so name the real one explicitly.
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  ?? join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
let root;
let environment;
const local = (...args) => run(process.execPath, [command, ...args], { cwd: source, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

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
  if (environment) await local('down').catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
});

test('serves a signed-in site with a registered development Controller and keeps its identity across restarts', { timeout: 240_000 }, async () => {
  assert.match((await local('up', '--no-build')).stdout, /uplink registered/);
  const report = JSON.parse((await local('status', '--json')).stdout);
  assert.equal(report.state, 'running');
  assert.equal(report.localUser, true);
  assert.equal(report.controllerUplink, 'registered');
  assert.equal((await (await fetch(report.origin + '/auth/status')).json()).user.id, 'devbox');

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
  assert.equal(JSON.parse((await local('api', 'v1/remote/hosts')).stdout).hosts.length, 1);

  await local('down');
  await local('remove', '--yes');
  assert.equal(existsSync(report.directory), false);
});
