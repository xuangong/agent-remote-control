import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDevbox, devboxConfiguration } from './start.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-devbox-supervisor-'));
  const command = join(directory, 'controller.mjs');
  await writeFile(command, `import {mkdir,writeFile,appendFile,stat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2), state=process.env.AGENT_HOST_STATE_DIR;
if(args[0]==='opencode' && args[1]==='callbacks') {
  await mkdir(args[3]); await writeFile(join(args[3],'opencode-arc.json'),'{}'); process.exit(0);
}
if(args[0]!=='foreground') process.exit(5);
const codexHome=process.env.AGENT_REMOTE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(process.env.HOME,'.codex');
try { if(!(await stat(codexHome)).isDirectory()) process.exit(6); } catch { process.exit(6); }
const codexSettings=JSON.parse(await readFile(join(codexHome,'app-server-daemon/settings.json'),'utf8'));
if(codexSettings.updater?.autoUpdateEnabled!==false) process.exit(8);
await mkdir(state,{recursive:true});
await appendFile(join(state,'starts.jsonl'),JSON.stringify({key:process.env.AGENT_HOST_REMOTE_KEY,server:process.env.AGENT_HOST_SERVER,callback:process.env.AGENT_HOST_OPENCODE_CALLBACK_CONFIG,native:process.env.OPENCODE_CONFIG,codexHome,selectedCodexHome:process.env.CODEX_HOME,codexExecutable:process.env.AGENT_HOST_CODEX,codexSettings})+'\\n');
if(process.env.AGENT_HOST_REMOTE_KEY) await writeFile(join(state,'connection.json'),JSON.stringify({serverUrl:process.env.AGENT_HOST_SERVER,remoteKey:'issued-device',environment:{}}));
if(process.env.FIXTURE_EXIT) process.exit(Number(process.env.FIXTURE_EXIT));
process.on('SIGTERM',async()=>{await writeFile(join(state,'stopped'),'yes');process.exit(0)});
setInterval(()=>{},1000);
`);
  let invitations = 0;
  const server = createHttpServer((_request, response) => response.end('ready'));
  const probe = createHttpServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const environment = { ...process.env, DEVBOX_CONTROLLER: command, DEVBOX_PORT: String(port),
    DEVBOX_STATE_DIR: join(directory, 'relay'), AGENT_HOST_STATE_DIR: join(directory, 'host'),
    AGENT_HOST_WORKSPACE: directory, DEVBOX_BIND: '127.0.0.1', HOME: join(directory, 'native-home') };
  delete environment.CODEX_HOME;
  delete environment.AGENT_REMOTE_CODEX_HOME;
  const createServer = async ({ origin }) => ({
    listen: (listenPort, bind) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, bind, resolve); }),
    close: () => new Promise(resolve => server.close(resolve)),
    getConnection: async () => { invitations++; return { serverUrl: origin, remoteKey: 'one-time-invite' }; },
  });
  const waitFor = async path => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { try { return await readFile(path, 'utf8'); } catch { await delay(10); } }
    throw new Error('Fixture did not become ready.');
  };
  return { directory, environment, createServer, waitFor, invitations: () => invitations,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('registers once, retains issued credentials on restart and closes its child', { timeout: 12000 }, async () => {
  const f = await fixture(); let running;
  try {
    running = await startDevbox({ environment: f.environment, createServer: f.createServer });
    assert.equal(await (await fetch(running.origin)).text(), 'ready');
    await f.waitFor(join(f.environment.AGENT_HOST_STATE_DIR, 'connection.json'));
    await running.close();
    assert.equal(await f.waitFor(join(f.environment.AGENT_HOST_STATE_DIR, 'stopped')), 'yes');
    assert.equal(f.invitations(), 1);
    assert.equal((await stat(join(f.environment.HOME, '.codex'))).isDirectory(), true);
    await rm(join(f.environment.HOME, '.codex'), { recursive: true });
    running = await startDevbox({ environment: f.environment, createServer: f.createServer });
    const deadline = Date.now() + 3000; let starts;
    do { starts = (await f.waitFor(join(f.environment.AGENT_HOST_STATE_DIR, 'starts.jsonl'))).trim().split('\n').map(JSON.parse); if (starts.length === 2) break; await delay(10); } while (Date.now() < deadline);
    assert.equal(starts.length, 2);
    assert.equal(starts[0].key, 'one-time-invite');
    assert.equal(starts[1].key, undefined);
    assert.equal(starts[1].server, undefined);
    assert.ok(starts[1].callback.endsWith('/callback.json'));
    assert.ok(starts[1].native.endsWith('/opencode-arc.json'));
    assert.notEqual(starts[0].callback, starts[1].callback);
    assert.equal(starts[1].codexHome, join(f.environment.HOME, '.codex'));
    assert.equal(starts[1].selectedCodexHome, join(f.environment.HOME, '.codex'));
    assert.equal(starts[1].codexExecutable, f.environment.AGENT_HOST_CODEX ?? f.environment.AGENT_REMOTE_CODEX_EXECUTABLE ?? 'codex');
    assert.deepEqual(starts[0].codexSettings, { updater: { autoUpdateEnabled: false } });
    assert.deepEqual(starts[1].codexSettings, { updater: { autoUpdateEnabled: false } });
    assert.equal(f.invitations(), 1);
  } finally { await running?.close(); await f.cleanup(); }
});

test('prepares an explicitly selected Codex profile without replacing its contents', { timeout: 10000 }, async () => {
  const f = await fixture(); let running;
  try {
    const profile = join(f.directory, 'custom', 'codex');
    const environment = { ...f.environment, CODEX_HOME: join(f.directory, 'unselected'), AGENT_REMOTE_CODEX_HOME: profile };
    const settingsPath = join(profile, 'app-server-daemon', 'settings.json');
    await mkdir(join(profile, 'app-server-daemon'), { recursive: true });
    const original = { updater: { autoUpdateEnabled: true, updateIntervalMinutes: 1440 }, shutdownGraceSeconds: 180, futureSetting: 'preserved' };
    await writeFile(settingsPath, JSON.stringify(original));
    running = await startDevbox({ environment, createServer: f.createServer });
    await f.waitFor(join(f.environment.AGENT_HOST_STATE_DIR, 'connection.json'));
    await running.close();
    const configured = await readFile(settingsPath, 'utf8');
    assert.deepEqual(JSON.parse(configured), { ...original, updater: { ...original.updater, autoUpdateEnabled: false } });
    const configuredStat = await stat(settingsPath);
    await writeFile(join(profile, 'config.toml'), 'model = "test-preserved"\n');
    running = await startDevbox({ environment, createServer: f.createServer });
    assert.equal(await readFile(join(profile, 'config.toml'), 'utf8'), 'model = "test-preserved"\n');
    assert.equal(await readFile(settingsPath, 'utf8'), configured);
    assert.equal((await stat(settingsPath)).mtimeMs, configuredStat.mtimeMs);
  } finally { await running?.close(); await f.cleanup(); }
});

test('rejects invalid Codex daemon settings without changing them or starting services', { timeout: 5000 }, async () => {
  const f = await fixture();
  const settingsPath = join(f.environment.HOME, '.codex/app-server-daemon/settings.json');
  try {
    await mkdir(join(f.environment.HOME, '.codex/app-server-daemon'), { recursive: true });
    for (const invalid of ['{invalid json', 'null', '[]', '{"updater":false}']) {
      await writeFile(settingsPath, invalid);
      await assert.rejects(startDevbox({ environment: f.environment, createServer: f.createServer }), /Cannot read valid Codex daemon settings/);
      assert.equal(await readFile(settingsPath, 'utf8'), invalid);
      assert.equal(f.invitations(), 0);
    }
  } finally { await f.cleanup(); }
});

test('a failed Controller stops the web server and resolves as failed', { timeout: 8000 }, async () => {
  const f = await fixture(); let running;
  try {
    running = await startDevbox({ environment: { ...f.environment, FIXTURE_EXIT: '7' }, createServer: f.createServer });
    assert.equal(await running.done, 7);
    await assert.rejects(fetch(running.origin));
  } finally { await running?.close(); await f.cleanup(); }
});

test('does not reuse Host state belonging to a different site', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await mkdir(f.environment.AGENT_HOST_STATE_DIR);
    await writeFile(join(f.environment.AGENT_HOST_STATE_DIR, 'connection.json'), JSON.stringify({ serverUrl: 'https://another.example', remoteKey: 'device' }));
    await assert.rejects(startDevbox({ environment: f.environment, createServer: f.createServer }), /another Relay/);
    assert.equal(f.invitations(), 0);
  } finally { await f.cleanup(); }
});

test('requires the local origin and listening port to describe the same devbox', { timeout: 1000 }, () => {
  assert.equal(devboxConfiguration({ DEVBOX_PORT: '6000' }).origin, 'http://localhost:6000');
  for (const environment of [{ DEVBOX_PORT: '0' }, { DEVBOX_PORT: '5910', DEVBOX_ORIGIN: 'http://localhost:6000' }, { DEVBOX_ORIGIN: 'https://public.example' }])
    assert.throws(() => devboxConfiguration(environment));
});
