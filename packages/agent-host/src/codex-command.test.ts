import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCodexCommand } from './codex-command.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arc-codex-command-')); roots.push(root);
  const capture = join(root, 'native.json'); const executable = join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('codex-cli '+(process.env.TEST_CODEX_VERSION??'0.159.2'));process.exit(0);}
require('node:fs').writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,key:process.env.CODEX_GATEWAY_API_KEY,relayKey:process.env.AGENT_HOST_REMOTE_KEY,locale:process.env.LC_ALL,openaiKey:process.env.OPENAI_API_KEY}));\n`, { mode: 0o700 });
  const environment = { AGENT_HOST_CODEX: executable, TEST_CAPTURE: capture };
  return { root, environment, captured: async () => JSON.parse(await readFile(capture, 'utf8')) };
}
it('migrates legacy private commands to shared and preserves explicit endpoints', async () => {
  const f = await fixture();
  expect(await runCodexCommand(['resume', '--last'], f.root, { ...f.environment, CODEX_HOME: f.root, AGENT_HOST_CODEX_CONNECTION: 'private' })).toBe(0);
  expect((await f.captured()).args).toEqual(['--remote', `unix://${f.root}/app-server-control/app-server-control.sock`, 'resume', '--last']);
  expect(await runCodexCommand(['--remote', 'unix:///intentional.sock'], f.root, { ...f.environment, AGENT_HOST_CODEX_CONNECTION: 'private' })).toBe(0);
  expect((await f.captured()).args).toEqual(['--remote', 'unix:///intentional.sock']);
}, 10000);
it('loads the managed Gateway key and private home from the saved opt-in for native commands', async () => {
  const f = await fixture(); const home = join(f.root, 'gateway-codex'); await mkdir(home);
  await writeFile(join(home, 'gateway-credentials.json'), JSON.stringify({ apiKey: 'sk_private_gateway_key', keyId: 'host-key',
    baseUrl: 'https://gateway.example/v1', model: 'codex-test', hostId: 'host', serverUrl: 'https://relay.example', configHash: 'fixture' }));
  await writeFile(join(f.root, 'connection.json'), JSON.stringify({ serverUrl: 'https://relay.example', remoteKey: 'device-secret',
    environment: { AGENT_HOST_BOOTSTRAP_CODEX: '1', AGENT_HOST_CODEX: f.environment.AGENT_HOST_CODEX } }));
  expect(await runCodexCommand(['exec', 'hello'], f.root, { TEST_CAPTURE: f.environment.TEST_CAPTURE })).toBe(0);
  expect(await f.captured()).toEqual({ args: ['--remote', `unix://${home}/app-server-control/app-server-control.sock`, 'exec', 'hello'], home, key: 'sk_private_gateway_key', locale: 'C' });
}, 10000);

it.each([
  ['daemon', 'start'], ['daemon', 'restart'],
  ['app-server', 'daemon', 'start'], ['app-server', 'daemon', 'restart'],
])('injects the daemon API key for %j', async (...args) => {
  const f = await fixture();
  for (const inheritedKey of [undefined, '', 'inherited-key']) {
    expect(await runCodexCommand(args, f.root, {
      ...f.environment, CODEX_HOME: join(f.root, 'home'), OPENAI_API_KEY: inheritedKey,
      CODEX_GATEWAY_API_KEY: 'gateway-key',
    })).toBe(0);
    expect(await f.captured()).toMatchObject({
      args: ['app-server', 'daemon', args.at(-1) === 'restart' ? 'bootstrap' : 'start'],
      openaiKey: 'arc', key: 'gateway-key', locale: 'C',
    });
  }
}, 10000);
it.each([['exec', 'hello'], ['daemon', 'status'], ['daemon', 'stop']])(
  'preserves the API key outside daemon startup for %j', async (...args) => {
    const f = await fixture();
    expect(await runCodexCommand(args, f.root, { ...f.environment, OPENAI_API_KEY: 'inherited-key' })).toBe(0);
    expect((await f.captured()).openaiKey).toBe('inherited-key');
  }, 10000);

it('persists daemon lifecycle intent, environment presence and result without credentials', async () => {
  const f = await fixture();
  const home = join(f.root, 'home');
  expect(await runCodexCommand(['daemon', 'restart'], f.root, { ...f.environment, CODEX_HOME: home,
    OPENAI_API_KEY: 'private-openai-value', CODEX_GATEWAY_API_KEY: 'private-gateway-value' })).toBe(0);
  const text = await readFile(join(f.root, 'codex-daemon.log'), 'utf8');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(event => event.event)).toEqual(['daemon_command_started', 'daemon_command_dispatched', 'daemon_command_completed']);
  expect(events[0]).toMatchObject({ origin: 'cli', action: 'restart', environment: { OPENAI_API_KEY: 'present', CODEX_GATEWAY_API_KEY: 'present' } });
  expect(events[1]).toMatchObject({ operationId: events[0].operationId, targetPid: expect.any(Number) });
  expect(events[2]).toMatchObject({ operationId: events[0].operationId, exitCode: 0 });
  expect(text).not.toContain('private-openai-value');
  expect(text).not.toContain('private-gateway-value');
}, 10000);
it('keeps a website restart operation identifiable and appends failures instead of overwriting evidence', async () => {
  const f = await fixture();
  const operationId = '00000000-0000-4000-8000-000000000001';
  await writeFile(f.environment.AGENT_HOST_CODEX, '#!/usr/bin/env node\nif(process.argv[2] === "--version") { console.log("codex-cli 0.159.2"); process.exit(0); }\nprocess.exit(7);\n', { mode: 0o700 });
  expect(await runCodexCommand(['daemon', 'restart'], f.root, { ...f.environment, CODEX_HOME: join(f.root, 'home'),
    AGENT_HOST_DAEMON_ORIGIN: 'website', AGENT_HOST_DAEMON_OPERATION_ID: operationId })).toBe(7);
  await runCodexCommand(['daemon', 'stop'], f.root, { ...f.environment, CODEX_HOME: join(f.root, 'home') });
  const events = (await readFile(join(f.root, 'codex-daemon.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events).toHaveLength(6);
  expect(events[0]).toMatchObject({ operationId, origin: 'website', event: 'daemon_command_started' });
  expect(events[2]).toMatchObject({ operationId, exitCode: 7 });
  expect(events[3].operationId).not.toBe(operationId);
}, 10000);


it.each([true, false])('restarts the updater through bootstrap while preserving remote control = %s', async remoteControlEnabled => {
  const f = await fixture(); const home = join(f.root, 'home');
  const settingsPath = join(home, 'app-server-daemon', 'settings.json');
  await mkdir(join(home, 'app-server-daemon'), { recursive: true });
  const settings = { remoteControlEnabled, featureOverrides: { remote_control: false },
    updater: { autoUpdateEnabled: false, updateIntervalMinutes: 1440 }, shutdownGraceSeconds: 180, futureSetting: 'preserved' };
  await writeFile(settingsPath, JSON.stringify(settings));
  expect(await runCodexCommand(['daemon', 'restart'], f.root, { ...f.environment, CODEX_HOME: home })).toBe(0);
  expect(await f.captured()).toMatchObject({
    args: ['app-server', 'daemon', 'bootstrap', ...(remoteControlEnabled ? ['--remote-control'] : [])],
    openaiKey: 'arc', home, locale: 'C',
  });
  expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(settings);
}, 10000);

it('preserves restart feature arguments and applies native defaults when daemon settings do not exist', async () => {
  const f = await fixture();
  expect(await runCodexCommand(['daemon', 'restart', '--enable', 'feature_a', '-c', 'features.feature_b=false'], f.root,
    { ...f.environment, CODEX_HOME: join(f.root, 'new-home') })).toBe(0);
  expect((await f.captured()).args).toEqual(['app-server', 'daemon', 'bootstrap', '--enable', 'feature_a', '-c', 'features.feature_b=false']);
}, 10000);

it.each(['{invalid-json', 'null', '[]', '{"remoteControlEnabled":"true"}'])('refuses unreadable settings before changing native processes: %s', async settings => {
  const f = await fixture(); const home = join(f.root, 'home');
  await mkdir(join(home, 'app-server-daemon'), { recursive: true });
  await writeFile(join(home, 'app-server-daemon', 'settings.json'), settings);
  await expect(runCodexCommand(['daemon', 'restart'], f.root, { ...f.environment, CODEX_HOME: home })).rejects.toThrow(/settings/i);
  await expect(f.captured()).rejects.toMatchObject({ code: 'ENOENT' });
}, 10000);

it.each(['0.154.0', '0.155.0', 'unrecognized'])('does not bootstrap through a CLI that cannot preserve managed settings and layout: %s', async version => {
  const f = await fixture();
  await expect(runCodexCommand(['daemon', 'restart'], f.root,
    { ...f.environment, CODEX_HOME: join(f.root, 'home'), TEST_CODEX_VERSION: version })).rejects.toThrow(/0\.156|update Codex/i);
  await expect(f.captured()).rejects.toMatchObject({ code: 'ENOENT' });
}, 10000);

it.each(['0.156.0', '0.159.2', '1.0.0'])('accepts compatible CLI releases without exact-version pinning: %s', async version => {
  const f = await fixture();
  expect(await runCodexCommand(['daemon', 'restart'], f.root,
    { ...f.environment, CODEX_HOME: join(f.root, 'home'), TEST_CODEX_VERSION: version })).toBe(0);
  expect((await f.captured()).args).toEqual(['app-server', 'daemon', 'bootstrap']);
}, 10000);

it('keeps restart help read-only even with unreadable settings or an older CLI', async () => {
  const f = await fixture(); const home = join(f.root, 'home');
  await mkdir(join(home, 'app-server-daemon'), { recursive: true });
  await writeFile(join(home, 'app-server-daemon', 'settings.json'), 'invalid');
  expect(await runCodexCommand(['daemon', 'restart', '--help'], f.root,
    { ...f.environment, CODEX_HOME: home, TEST_CODEX_VERSION: '0.154.0' })).toBe(0);
  expect((await f.captured()).args).toEqual(['app-server', 'daemon', 'restart', '--help']);
}, 10000);
