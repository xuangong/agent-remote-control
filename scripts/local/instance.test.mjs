import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { findInstance, instanceName, listInstances, portAvailable, prepareInstance, runState, withLock, writeJson } from './instance.mjs';

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

test('names an instance stably per checkout path', () => {
  assert.equal(instanceName('/work/.worktrees/feature'), instanceName('/work/.worktrees/feature'));
  assert.notEqual(instanceName('/work/.worktrees/feature'), instanceName('/other/feature'));
  assert.match(instanceName('/work/.worktrees/feature'), /^feature-[0-9a-f]{8}$/);
  assert.match(instanceName('/work/odd name!'), /^odd-name--[0-9a-f]{8}$/);
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

test('refuses an instance directory recorded for another checkout', async t => {
  const environment = { ARC_LOCAL_ROOT: await temporaryRoot(t) };
  const instance = await prepareInstance('/src/one', environment);
  await writeFile(instance.recordFile, JSON.stringify({ ...instance.record, source: '/src/elsewhere' }));
  await assert.rejects(prepareInstance('/src/one', environment), /belongs to \/src\/elsewhere/);
  assert.equal(await findInstance('/src/one', environment), undefined);
});

test('reports whether a port is free', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
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

test('serializes operations and recovers a lock left by an exited process', async t => {
  const directory = await temporaryRoot(t);
  const first = withLock(directory, () => delay(200));
  await delay(30);
  await assert.rejects(withLock(directory, async () => undefined), /Another local command/);
  await first;
  await mkdir(join(directory, 'operation.lock'));
  await writeJson(join(directory, 'operation.lock', 'owner.json'), { pid: await exitedPid() });
  assert.equal(await withLock(directory, async () => 'ran'), 'ran');
  await assert.rejects(readFile(join(directory, 'operation.lock', 'owner.json')), { code: 'ENOENT' });
});
