import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignCodexRuntime, prepareCodexProfile } from './codex-profile.mjs';

async function fixture({ legacy = false, installed = '0.162.0', managed = '0.161.0' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-devbox-codex-profile-'));
  const home = join(directory, 'profile');
  const current = join(home, 'packages', legacy ? 'standalone' : 'app-server-daemon', 'current');
  const binary = join(current, legacy ? 'codex' : 'bin/codex');
  const cli = join(directory, 'native-codex');
  const versionPath = join(directory, 'managed-version');
  const logPath = join(directory, 'commands.jsonl');
  const executable = role => `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), role = ${JSON.stringify(role)};
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({role,args,home:process.env.CODEX_HOME})+'\\n');
if(args.length===1 && args[0]==='--version') {
  const version = role==='cli' ? process.env.FIXTURE_CLI_VERSION : fs.readFileSync(process.env.FIXTURE_VERSION,'utf8');
  if(version==='read-failed') process.exit(3);
  console.log('codex-cli '+version); process.exit(0);
}
if(role==='cli' && JSON.stringify(args)===JSON.stringify(['app-server','daemon','update','--from-cli','--yes'])) {
  if(process.env.FIXTURE_UPDATE==='fail') process.exit(4);
  if(process.env.FIXTURE_UPDATE!=='unchanged') fs.writeFileSync(process.env.FIXTURE_VERSION,process.env.FIXTURE_UPDATE==='read-failed' ? 'read-failed' : process.env.FIXTURE_CLI_VERSION);
  process.exit(0);
}
process.exit(5);
`;
  await writeFile(cli, executable('cli')); await chmod(cli, 0o700);
  await writeFile(versionPath, managed);
  const environment = { ...process.env, AGENT_HOST_CODEX: cli, CODEX_HOME: join(directory, 'unselected-profile'),
    FIXTURE_LOG: logPath, FIXTURE_VERSION: versionPath, FIXTURE_CLI_VERSION: installed };
  const seed = async () => {
    await mkdir(join(binary, '..'), { recursive: true });
    await writeFile(binary, executable('managed')); await chmod(binary, 0o700);
    if (legacy) {
      await mkdir(join(home, 'app-server-daemon'), { recursive: true });
      await writeFile(join(home, 'app-server-daemon/app-server.stderr.log'), '');
    }
  };
  const commands = async () => {
    try { return (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { directory, home, current, environment, seed, commands,
    run: env => alignCodexRuntime(home, { ...environment, ...env }, directory),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('a cold Codex profile does not probe or update a managed runtime', { timeout: 3000 }, async () => {
  const f = await fixture();
  try {
    await prepareCodexProfile(f.home);
    await writeFile(join(f.home, 'app-server-daemon/daemon.pid.lock'), '');
    await f.run();
    assert.deepEqual(await f.commands(), []);
  } finally { await f.cleanup(); }
});

test('an equal managed version is read without updating or starting it', { timeout: 3000 }, async () => {
  const f = await fixture({ managed: '0.162.0' });
  try {
    await f.seed(); await f.run();
    const commands = await f.commands();
    assert.equal(commands.length, 2);
    assert.ok(commands.every(command => command.args.join(' ') === '--version'));
    assert.ok(commands.every(command => command.home === f.home));
  } finally { await f.cleanup(); }
});

for (const legacy of [false, true]) test(`aligns ${legacy ? 'legacy' : 'dedicated'} runtime with one native update and a readback`, { timeout: 5000 }, async () => {
  const f = await fixture({ legacy, managed: '0.163.0' });
  try {
    await f.seed(); await f.run();
    const commands = await f.commands();
    assert.deepEqual(commands.map(command => [command.role, command.args]), [
      ['cli', ['--version']], ['managed', ['--version']],
      ['cli', ['app-server', 'daemon', 'update', '--from-cli', '--yes']], ['managed', ['--version']],
    ]);
    assert.ok(commands.every(command => command.home === f.home));
    await f.run();
    assert.equal((await f.commands()).filter(command => command.args.includes('update')).length, 1);
  } finally { await f.cleanup(); }
});

for (const result of ['fail', 'unchanged', 'read-failed']) test(`rejects a failed runtime alignment: ${result}`, { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await f.seed();
    await assert.rejects(f.run({ FIXTURE_UPDATE: result }), /Codex.*(?:update|version)/);
    assert.equal((await f.commands()).filter(command => command.args.includes('update')).length, 1);
  } finally { await f.cleanup(); }
});

test('a broken current package is an error rather than a cold profile', { timeout: 3000 }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.current, '..'), { recursive: true });
    await symlink(join(f.directory, 'missing-release'), f.current);
    await assert.rejects(f.run(), /managed Codex runtime/);
    assert.deepEqual(await f.commands(), []);
  } finally { await f.cleanup(); }
});

test('dedicated launch evidence takes precedence over an old standalone package', { timeout: 3000 }, async () => {
  const f = await fixture({ legacy: true });
  try {
    await f.seed();
    await writeFile(join(f.home, 'app-server-daemon/daemon.stderr.log'), '');
    await assert.rejects(f.run(), /managed Codex runtime/);
    assert.deepEqual(await f.commands(), []);
  } finally { await f.cleanup(); }
});
