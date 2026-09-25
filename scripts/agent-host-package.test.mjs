import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { packageManager } from './lib/package-manager.mjs';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const require = createRequire(join(root, 'packages/agent-host/package.json'));
const { WebSocketServer } = require('ws');
const hostManifest = JSON.parse(await readFile(join(root, 'packages/agent-host/package.json'), 'utf8'));
const artifact = process.env.AGENT_HOST_PACKAGE ?? join(root, `dist/agent-remote-controller/orchardworks-agent-remote-controller-${hostManifest.version}.tgz`);

test('packs the public Controller name with the unchanged command and npm registry target', { timeout: 15000 }, async () => {
  const { stdout } = await exec('tar', ['-xOf', artifact, 'package/package.json'], { timeout: 10000 });
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.name, '@orchardworks/agent-remote-controller');
  assert.equal(manifest.name, hostManifest.name);
  assert.equal(manifest.version, hostManifest.version);
  assert.deepEqual(manifest.repository, { type: 'git', url: 'git+https://github.com/xuangong/agent-remote-control.git', directory: 'packages/agent-host' });
  assert.notEqual(manifest.private, true);
  assert.deepEqual(manifest.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' });
  assert.deepEqual(manifest.os, ['darwin', 'linux', 'win32']);
  assert.deepEqual(manifest.bin, { 'agent-remote-controller': 'dist/launcher.js' });
  assert.ok(Object.values(manifest.dependencies).every(version => !version.startsWith('workspace:')));
  assert.equal(manifest.dependencies['@opencode-ai/sdk'], '1.18.31');
});

test('installs the tarball independently and manages a paired daemon from a path containing spaces', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent host installed '));
  const prefix = join(directory, 'prefix with spaces');
  const state = join(directory, 'state');
  const windows = process.platform === 'win32';
  const packageRoot = join(prefix, windows ? 'node_modules/@orchardworks/agent-remote-controller' : 'lib/node_modules/@orchardworks/agent-remote-controller');
  const bin = join(prefix, windows ? 'agent-remote-controller.cmd' : 'bin/agent-remote-controller');
  const home = join(directory, 'home'); await mkdir(home);
  const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, AGENT_HOST_STATE_DIR: state,
    AGENT_HOST_PROVIDERS: 'codex,claude,copilot,opencode', AGENT_HOST_WORKSPACE: directory,
    AGENT_HOST_CLAUDE_HOME: join(home, 'claude'), AGENT_HOST_COPILOT_HOME: join(home, 'copilot') };
  if (process.platform === 'linux') Object.assign(env, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config') });
  const run = async (args, overrides = {}) => {
    try { return await exec(windows ? process.execPath : bin, windows ? [join(packageRoot, 'dist/launcher.js'), ...args] : args,
      { cwd: directory, env: { ...env, ...overrides }, timeout: 60000 }); }
    catch (error) {
      const log = await readFile(join(state, 'agent-host.log'), 'utf8').catch(() => '');
      throw new Error(`${error.message}\n${error.stdout ?? ''}${error.stderr ?? ''}\nDaemon diagnostics: ${log}`, { cause: error });
    }
  };
  t.after(async () => {
    const daemon = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8').catch(() => 'null'));
    if (['darwin', 'linux', 'win32'].includes(process.platform)) { try { await run(['autostart', 'disable']); } catch {} }
    try { await run(['stop']); } catch {}
    if (daemon) {
      try { process.kill(daemon.pid, 'SIGTERM'); } catch {}
      await waitFor(async () => {
        try { process.kill(daemon.pid, 0); return false; } catch { return true; }
      });
    }
    await rm(directory, { recursive: true, force: true });
  });
  await exec(...packageManager('npm', ['install', '--global', '--prefix', prefix, artifact,
    '--registry', process.env.npm_config_registry ?? 'https://mirrors.cloud.tencent.com/npm/', '--no-audit', '--no-fund']),
    { cwd: directory, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.match((await run(['--help'])).stdout, /Usage: agent-remote-controller/);
  assert.match((await run(['--help'])).stdout, /autostart/);
  if (windows) {
    const shim = await exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${bin}" --help"`],
      { cwd: directory, env, windowsVerbatimArguments: true, timeout: 10000 });
    assert.match(shim.stdout, /Usage: agent-remote-controller/);
    const powershellRun = exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(prefix, 'agent-remote-controller.ps1'), '--help'],
      { cwd: directory, env, timeout: 10000, windowsHide: true });
    // This invocation does not provide pipeline input.
    powershellRun.child.stdin.end();
    const powershell = await powershellRun;
    assert.match(powershell.stdout, /Usage: agent-remote-controller/, powershell.stderr);
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@orchardworks/agent-remote-controller');
  assert.deepEqual(Object.keys(manifest.bin), ['agent-remote-controller']);
  assert.ok(Object.values(manifest.dependencies).every(version => !version.startsWith('workspace:')));
  assert.equal(manifest.dependencies['@opencode-ai/sdk'], '1.18.31');
  assert.ok(Object.keys(manifest.dependencies).every(name => !name.startsWith('@orchardworks/')));
  await assert.rejects(run(['start']), /AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY are required/);
  await assert.rejects(run(['start'], { AGENT_HOST_REMOTE_KEY: 'key-without-relay' }), /Set AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY together/);
  for (const [provider, version] of [['codex', 'codex-cli 0.148.0'], ['claude', '2.1.247 (Claude Code)']]) {
    const executable = join(directory, `${provider}.cjs`);
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
  let rejectRegistration = windows;
  let sendHeartbeats = true;
  const diagnosticLog = async () => (await readFile(join(state, 'agent-host.log'), 'utf8')).split('\n').flatMap(line => {
    try { const event = JSON.parse(line); return typeof event.event === 'string' && event.event.startsWith('uplink_') ? [event] : []; }
    catch { return []; }
  });
  server.on('connection', socket => {
    let heartbeat;
    socket.once('close', () => clearInterval(heartbeat));
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'register') {
        if (rejectRegistration) { socket.close(1008, 'Invalid pairing key'); return; }
        registrations.push(message);
        socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'package-smoke-host', heartbeat: { intervalMs: 1000, timeoutMs: 500 } }));
        heartbeat = setInterval(() => {
          if (sendHeartbeats && socket.readyState === 1) socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: String(Date.now()) }));
        }, 1000);
      }
    });
  });
  const connection = { AGENT_HOST_SERVER: `http://127.0.0.1:${server.address().port}`, AGENT_HOST_REMOTE_KEY: 'local-package-test-key' };
  if (windows) {
    const started = Date.now();
    await assert.rejects(run(['start'], connection), error => {
      assert.match(error.cause.stderr, /authorization was rejected/);
      assert.match(error.cause.stderr, /Generate a new pairing key/);
      assert.ok(!error.cause.stderr.includes(connection.AGENT_HOST_REMOTE_KEY));
      return true;
    });
    assert.ok(Date.now() - started < 20000, 'An exited login daemon must not wait for the readiness deadline');
    rejectRegistration = false;
  }
  assert.match((await run(['start'], connection)).stdout, /daemon started/);
  await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
  const management = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const denied = await new Promise((resolve, reject) => {
    const socket = createConnection(management.socket); let output = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Management test timed out')));
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write('{"action":"stop",');
      socket.write('"token":"wrong-token"}\n');
    });
    socket.on('data', chunk => { output += chunk; });
    socket.on('close', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
  assert.deepEqual(denied, { error: 'Unauthorized local management request.' });
  assert.match((await run(['status'])).stdout, /uplink: registered/);
  assert.deepEqual(registrations[0].providers, []);
  assert.deepEqual(registrations.at(-1).providers.map(provider => provider.providerId), ['codex', 'claude', 'copilot', 'opencode']);
  const buildInfo = JSON.parse(await readFile(join(packageRoot, 'build-info.json'), 'utf8'));
  assert.deepEqual(registrations.at(-1).controller, {
    version: manifest.version, revision: buildInfo.revision, platform: process.platform,
    arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), remoteUpdate: !buildInfo.dirty,
  });
  assert.ok(Number.isInteger(management.launcherPid));
  assert.notEqual(management.launcherPid, management.pid);
  assert.equal(registrations.at(-1).installationId, registrations[0].installationId);
  const saved = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8'));
  assert.equal(saved.remoteKey, connection.AGENT_HOST_REMOTE_KEY);
  const beforeHeartbeatTimeout = registrations.length;
  sendHeartbeats = false;
  await waitFor(async () => (await diagnosticLog()).some(event => event.event === 'uplink_disconnected' && event.reason === 'heartbeat_timeout'));
  sendHeartbeats = true;
  await waitFor(async () => registrations.length > beforeHeartbeatTimeout && /uplink: registered/.test((await run(['status'])).stdout));
  const timeoutEvent = (await diagnosticLog()).find(event => event.reason === 'heartbeat_timeout');
  assert.equal(timeoutEvent.heartbeatTimeoutMs, 1500);
  assert.ok(Number.isFinite(Date.parse(timeoutEvent.timestamp)));
  assert.ok(Number.isInteger(timeoutEvent.pid));
  assert.ok((await diagnosticLog()).some(event => event.event === 'uplink_reconnect_scheduled' && event.retryDelayMs > 0));
  const beforeReportedTimeout = registrations.length;
  for (const socket of server.clients) socket.close(1012, 'Host heartbeat timed out');
  await waitFor(async () => registrations.length > beforeReportedTimeout && /uplink: registered/.test((await run(['status'])).stdout));
  assert.ok((await diagnosticLog()).some(event => event.event === 'uplink_disconnected' && event.reason === 'socket_closed'
    && event.closeCode === 1012 && event.peerReason === 'heartbeat_timeout'));
  const beforePeerClose = registrations.length;
  for (const socket of server.clients) socket.close(1012, `private peer text ${connection.AGENT_HOST_REMOTE_KEY}`);
  await waitFor(async () => registrations.length > beforePeerClose && /uplink: registered/.test((await run(['status'])).stdout));
  assert.ok((await diagnosticLog()).some(event => event.event === 'uplink_disconnected' && event.closeCode === 1012));
  assert.match((await run(['pair'], { ...connection, AGENT_HOST_REMOTE_KEY: 'replacement-package-test-key' })).stdout, /without restarting sessions/);
  const daemon = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  if (windows) assert.ok(daemon.socket.startsWith('\\\\.\\pipe\\agent-host-'));
  await run(['stop']);
  await assert.rejects(readFile(join(state, 'daemon.json')), { code: 'ENOENT' });
  await waitFor(async () => {
    try { process.kill(daemon.pid, 0); return false; } catch { return true; }
  });
  await waitFor(async () => server.clients.size === 0);
  const stoppedLog = await diagnosticLog();
  assert.ok(stoppedLog.some(event => event.event === 'uplink_closed' && event.reason === 'client_closed'));
  const rawLog = await readFile(join(state, 'agent-host.log'), 'utf8');
  assert.ok(!rawLog.includes(connection.AGENT_HOST_REMOTE_KEY));
  assert.ok(!rawLog.includes('replacement-package-test-key'));
  assert.ok(!rawLog.includes('private peer text'));
  assert.match((await run(['start'])).stdout, /daemon started/);
  await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
  assert.equal(JSON.parse(await readFile(join(state, 'connection.json'), 'utf8')).remoteKey, 'replacement-package-test-key');
  const supervised = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8')).supervisor;
  if (process.env.AGENT_HOST_TEST_REQUIRE_SYSTEMD === '1') assert.equal(supervised, 'systemd');
  if (supervised === 'launchd' || supervised === 'systemd') {
    assert.match((await run(['autostart', 'status'])).stdout, /enabled/i);
    const crashed = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
    process.kill(crashed.pid, 'SIGKILL');
    await waitFor(async () => {
      const restarted = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8').catch(() => 'null'));
      return restarted && restarted.pid !== crashed.pid && /uplink: registered/.test((await run(['status'])).stdout);
    });
    assert.equal(registrations.at(-1).installationId, registrations[0].installationId);
    assert.equal(JSON.parse(await readFile(join(state, 'connection.json'), 'utf8')).remoteKey, 'replacement-package-test-key');
    const exited = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
    process.kill(exited.pid, 'SIGTERM');
    await waitFor(async () => {
      const restarted = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8').catch(() => 'null'));
      return restarted && restarted.pid !== exited.pid && /uplink: registered/.test((await run(['status'])).stdout);
    });
    await run(['stop']);
    await waitFor(async () => server.clients.size === 0);
    await assert.rejects(run(['status']), /not running/);
    assert.match((await run(['autostart', 'status'])).stdout, /enabled/i);
    await new Promise(resolve => setTimeout(resolve, 11000));
    await assert.rejects(run(['status']), /not running/);
    let serviceFile;
    if (supervised === 'launchd') {
      const launchAgents = join(home, 'Library/LaunchAgents');
      const installedJobs = (await readdir(launchAgents)).filter(name => name.endsWith('.plist'));
      assert.equal(installedJobs.length, 1);
      serviceFile = join(launchAgents, installedJobs[0]);
    } else {
      const name = `agent-remote-controller-${createHash('sha256').update(state).digest('hex').slice(0, 16)}.service`;
      serviceFile = join(env.XDG_CONFIG_HOME, 'systemd/user', name);
    }
    const metadata = await readFile(serviceFile, 'utf8');
    assert.ok(!metadata.includes(connection.AGENT_HOST_REMOTE_KEY));
    assert.ok(!metadata.includes('replacement-package-test-key'));
    // Load the persisted job directly, as login does, without running the CLI setup again.
    if (supervised === 'launchd') await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, serviceFile], { timeout: 15000 });
    else await exec('systemctl', ['--user', 'start', serviceFile.split('/').at(-1)], { env: { ...process.env, ...env }, timeout: 15000 });
    await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
    await run(['autostart', 'disable']);
    assert.match((await run(['autostart', 'status'])).stdout, /disabled/i);
    await assert.rejects(run(['status']), /not running/);
    await run(['start']);
    await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
    assert.match((await run(['autostart', 'status'])).stdout, /disabled/i);
    await run(['stop']);
    await run(['autostart', 'enable']);
    await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
    assert.match((await run(['autostart', 'status'])).stdout, /enabled/i);
  } else if (supervised === 'windows') {
    assert.match((await run(['autostart', 'status'])).stdout, /enabled.*installed/);
    await run(['stop']);
    await assert.rejects(run(['status']), /not running/);
    const startup = join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup');
    const launchers = (await readdir(startup)).filter(name => name.endsWith('.vbs'));
    assert.equal(launchers.length, 1);
    await exec('wscript.exe', ['//B', '//Nologo', join(startup, launchers[0])], { env, timeout: 10000, windowsHide: true });
    await waitFor(async () => /uplink: registered/.test((await run(['status'])).stdout));
    await run(['autostart', 'disable']);
    assert.match((await run(['autostart', 'status'])).stdout, /disabled.*not installed/);
    await assert.rejects(run(['status']), /not running/);
    await run(['start']);
    assert.match((await run(['status'])).stdout, /supervisor: manual/);
    await run(['autostart', 'enable']);
    assert.match((await run(['status'])).stdout, /supervisor: manual/);
    await run(['stop']); await run(['start']);
    assert.match((await run(['status'])).stdout, /supervisor: windows/);
  } else if (process.platform === 'linux') {
    assert.match((await run(['autostart', 'status'])).stdout, /systemd user manager unavailable/);
    await assert.rejects(run(['autostart', 'enable']), /systemd user manager is unavailable/);
    await run(['autostart', 'disable']);
    assert.match((await run(['status'])).stdout, /supervisor: manual/);
    await run(['stop']);
    await run(['start']);
    assert.match((await run(['autostart', 'status'])).stdout, /disabled/i);
  }
});

async function waitFor(check) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Packaged Agent Host did not reach the expected state.', { cause: lastError });
}
