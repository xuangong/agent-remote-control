import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findInstance, instanceName, listInstances, localRoot, portAvailable, prepareInstance, runsInstance, runState, withLock, writeJson } from './instance.mjs';

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'arc-local-instance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

/** A live process whose command line ends with the given marker arguments. */
async function idleProcess(t, ...marker) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...marker], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'spawn');
  return child;
}

test('names an instance stably per checkout path', () => {
  assert.equal(instanceName('/work/.worktrees/feature'), instanceName('/work/.worktrees/feature'));
  assert.notEqual(instanceName('/work/.worktrees/feature'), instanceName('/other/feature'));
  assert.match(instanceName('/work/.worktrees/feature'), /^feature-[0-9a-f]{8}$/);
  assert.match(instanceName('/work/odd name!'), /^odd-name--[0-9a-f]{8}$/);
});

test('resolves a relative root so every command addresses the same instances', () => {
  assert.equal(localRoot({ ARC_LOCAL_ROOT: 'relative-root' }), resolve('relative-root'));
});

test('records a port once and reuses it', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  const first = await prepareInstance('/src/one', environment);
  const second = await prepareInstance('/src/one', environment);
  assert.equal(second.record.port, first.record.port);
  assert.equal(first.record.origin, `http://localhost:${first.record.port}`);
  assert.equal(first.directory, join(environment.ARC_LOCAL_ROOT, 'instances', instanceName('/src/one')));
  for (const directory of [first.relay, first.controller, first.workspace, first.logs]) assert.ok((await stat(directory)).isDirectory());
  assert.equal((await stat(first.recordFile)).mode & 0o777, 0o600);
  assert.deepEqual((await findInstance('/src/one', environment)).record, first.record);
  assert.equal(await findInstance('/src/two', environment), undefined);
});

test('agrees on one port when several commands start the same checkout together', async t => {
  for (let round = 0; round < 20; round++) {
    const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
    const instances = await Promise.all(Array.from({ length: 4 }, () => prepareInstance('/src/one', environment)));
    assert.equal(new Set(instances.map(instance => instance.record.port)).size, 1);
    assert.deepEqual((await findInstance('/src/one', environment)).record, instances[0].record);
    assert.deepEqual((await readdir(instances[0].directory)).filter(name => name.endsWith('.tmp')), []);
  }
});

test('refuses an instance directory recorded for another checkout', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  const instance = await prepareInstance('/src/one', environment);
  await writeFile(instance.recordFile, JSON.stringify({ ...instance.record, source: '/src/elsewhere' }));
  await assert.rejects(prepareInstance('/src/one', environment), /belongs to \/src\/elsewhere/);
  assert.equal(await findInstance('/src/one', environment), undefined);
});

test('names the file when an instance record is not valid JSON', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  const instance = await prepareInstance('/src/one', environment);
  await writeFile(instance.recordFile, '{ truncated');
  await assert.rejects(prepareInstance('/src/one', environment), error => error.message === `${instance.recordFile} is not valid JSON.`);
});

test('leaves no temporary file behind when a JSON file cannot be replaced', async t => {
  const directory = await temporaryRoot(t);
  const target = join(directory, 'runtime.json');
  await mkdir(target);
  await assert.rejects(writeJson(target, { version: 1 }));
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('reports whether a port is free', async t => {
  const server = createServer();
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  assert.equal(await portAvailable(port), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await portAvailable(port), true);
});

test('reports a port held only on the IPv6 loopback as taken', async t => {
  const server = createServer();
  t.after(() => server.close());
  server.listen(0, '::1');
  try { await once(server, 'listening'); }
  catch { t.skip('The IPv6 loopback address is unavailable.'); return; }
  const { port } = server.address();
  assert.equal(await portAvailable(port), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await portAvailable(port), true);
});

test('lists instances with their run records', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  assert.deepEqual(await listInstances(environment), []);
  const one = await prepareInstance('/src/one', environment);
  await prepareInstance('/src/two', environment);
  await writeJson(one.runtimeFile, { version: 1, runnerPid: 1, controllerPid: 2 });
  const listed = await listInstances(environment);
  assert.deepEqual(listed.map(item => item.record.source).sort(), ['/src/one', '/src/two']);
  assert.equal(listed.find(item => item.record.source === '/src/one').runtime.controllerPid, 2);
});

test('treats run records of exited processes as stale', async t => {
  const directory = await temporaryRoot(t);
  const pid = await exitedPid();
  assert.equal(await runState(directory, undefined), 'stopped');
  assert.equal(await runState(directory, { runnerPid: pid, controllerPid: pid }), 'stale');
  // A live process that is not this instance's runner does not count as running.
  assert.equal(await runState(directory, { runnerPid: process.pid, controllerPid: pid }), 'stale');
});

test('recognizes this instance runner and an orphaned Controller', async t => {
  const directory = await temporaryRoot(t);
  const runner = await idleProcess(t, 'scripts/local/runner.mjs', directory);
  const controller = await idleProcess(t, 'cli.js', 'foreground');
  const runtime = { runnerPid: runner.pid, controllerPid: controller.pid };
  assert.equal(await runState(directory, runtime), 'running');
  // The runner must be started for exactly this instance directory.
  assert.equal(await runState(`${directory}-other`, runtime), 'orphaned');
  assert.equal(await runState(directory.slice(0, -1), runtime), 'orphaned');
});

test('matches a runner command only for exactly its instance directory', () => {
  const command = 'node /src/one/scripts/local/runner.mjs /state/instances/one';
  assert.equal(runsInstance(command, '/state/instances/one'), true);
  assert.equal(runsInstance(command, '/state/instances/on'), false);
  assert.equal(runsInstance(command, '/other/state/instances/one-x'), false);
  assert.equal(runsInstance('node /src/one/scripts/other.mjs /state/instances/one', '/state/instances/one'), false);
  assert.equal(runsInstance(undefined, '/state/instances/one'), false);
});

test('does not mistake an unknown process state for a stopped instance', async t => {
  const directory = await temporaryRoot(t);
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(runState(directory, { runnerPid: process.pid, controllerPid: process.pid }), /Could not inspect process/);
  } finally { process.env.PATH = path; }
});

test('serializes operations on one instance', async t => {
  const directory = await temporaryRoot(t);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = withLock(directory, async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  await assert.rejects(withLock(directory, async () => undefined), /Another local command/);
  finish.resolve();
  await first;
  assert.equal(await withLock(directory, async () => 'ran'), 'ran');
  await assert.rejects(withLock(directory, async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await withLock(directory, async () => 'ran again'), 'ran again');
});

test('reports a lock left by a killed command instead of taking it over', async t => {
  const directory = await temporaryRoot(t);
  await mkdir(join(directory, 'operation.lock'));
  await assert.rejects(withLock(directory, async () => 'ran'), /remove .*operation\.lock/);
  assert.ok((await stat(join(directory, 'operation.lock'))).isDirectory());
});

test('releases the lock when the command is terminated', async t => {
  const directory = await temporaryRoot(t);
  const module = pathToFileURL(join(import.meta.dirname, 'instance.mjs')).href;
  const script = `import { withLock } from ${JSON.stringify(module)};
await withLock(process.argv[1], async () => { process.stdout.write('locked\\n'); await new Promise(() => setInterval(() => {}, 1000)); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGTERM');
  await assert.rejects(stat(join(directory, 'operation.lock')), { code: 'ENOENT' });
});
