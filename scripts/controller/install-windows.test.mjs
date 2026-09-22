import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../install.ps1', import.meta.url));
const ps = process.env.AGENT_INSTALLER_POWERSHELL ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const version = '1.2.3', revision = 'b'.repeat(40), invitation = 'arc_' + 'a'.repeat(43);
const windowsTest = (name, fn) => test(name, { timeout: 45000, skip: process.platform !== 'win32' }, fn);
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "arc installer's 中文 "));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const pkg = join(root, 'package'), bin = join(root, 'tools'), prefix = join(root, 'installed'), commands = join(prefix, 'bin'), state = join(root, 'state');
  await mkdir(join(pkg, 'dist'), { recursive: true }); await mkdir(bin);
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@orchardworks/agent-remote-controller', version, type: 'module', scripts: { install: 'node -e "process.exit(99)"' } }));
  await writeFile(join(pkg, 'build-info.json'), JSON.stringify({ version, revision: options.badIdentity ? 'c'.repeat(40) : revision, dirty: false }));
  await writeFile(join(pkg, 'dist/launcher.js'), `import fs from 'node:fs';
const args=process.argv.slice(2),state=process.env.AGENT_HOST_STATE_DIR;
fs.appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'cli',args,state,key:!!process.env.AGENT_HOST_REMOTE_KEY})+'\\n');
if(args[0]==='--version')console.log('${version}');
if(['start','foreground'].includes(args[0])){fs.mkdirSync(state,{recursive:true});fs.writeFileSync(state+'/connection.json','saved');}
if(args[0]==='status')console.log('Agent Host daemon is running; uplink: registered; supervisor: fixture.');
`);
  const archive = join(root, 'package.tgz');
  await exec('tar.exe', ['-czf', 'package.tgz', 'package'], { cwd: root, timeout: 10000 });
  await writeFile(join(root, 'release.json'), JSON.stringify({ version, revision, sha256: options.badChecksum ? '0'.repeat(64) : createHash('sha256').update(await readFile(archive)).digest('hex'), nodeMajor: options.nodeMajor ?? 22, asset: `orchardworks-agent-remote-controller-${version}.tgz`, platforms: options.platforms ?? ['win32-x64', 'win32-arm64'] }));
  await writeFile(join(bin, 'codex.cmd'), '@echo off\r\nexit /b 0\r\n');
  const key = join(root, 'key'); await writeFile(key, invitation);
  const env = { ...process.env, PATH: bin + ';' + process.env.PATH, AGENT_CONTROLLER_INSTALL_DIR: prefix, AGENT_CONTROLLER_BIN_DIR: commands, AGENT_HOST_STATE_DIR: state, FIXTURE_EVENTS: join(root, 'events'), npm_config_offline: 'true' };
  delete env.AGENT_HOST_REMOTE_KEY; delete env.AGENT_HOST_SERVER;
  const prelude = `
function curl.exe {
  $values = @($args); $global:LASTEXITCODE = 0
  if ($values -contains '%{url_effective}') { Write-Output 'https://github.com/xuangong/agent-remote-control/releases/tag/controller-v${version}'; return }
  $destination = $values[[Array]::IndexOf($values, '-o') + 1]
  $url = @($values | Where-Object { $_ -like 'https://*' })[0]
  $source = if ($url.EndsWith('.json')) { ${quote(join(root, 'release.json'))} } else { ${quote(archive)} }
  Copy-Item -LiteralPath $source -Destination $destination
}
`;
  async function run(parameters = '', extra = '', pipeline = false) {
    const command = `$ErrorActionPreference='Stop'\n${prelude}\n${extra}\ntry {\n` + (pipeline
      ? `Get-Content -Raw -LiteralPath ${quote(script)} | Invoke-Expression`
      : `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(script)}))) -Name fixture-host -Server https://relay.example -KeyFile ${quote(key)} ${parameters}`)
      + '\n} catch { Write-Output $_.Exception.Message; exit 1 }';
    try { const result = await exec(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env, timeout: 35000, maxBuffer: 1024 * 1024, windowsHide: true }); return { code: 0, output: result.stdout + result.stderr }; }
    catch (e) { return { code: e.code, output: (e.stdout ?? '') + (e.stderr ?? '') }; }
  }
  const events = async () => (await readFile(env.FIXTURE_EVENTS, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  async function existing(check) {
    await mkdir(commands, { recursive: true });
    const client = join(root, 'existing.cjs');
    await writeFile(client, `const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'existing',args,state:process.env.AGENT_HOST_STATE_DIR})+'\\n');if(args.includes('--check'))console.log(${JSON.stringify(JSON.stringify(check))});`);
    await writeFile(join(commands, 'existing.cjs'), await readFile(client));
    await writeFile(join(commands, 'agent-remote-controller.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0existing.cjs" %*\r\n`);
  }
  return { root, env, prefix, commands, state, run, events, existing };
}
windowsTest('fresh Windows install validates release and starts without exposing the key', async t => {
  const f = await fixture(t); const result = await f.run('-NonInteractive'); assert.equal(result.code, 0, result.output);
  const start = (await f.events()).find(e => e.args[0] === 'start'); assert.ok(start); assert.equal(start.state, f.state); assert.equal(start.key, true);
  assert.match(result.output, /Host fixture-host is ready/); assert.ok(!result.output.includes(invitation));
  for (const name of ['agent-remote-controller.cmd', 'agent-remote-controller.ps1', 'agent-remote-controller.cjs']) assert.ok(!(await readFile(join(f.commands, name), 'utf8')).includes(invitation));
});
for (const option of ['badChecksum', 'badIdentity']) windowsTest(`rejects ${option} before npm or startup`, async t => {
  const f = await fixture(t, { [option]: true }); const result = await f.run('-NoStart -NonInteractive'); assert.notEqual(result.code, 0); assert.match(result.output, option === 'badChecksum' ? /checksum mismatch/ : /identity does not match/); assert.deepEqual(await f.events(), []); await assert.rejects(access(f.commands));
});
windowsTest('rejects unsupported platform and Node requirements', async t => {
  for (const settings of [{ platforms: ['linux-x64'] }, { nodeMajor: 99 }]) {
    const f = await fixture(t, settings); assert.notEqual((await f.run('-NoStart')).code, 0); assert.deepEqual(await f.events(), []);
  }
});
windowsTest('refuses to overwrite an existing Host identity', async t => {
  const f = await fixture(t); await mkdir(f.state); await writeFile(join(f.state, 'connection.json'), 'retained');
  assert.notEqual((await f.run('-NoStart')).code, 0); assert.equal(await readFile(join(f.state, 'connection.json'), 'utf8'), 'retained');
});
windowsTest('install-only needs no pairing or service and generated command supports state override', async t => {
  const f = await fixture(t); const result = await f.run('-NoStart -NonInteractive'); assert.equal(result.code, 0, result.output);
  assert.ok(!(await f.events()).some(e => e.args[0] === 'start'));
  const override = join(f.root, 'override');
  const command = `& ${quote(join(f.commands, 'agent-remote-controller.cmd'))} status; exit $LASTEXITCODE`;
  await exec(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env: { ...f.env, AGENT_HOST_STATE_DIR: override }, timeout: 10000 });
  assert.equal((await f.events()).at(-1).state, override);
});
for (const mode of ['cancel', 'update', 'clean']) windowsTest(`existing install ${mode} preserves state and delegates to updater`, async t => {
  const f = await fixture(t); await f.existing({ current: '1.0.0', version, available: true, canClean: true });
  await mkdir(f.state); await writeFile(join(f.state, 'connection.json'), 'retained');
  const result = await f.run(mode === 'cancel' ? '-NonInteractive' : mode === 'clean' ? '-Yes -Clean' : '-Yes'); assert.equal(result.code, 0, result.output);
  const events = await f.events(); assert.equal(events.length, mode === 'cancel' ? 1 : 2);
  if (mode !== 'cancel') assert.deepEqual(events[1].args, ['update', '--version', version, '--yes', ...(mode === 'clean' ? ['--clean'] : [])]);
  assert.equal(await readFile(join(f.state, 'connection.json'), 'utf8'), 'retained');
});
windowsTest('pipeline entry defaults to cancel for an existing installation', async t => {
  const f = await fixture(t); await f.existing({ current: '1.0.0', version, available: true, canClean: true });
  const result = await f.run('', '', true); assert.equal(result.code, 0, result.output); assert.match(result.output, /Installation not changed/); assert.equal((await f.events()).length, 1);
});
windowsTest('existing wrapper state is not overridden unless explicitly selected', async t => {
  const f = await fixture(t); await f.existing({ current: version, available: false });
  delete f.env.AGENT_HOST_STATE_DIR;
  const result = await f.run('-NonInteractive'); assert.equal(result.code, 0, result.output);
  assert.equal((await f.events())[0].state, undefined);
});
windowsTest('same-version clean install is supported but ordinary consent does not force reinstall', async t => {
  const f = await fixture(t); await f.existing({ current: version, version, available: false, canClean: true });
  assert.equal((await f.run('-Yes')).code, 0); assert.equal((await f.events()).length, 1);
  assert.equal((await f.run('-Yes -Clean')).code, 0);
  assert.deepEqual((await f.events()).at(-1).args, ['update', '--version', version, '--yes', '--clean']);
});
windowsTest('unsupported clean install fails without invoking a mutation', async t => {
  const f = await fixture(t); await f.existing({ current: version, version, available: false, canClean: false });
  const result = await f.run('-Yes -Clean'); assert.notEqual(result.code, 0); assert.match(result.output, /Clean install is unavailable/);
  assert.equal((await f.events()).length, 1);
});
