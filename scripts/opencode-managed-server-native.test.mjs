import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
const controller = process.env.AGENT_HOST_TEST_CLI ?? fileURLToPath(new URL('../packages/agent-host/dist/cli.js', import.meta.url));

async function reservePort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const allocated = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return allocated;
}
function privateDirectory(stateDir, url) {
  return join(stateDir, 'opencode-server', createHash('sha256').update(url).digest('hex').slice(0, 24));
}

test('real OpenCode CLI runs as an authenticated Controller-managed service independently of lifecycle callers',
  { skip: !executable, timeout: 60_000 }, async t => {
    assert.ok(isAbsolute(executable), 'Set an absolute AGENT_OPENCODE_TEST_EXECUTABLE.');
    assert.ok(isAbsolute(controller), 'AGENT_HOST_TEST_CLI must be an absolute path.');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-managed-native-')));
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(?:AGENT_HOST_|AGENT_REMOTE_|OPENCODE_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|COPILOT_|GITHUB_TOKEN|GATEWAY_|RELAY_)/i.test(name)) delete env[name];
    }
    for (const [name, directory] of Object.entries({ HOME: 'home', USERPROFILE: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' })) {
      env[name] = join(root, directory);
      await mkdir(env[name], { recursive: true });
    }
    const cwd = join(root, 'workspace');
    await mkdir(cwd);
    Object.assign(env, {
      AGENT_HOST_OPENCODE: executable,
      AGENT_HOST_OPENCODE_AUTO_START: '1',
      OPENCODE_DISABLE_AUTO_UPDATE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, plugin: [], enabled_providers: [] }),
    });
    const { stdout: nativeVersion } = await execute(executable, ['--version'], { env, cwd, timeout: 5000 });
    assert.equal(nativeVersion.trim(), '1.18.18', 'This evidence fixture targets OpenCode 1.18.18.');
    t.diagnostic(`Native OpenCode ${nativeVersion.trim()}; isolated HOME/XDG; health and lifecycle requests only.`);
    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    assert.notEqual(port, 4096);
    env.AGENT_HOST_OPENCODE_URL = url;
    const states = [];
    const cli = async (stateDir, action, timeout = 25000) => {
      const result = await execute(process.execPath, [controller, 'opencode', 'server', action], {
        env: { ...env, AGENT_HOST_STATE_DIR: stateDir }, cwd, timeout, maxBuffer: 64 * 1024, windowsHide: true,
      });
      return JSON.parse(result.stdout);
    };
    t.after(async () => {
      for (const state of states) {
        try { await cli(state, 'stop', 10000); } catch {}
      }
      try { await reservePort(port); }
      catch {
        t.diagnostic(`Cleanup could not confirm the isolated port is free; private evidence remains at ${root}.`);
        throw new Error('The isolated OpenCode server did not confirm shutdown.');
      }
      await rm(root, { recursive: true, force: true });
    });

    const firstState = join(root, 'first-controller');
    states.push(firstState);
    const started = await cli(firstState, 'start');
    assert.equal(started.running, true);
    assert.equal(started.ownership, 'managed');
    assert.equal(started.version, '1.18.18');
    assert.ok(Number.isInteger(started.pid) && Number.isInteger(started.nativePid));
    const directory = privateDirectory(firstState, url);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    assert.ok(/^[a-f\d]{64}$/.test(config.password), 'A fresh state directory generates a private random server credential.');
    assert.ok(!JSON.stringify(started).includes(config.password), 'CLI status must not expose credentials.');
    const health = async password => fetch(`${url}/global/health`, {
      headers: password === undefined ? {} : { authorization: `Basic ${Buffer.from(`${config.username}:${password}`).toString('base64')}` },
      signal: AbortSignal.timeout(1500),
    });
    assert.equal((await health()).status, 401);
    assert.equal((await health('incorrect-password')).status, 401);
    assert.deepEqual(await (await health(config.password)).json(), { healthy: true, version: '1.18.18' });
    const unauthorizedControl = await fetch(`http://127.0.0.1:${owner.managementPort}/control`, {
      method: 'POST', body: JSON.stringify({ action: 'status', token: 'incorrect-token' }), signal: AbortSignal.timeout(1500),
    });
    assert.equal(unauthorizedControl.status, 403);

    // execFile has reaped the start command; the separately owned native service remains live.
    await delay(250);
    const observed = await cli(firstState, 'status');
    assert.equal(observed.pid, started.pid);
    assert.equal(observed.nativePid, started.nativePid);
    const repeated = await cli(firstState, 'start');
    assert.equal(repeated.pid, started.pid);
    assert.equal(repeated.nativePid, started.nativePid);
    assert.equal((await health(config.password)).status, 200);
    const stopped = await cli(firstState, 'stop');
    assert.equal(stopped.running, false);
    assert.equal(stopped.autoStart, false);
    await reservePort(port);

    const secondState = join(root, 'second-controller');
    states.push(secondState);
    const second = await cli(secondState, 'start');
    assert.equal(second.running, true);
    const secondConfig = JSON.parse(await readFile(join(privateDirectory(secondState, url), 'config.json'), 'utf8'));
    assert.ok(secondConfig.password !== config.password, 'Independent state directories must generate fresh credentials.');
    assert.equal((await health(config.password)).status, 401);
    assert.equal((await health(secondConfig.password)).status, 200);
    assert.equal((await cli(secondState, 'stop')).running, false);
    await reservePort(port);
    t.diagnostic('Verified authentication, detached lifetime, repeated-start PID reuse, fresh credentials, and port release. No model requests were sent.');
  });
