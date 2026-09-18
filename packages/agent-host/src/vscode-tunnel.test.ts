import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createVscodeTunnelManager } from './vscode-tunnel.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.unstubAllEnvs(); });

async function manager(mode = 'ready', disconnectTimeoutMs = 300_000) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-vscode-test-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'cli.cjs');
  await writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = args[args.indexOf('--cli-data-dir') + 1];
const status = path.join(root, 'fixture-status.json');
if (args.includes('--help')) {
  console.log(${JSON.stringify(mode)} === 'unsupported' ? 'Usage: code [files]' : 'Usage: code tunnel [OPTIONS] --accept-server-license-terms --cli-data-dir');
} else if (args.includes('status')) {
  process.stdout.write(fs.existsSync(status) ? fs.readFileSync(status) : '{"tunnel":null}');
} else {
  fs.writeFileSync(path.join(root, 'fixture-start.json'), JSON.stringify({pid:process.pid,cwd:process.cwd(),args, secret:process.env.AGENT_HOST_REMOTE_KEY}));
  process.stdout.write('To grant access to the server, please log into https://github.com/login/device and use code 9491-');
  setTimeout(() => process.stdout.write('B98B\\n'), 10);
  if (${JSON.stringify(mode)} !== 'auth') setTimeout(() => {
    fs.writeFileSync(status, JSON.stringify({tunnel:{name:'test-machine', tunnel:'Connected'}}));
    process.stderr.write('  ➜  Tunnel:   test-machine\\n');
    process.stdout.write('__VSCODE_CLI_STATUS__'+JSON.stringify({type:'connected',tunnelName:'test-machine',isAttached:${JSON.stringify(mode)} === 'attached'})+'\\n');
  }, 100);
  if (${JSON.stringify(mode)} === 'exit') setTimeout(() => process.exit(7), 300);
  if (${JSON.stringify(mode)} === 'stubborn') process.on('SIGTERM', () => {});
  if (${JSON.stringify(mode)} === 'noise') process.stdout.write('x'.repeat(100000));
  setInterval(() => {}, 1000);
}
`);
  const value = createVscodeTunnelManager({ stateDirectory: directory, installationId: 'host-test',
    executable: process.execPath, executableArgs: [script], statusIntervalMs: 100, stopTimeoutMs: 100, disconnectTimeoutMs });
  disposers.push(() => value.close());
  return { value, directory };
}

test('captures split authorization output and shares one process between starts', async () => {
  const { value } = await manager();
  expect(value.snapshot()).toMatchObject({ status: 'checking', processAlive: false });
  await Promise.all([value.start(true), value.start(true)]);
  await expect.poll(() => value.snapshot().authorization?.code).toBe('9491-B98B');
  const pid = value.snapshot().pid;
  expect(value.snapshot().authorization?.url).toBe('https://github.com/login/device');
  await value.start(true);
  expect(value.snapshot().pid).toBe(pid);
  await expect.poll(() => value.snapshot().status).toBe('connected');
  expect(value.snapshot()).toMatchObject({ processAlive: true, tunnelName: 'test-machine', link: 'https://vscode.dev/tunnel/test-machine' });
  expect(value.snapshot().authorization).toBeUndefined();
  await value.stop();
  expect(value.snapshot()).toMatchObject({ status: 'stopped', processAlive: false });
  expect(value.snapshot().link).toBeUndefined();
});

test('reports external termination and clears authorization and stale links', async () => {
  const { value } = await manager('exit');
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('connected');
  await expect.poll(() => value.snapshot().status).toBe('exited');
  expect(value.snapshot()).toMatchObject({ exitCode: 7, processAlive: false });
  expect(value.snapshot().link).toBeUndefined();
});

test('requires license consent and escalates stopping an unresponsive process', async () => {
  const { value } = await manager('stubborn');
  await expect(value.start(false)).rejects.toThrow('license');
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('connected');
  await value.stop();
  expect(value.snapshot().processAlive).toBe(false);
});

test('uses the Controller home and dedicated CLI directory without forwarding Host secrets', async () => {
  vi.stubEnv('AGENT_HOST_REMOTE_KEY', 'fixture-secret-not-for-child');
  const { value, directory } = await manager('auth');
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('awaiting_auth');
  const { readFile } = await import('node:fs/promises');
  const record = JSON.parse(await readFile(join(directory, 'vscode-tunnel', 'fixture-start.json'), 'utf8'));
  expect(record.cwd).toBe(await realpath(directory));
  expect(record.args.slice(0, 3)).toEqual(['tunnel', '--cli-data-dir', join(directory, 'vscode-tunnel')]);
  expect(record.secret).toBeUndefined();
});

test('distinguishes a live process from a disconnected tunnel and recovers its link', async () => {
  const { value, directory } = await manager();
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('connected');
  const status = join(directory, 'vscode-tunnel', 'fixture-status.json');
  await writeFile(status, JSON.stringify({ tunnel: { name: 'test-machine', tunnel: 'Disconnected' } }));
  await expect.poll(() => value.snapshot().status).toBe('connecting');
  expect(value.snapshot().processAlive).toBe(true);
  expect(value.snapshot().link).toBeUndefined();
  await writeFile(status, JSON.stringify({ tunnel: { name: 'test-machine', tunnel: 'Connected' } }));
  await expect.poll(() => value.snapshot().link).toBe('https://vscode.dev/tunnel/test-machine');
});

test('reports a missing executable and rejects starts after shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-vscode-missing-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const value = createVscodeTunnelManager({ stateDirectory: directory, installationId: 'missing', executable: join(directory, 'missing') });
  disposers.push(() => value.close());
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('unavailable');
  expect(value.snapshot().message).toContain('not found');
  expect(value.snapshot().processAlive).toBe(false);
  await value.close();
  await expect(value.start(true)).rejects.toThrow('closed');
});

test('keeps short Relay interruptions but reclaims a tunnel after sustained disconnection', async () => {
  const { value } = await manager('auth', 150);
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('awaiting_auth');
  value.setRelayConnected(false);
  value.setRelayConnected(true);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(value.snapshot().processAlive).toBe(true);
  value.setRelayConnected(false);
  // Connecting retries must not extend the original disconnection deadline.
  value.setRelayConnected(false);
  await expect.poll(() => value.snapshot().processAlive).toBe(false);
  expect(value.snapshot().message).toContain('disconnected');
  expect(value.snapshot().authorization).toBeUndefined();
  await expect(value.start(true)).rejects.toThrow('Reconnect');
  value.setRelayConnected(true);
  expect(value.snapshot().processAlive).toBe(false);
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('awaiting_auth');
});

test('disables a CLI without the tunnel subcommand without starting a tunnel', async () => {
  const { value, directory } = await manager('unsupported');
  expect(await value.start(true)).toMatchObject({ status: 'unavailable', processAlive: false });
  expect(value.snapshot().message).toContain('supported code tunnel command');
  const { access } = await import('node:fs/promises');
  await expect(access(join(directory, 'vscode-tunnel', 'fixture-start.json'))).rejects.toThrow();
});

test('disables the feature when code is absent from the Controller PATH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-vscode-path-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('PATH', directory);
  const value = createVscodeTunnelManager({ stateDirectory: directory, installationId: 'missing-path' });
  disposers.push(() => value.close());
  expect(await value.start(true)).toMatchObject({ status: 'unavailable', processAlive: false });
  expect(value.snapshot().message).toContain('not found');
});

test('refuses to adopt a tunnel whose singleton belongs to another process', async () => {
  const { value } = await manager('attached');
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('failed');
  expect(value.snapshot().processAlive).toBe(false);
  expect(value.snapshot().link).toBeUndefined();
  expect(value.snapshot().message).toContain('will not attach');
});

test('reclaims the native process even if its supervisor is externally killed', async () => {
  const { value, directory } = await manager('stubborn');
  await value.start(true);
  await expect.poll(() => value.snapshot().status).toBe('connected');
  const { readFile } = await import('node:fs/promises');
  const record = JSON.parse(await readFile(join(directory, 'vscode-tunnel', 'fixture-start.json'), 'utf8'));
  process.kill(value.snapshot().pid!, 'SIGKILL');
  await expect.poll(() => value.snapshot().status).toBe('exited');
  await expect.poll(() => { try { process.kill(record.pid, 0); return true; } catch { return false; } }).toBe(false);
});
