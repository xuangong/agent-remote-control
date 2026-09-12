import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PNPM_VERSION, startProcess, waitFor } from './lib/dsh-debug-runtime.mjs';

const cli = fileURLToPath(new URL('./start.mjs', import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'controller-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function execute(t, args, env = process.env) {
  const output = [];
  const child = startProcess(process.execPath, [cli, ...args], { env, output: (line) => output.push(line) });
  t.after(() => child.stop());
  return { result: await child.finished, output: output.join('\n') };
}

test('help explains the complete startup without requiring native executables', async (t) => {
  const { result, output } = await execute(t, ['--help'], { PATH: '' });
  assert.equal(result.code, 0, output);
  for (const text of ['Codex', 'Claude', 'DSH', '--config', '--web-port', 'Ctrl+C']) assert.ok(output.includes(text), text);
});

test('invalid configuration fails before writing state or starting services', async (t) => {
  const directory = await temporary(t);
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ webPort: 6175, relayPort: 6175 }));
  const { result, output } = await execute(t, ['--config', config, '--state-dir', join(directory, 'state')]);
  assert.equal(result.code, 1);
  assert.match(output, /distinct ports/i);
  await assert.rejects(readFile(join(directory, 'state/run.lock/owner.json')), { code: 'ENOENT' });
});

test('configuration rejects credentials and unknown fields rather than silently ignoring them', async (t) => {
  const directory = await temporary(t);
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ remoteKey: 'private-test-value' }));
  const { result, output } = await execute(t, ['--config', config]);
  assert.equal(result.code, 1);
  assert.match(output, /Unknown configuration field: remoteKey/);
  assert.ok(!output.includes('private-test-value'));
});

test('occupied ports leave an existing listener and user material intact', async (t) => {
  const directory = await temporary(t);
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { result, output } = await execute(t, ['--web-port', String(server.address().port), '--state-dir', directory]);
  assert.equal(result.code, 1);
  assert.match(output, /occupied/);
  assert.equal(server.listening, true);
});

test('an existing launcher lock is never replaced or removed', async (t) => {
  const directory = await temporary(t);
  await mkdir(join(directory, 'run.lock'));
  await writeFile(join(directory, 'run.lock/owner.json'), 'user-owned-lock');
  const { result, output } = await execute(t, ['--state-dir', directory]);
  assert.equal(result.code, 1);
  assert.match(output, /already in use/);
  assert.equal(await readFile(join(directory, 'run.lock/owner.json'), 'utf8'), 'user-owned-lock');
});

async function workflow(t, failCatalog = false, providers, bundled = false, failHost = false, bareScript = false) {
  const directory = await temporary(t);
  const state = join(directory, 'state');
  await mkdir(join(directory, 'scripts/lib'), { recursive: true });
  for (const path of ['start.mjs', 'dsh-debug.mjs', 'lib/dsh-debug-runtime.mjs', 'lib/controller-options.mjs']) {
    await cp(new URL(path, import.meta.url), join(directory, 'scripts', path));
  }
  const tool = new URL('./fixtures/controller-tools.mjs', import.meta.url).href;
  async function executable(path, mode) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `#!${process.execPath}\nprocess.env.CONTROLLER_FIXTURE_MODE = ${JSON.stringify(mode)};\nimport(${JSON.stringify(tool)});\n`, { mode: 0o755 });
  }
  for (const name of ['pnpm', 'codex', 'claude', 'copilot', 'dsh']) await executable(join(directory, 'bin', name), name);
  await executable(join(directory, 'packages/agent-host/dist/cli.js'), 'host');
  if (bareScript) await writeFile(join(directory, 'bin/copilot.mjs'), "console.log('GitHub Copilot CLI 1.0.83.');", { mode: 0o600 });
  await executable(join(state, 'dsh/tools', PNPM_VERSION, 'node_modules/.bin/pnpm'), 'pnpm');
  await mkdir(join(directory, 'packages/agent-remote-dsh'), { recursive: true });
  await writeFile(join(directory, 'packages/agent-remote-dsh/package.json'), '{"version":"0.1.0"}');
  await mkdir(join(directory, 'node_modules'), { recursive: true });
  if (!bundled) await writeFile(join(directory, 'node_modules/.modules.yaml'), '');
  const ports = [];
  const probes = [];
  for (let i = 0; i < 3; i++) {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    ports.push(probe.address().port); probes.push(probe);
  }
  await Promise.all(probes.map((probe) => new Promise((accept) => probe.close(accept))));
  const config = { codex: './bin/codex', claude: './bin/claude', dsh: './bin/dsh', workspace: '.', stateDir: './state',
    webPort: ports[0], relayPort: ports[1], dshPort: ports[2], ...(providers ? { providers, copilot: bareScript ? 'copilot.mjs' : bundled ? undefined : './bin/copilot', copilotHome: './copilot-home',
      ...Object.fromEntries(['codex', 'claude', 'dsh'].filter((id) => !providers.split(',').includes(id)).map((id) => [id, './missing-' + id])),
      ...(!providers.includes('dsh') ? { dshPort: ports[0] } : {}) } : {}) };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
  const output = [];
  const child = startProcess(process.execPath, [join(directory, 'scripts/start.mjs'), '--config', join(directory, 'config.json')], {
    env: { ...process.env, PATH: join(directory, 'bin') + ':' + process.env.PATH, CONTROLLER_FIXTURE_ROOT: directory,
      CONTROLLER_FIXTURE_FAIL_CATALOG: failCatalog ? '1' : '0', CONTROLLER_FIXTURE_FAIL_HOST: failHost ? '1' : '0' },
    output: (line) => output.push(line), stopTimeoutMs: 12000,
  });
  t.after(() => child.stop());
  return { directory, state, output, child, ports };
}

test('builds, pairs each Host, waits for a slower Broker, and prints the ready controller URL', async (t) => {
  const { directory, state, child, output, ports } = await workflow(t);
  const ready = await waitFor(async () => {
    assert.equal(child.running, true, output.join('\n'));
    try { return JSON.parse(await readFile(join(state, 'ready.json'), 'utf8')); } catch { return false; }
  }, { timeoutMs: 10000, intervalMs: 30 });
  assert.equal(ready.consoleUrl, `http://127.0.0.1:${ports[0]}`);
  assert.deepEqual(ready.hosts.flatMap((host) => host.providers), ['codex', 'claude', 'dsh']);
  assert.ok(output.some((line) => line === `Remote Controller: ${ready.consoleUrl}`));
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.pairing).length, 2);
  assert.ok(events.some((event) => event.pluginInstalled));
  assert.ok(!output.join('\n').includes('arc_fixture-private'));
  assert.ok(!(await readFile(ready.logFile, 'utf8')).includes('arc_fixture-private'));
  await child.stop();
  assert.equal((await child.finished).code, 0, output.join('\n'));
  const stopped = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(stopped.some((event) => event.nativeClosedByHost));
  assert.ok(!stopped.some((event) => event.prematureNativeTerm));
  await assert.rejects(readFile(join(state, 'ready.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(state, 'run.lock/owner.json')), { code: 'ENOENT' });
  for (const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
});

test('a provider catalog failure prevents readiness and cleans up every owned listener', async (t) => {
  const { child, output, state, ports } = await workflow(t, true);
  assert.equal((await child.finished).code, 1);
  assert.match(output.join('\n'), /catalog unavailable/);
  assert.ok(!output.some((line) => line.startsWith('Remote Controller:')));
  await assert.rejects(readFile(join(state, 'ready.json')), { code: 'ENOENT' });
  for (const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
});

for (const providers of ['copilot', 'dsh', 'codex,claude,copilot,dsh']) {
  test(`starts only selected providers: ${providers}`, async (t) => {
    const { directory, state, child, output } = await workflow(t, false, providers);
    const ready = await waitFor(async () => {
      assert.equal(child.running, true, output.join('\n'));
      try { return JSON.parse(await readFile(join(state, 'ready.json'), 'utf8')); } catch { return false; }
    }, { timeoutMs: 10000, intervalMs: 30 });
    assert.deepEqual(ready.hosts.flatMap((host) => host.providers), providers.split(','));
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.some((event) => event.pluginInstalled), providers.includes('dsh'));
    if (providers.includes('copilot')) {
      assert.ok(events.some((event) => event.copilot === join(directory, 'bin/copilot') && event.copilotHome === join(directory, 'copilot-home')));
    }
    if (!providers.includes('dsh')) assert.equal(ready.dshUrl, undefined);
    await child.stop();
    assert.equal((await child.finished).code, 0, output.join('\n'));
  });
}

test('provider selections reject unknown, duplicate and empty entries', async () => {
  const { controllerOptions } = await import('./lib/controller-options.mjs');
  for (const providers of ['', 'copilot,copilot', 'unknown', 'copilot,']) {
    await assert.rejects(controllerOptions(['--providers', providers], '/tmp', '/tmp', {}), /provider/i);
  }
});

test('resolves bundled Copilot only after fresh dependency installation and build', async (t) => {
  const { directory, state, child, output } = await workflow(t, false, 'copilot', true);
  await waitFor(async () => {
    assert.equal(child.running, true, output.join('\n'));
    try { return await readFile(join(state, 'ready.json')); } catch { return false; }
  }, { timeoutMs: 10000, intervalMs: 30 });
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const installed = events.findIndex((event) => event.installed);
  const built = events.findIndex((event) => event.built);
  const version = events.findIndex((event) => event.version === 'copilot');
  assert.ok(installed >= 0 && built > installed && version > built);
  await child.stop();
  assert.equal((await child.finished).code, 0, output.join('\n'));
});

test('a native Host exit during readiness fails the launcher and cleans up owned listeners', async (t) => {
  const { child, output, state, ports } = await workflow(t, false, 'copilot', false, true);
  assert.equal((await child.finished).code, 1, output.join('\n'));
  assert.match(output.join('\n'), /Agent Host exited/);
  assert.ok(!output.some((line) => line.startsWith('Remote Controller:')));
  await assert.rejects(readFile(join(state, 'ready.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(state, 'run.lock/owner.json')), { code: 'ENOENT' });
  for (const port of ports.slice(0, 2)) await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
});

test('resolves a bare readable Copilot JavaScript entry from PATH in the launcher', async (t) => {
  const { directory, state, child, output } = await workflow(t, false, 'copilot', false, false, true);
  await waitFor(async () => {
    assert.equal(child.running, true, output.join('\n'));
    try { return await readFile(join(state, 'ready.json')); } catch { return false; }
  }, { timeoutMs: 10000, intervalMs: 30 });
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.copilot === join(directory, 'bin/copilot.mjs')));
  await child.stop();
  assert.equal((await child.finished).code, 0, output.join('\n'));
});
