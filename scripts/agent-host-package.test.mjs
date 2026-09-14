import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const require = createRequire(join(root, 'packages/agent-host/package.json'));
const { WebSocketServer } = require('ws');
const artifact = process.env.AGENT_HOST_PACKAGE ?? join(root, 'dist/agent-remote-controller/agent-remote-control-agent-remote-controller-0.1.0.tgz');

test('installs the tarball independently and manages a paired daemon from a path containing spaces', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent host installed '));
  const prefix = join(directory, 'prefix with spaces');
  const state = join(directory, 'state');
  const bin = join(prefix, 'bin/agent-remote-controller');
  const home = join(directory, 'home'); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, AGENT_HOST_STATE_DIR: state,
    AGENT_HOST_PROVIDERS: 'codex,claude,copilot', AGENT_HOST_WORKSPACE: directory,
    AGENT_HOST_CLAUDE_HOME: join(home, 'claude'), AGENT_HOST_COPILOT_HOME: join(home, 'copilot') };
  const run = async (args, overrides = {}) => {
    try { return await exec(bin, args, { cwd: directory, env: { ...env, ...overrides }, timeout: 60000 }); }
    catch (error) {
      const log = await readFile(join(state, 'agent-host.log'), 'utf8').catch(() => '');
      throw new Error(`${error.message}\nDaemon diagnostics: ${log}`, { cause: error });
    }
  };
  t.after(async () => {
    const daemon = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8').catch(() => 'null'));
    try { await run(['stop']); } catch {}
    if (daemon) {
      try { process.kill(daemon.pid, 'SIGTERM'); } catch {}
      await waitFor(async () => {
        try { process.kill(daemon.pid, 0); return false; } catch { return true; }
      });
    }
    await rm(directory, { recursive: true, force: true });
  });
  await exec('npm', ['install', '--global', '--prefix', prefix, artifact,
    '--registry', process.env.npm_config_registry ?? 'https://mirrors.cloud.tencent.com/npm/', '--no-audit', '--no-fund'],
    { cwd: directory, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.match((await run(['--help'])).stdout, /Usage: agent-remote-controller/);
  const packageRoot = join(prefix, 'lib/node_modules/@agent-remote-control/agent-remote-controller');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@agent-remote-control/agent-remote-controller');
  assert.deepEqual(Object.keys(manifest.bin), ['agent-remote-controller']);
  assert.ok(Object.values(manifest.dependencies).every(version => !version.startsWith('workspace:')));
  assert.ok(Object.keys(manifest.dependencies).every(name => !name.startsWith('@borgee/')));
  await assert.rejects(run(['start']), /AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY are required/);
  await assert.rejects(run(['start'], { AGENT_HOST_REMOTE_KEY: 'key-without-relay' }), /Set AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY together/);
  for (const [provider, version] of [['codex', 'codex-cli 0.148.0'], ['claude', '2.1.247 (Claude Code)']]) {
    const executable = join(directory, provider);
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
    env[`AGENT_HOST_${provider.toUpperCase()}`] = executable;
  }
  // Exercise the separately shipped helper and installed public SDK outside the repository.
  const catalog = await exec(process.execPath, [join(packageRoot, 'dist/catalog-worker.js'), 'list'],
    { cwd: directory, env: { ...env, CLAUDE_CONFIG_DIR: env.AGENT_HOST_CLAUDE_HOME }, timeout: 10000 });
  assert.deepEqual(JSON.parse(catalog.stdout), []);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const registrations = [];
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'register') {
      registrations.push(message);
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'package-smoke-host' }));
    }
  }));
  const connection = { AGENT_HOST_SERVER: `http://127.0.0.1:${server.address().port}`, AGENT_HOST_REMOTE_KEY: 'local-package-test-key' };
  assert.match((await run(['start'], connection)).stdout, /daemon started/);
  await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
  assert.deepEqual(registrations[0].providers.map(provider => provider.providerId), ['codex', 'claude', 'copilot']);
  const saved = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8'));
  assert.equal(saved.remoteKey, connection.AGENT_HOST_REMOTE_KEY);
  assert.match((await run(['pair'], { ...connection, AGENT_HOST_REMOTE_KEY: 'replacement-package-test-key' })).stdout, /without restarting sessions/);
  const daemon = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  await run(['stop']);
  await waitFor(async () => {
    try { process.kill(daemon.pid, 0); return false; } catch { return true; }
  });
  assert.match((await run(['start'])).stdout, /daemon started/);
  await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
  assert.equal(JSON.parse(await readFile(join(state, 'connection.json'), 'utf8')).remoteKey, 'replacement-package-test-key');
});

async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Packaged Agent Host did not reach the expected state.');
}
