import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeVariables = ['AGENT_CLAUDE_TEST_EXECUTABLE', 'BORGEE_CODEX_TEST_EXECUTABLE', 'AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE',
  'ARC_PROMPT_EDIT_TEST_EXECUTABLE', 'ARC_SESSION_FORK_TEST_EXECUTABLE', 'ARC_CODEX_SUCCESSION_TEST_EXECUTABLE', 'AGENT_OPENCODE_TEST_EXECUTABLE',
  'BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST'];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-native-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts/lib'), { recursive: true });
  for (const file of ['scripts/run-tests.mjs', 'scripts/lib/package-manager.mjs', 'scripts/lib/native-test-versions.mjs']) {
    await cp(join(root, file), join(directory, file));
  }
  const bin = join(directory, 'bin'); await mkdir(bin);
  for (const provider of ['claude', 'codex', 'opencode']) await mkdir(join(directory, 'packages', `agent-provider-${provider}`), { recursive: true });
  const lab = join(directory, 'packages/agent-remote-lab'); await mkdir(lab, { recursive: true });
  await writeFile(join(lab, 'compatibility.json'), JSON.stringify({ providers: [{ providerId: 'codex', native: { name: 'codex-cli', version: '0.162.0' } }] }));
  async function executable(name, body) {
    const path = join(directory, name); await mkdir(dirname(path), { recursive: true });
    const check = name === 'bin/pnpm' ? '' : "if (process.argv.length !== 3 || process.argv[2] !== '--version') throw new Error('Expected only --version');\n";
    await writeFile(path, `#!${process.execPath}\n${check}${body}\n`); await chmod(path, 0o755); return path;
  }
  await executable('bin/pnpm', "console.log('TEST_RUNNER_STARTED ' + JSON.stringify(process.argv.slice(2)));");
  await executable('bin/claude', "console.log('2.1.247 (Claude Code)');");
  await executable('bin/codex', "console.log('codex-cli 0.162.0');");
  await executable('bin/copilot', "throw new Error('Do not use PATH Copilot');");
  const provider = join(directory, 'packages/agent-provider-copilot');
  await mkdir(join(provider, 'node_modules/@github/copilot'), { recursive: true });
  await writeFile(join(provider, 'package.json'), JSON.stringify({ dependencies: { '@github/copilot': '1.0.83' } }));
  await writeFile(join(provider, 'node_modules/@github/copilot/package.json'), JSON.stringify({ version: '1.0.83', bin: { copilot: 'cli.mjs' } }));
  const copilot = await executable('packages/agent-provider-copilot/node_modules/@github/copilot/cli.mjs', "console.log('GitHub Copilot CLI 1.0.83');");
  const env = { ...process.env, PATH: bin, npm_execpath: undefined };
  for (const key of nativeVariables) delete env[key];
  env.BORGEE_CODEX_TEST_EXECUTABLE = join(bin, 'codex');
  return { directory, env, executable, copilot };
}

async function run(f, mode, extra = {}) {
  const child = spawn(process.execPath, ['scripts/run-tests.mjs', mode], { cwd: f.directory, env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 8000);
  try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, output })); }); }
  finally { clearTimeout(timer); }
}

const options = { timeout: 10000, skip: process.platform === 'win32' };
test('an old explicit Claude executable blocks the unit runner before tests start', options, async t => {
  const f = await fixture(t); const selected = await f.executable('selected-claude', "console.log('2.1.128 (Claude Code)');");
  const result = await run(f, 'unit', { AGENT_CLAUDE_TEST_EXECUTABLE: selected });
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
  assert.ok(result.output.includes(selected)); assert.match(result.output, /2\.1\.128/); assert.match(result.output, /2\.1\.247/);
  assert.match(result.output, /AGENT_CLAUDE_TEST_EXECUTABLE/);
});

test('matching unit binaries are reported and Copilot uses its pinned package entry', options, async t => {
  const f = await fixture(t); const result = await run(f, 'unit');
  assert.equal(result.code, 0, result.output); assert.match(result.output, /TEST_RUNNER_STARTED/);
  for (const value of [join(f.directory, 'bin/claude'), join(f.directory, 'bin/codex'), f.copilot, '2.1.247', '0.162.0', '1.0.83']) assert.ok(result.output.includes(value), result.output);
});

test('newer Claude and exact explicit Codex binaries can run unit tests', options, async t => {
  const f = await fixture(t);
  const codex = await f.executable('selected-codex.cjs', "console.log('codex-cli 0.162.0');");
  const claude = await f.executable('new-claude', "console.log('2.1.248 (Claude Code)');");
  await f.executable('bin/codex', "console.log('codex-cli 0.100.0');");
  await f.executable('bin/claude', "console.log('2.1.128 (Claude Code)');");
  const result = await run(f, 'unit', { BORGEE_CODEX_TEST_EXECUTABLE: codex, AGENT_CLAUDE_TEST_EXECUTABLE: claude });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /TEST_RUNNER_STARTED/);
  for (const value of [codex, claude, '0.162.0', '2.1.248']) assert.ok(result.output.includes(value), result.output);
});

for (const selection of [undefined, 'codex', './bin/codex']) test(`unit tests reject ${selection ?? 'missing'} explicit Codex selection before pnpm`, options, async t => {
  const f = await fixture(t); const result = await run(f, 'unit', { BORGEE_CODEX_TEST_EXECUTABLE: selection });
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
  assert.match(result.output, /BORGEE_CODEX_TEST_EXECUTABLE/); assert.match(result.output, /absolute|explicit/i);
});

for (const version of ['0.161.0', '0.162.1']) test(`unit tests reject Codex ${version} outside the exact manifest target`, options, async t => {
  const f = await fixture(t); const selected = await f.executable('selected-codex', `console.log('codex-cli ${version}');`);
  const result = await run(f, 'unit', { BORGEE_CODEX_TEST_EXECUTABLE: selected });
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
  assert.ok(result.output.includes(`actual=${version}`), result.output); assert.match(result.output, /required baseline=0\.162\.0/);
});

test('unit preflight reads an overridden compatibility manifest relative to the Lab package', options, async t => {
  const f = await fixture(t), manifest = 'alternate-compatibility.json';
  await writeFile(join(f.directory, 'packages/agent-remote-lab', manifest), JSON.stringify({ providers: [{ providerId: 'codex', native: { name: 'fixture-codex', version: '0.163.0' } }] }));
  const newer = await f.executable('newer-codex', "console.log('fixture-codex 0.163.0');");
  const rejected = await run(f, 'unit', { BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST: manifest });
  assert.notEqual(rejected.code, 0); assert.match(rejected.output, /required baseline=0\.163\.0/); assert.doesNotMatch(rejected.output, /TEST_RUNNER_STARTED/);
  const accepted = await run(f, 'unit', { BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST: manifest, BORGEE_CODEX_TEST_EXECUTABLE: newer });
  assert.equal(accepted.code, 0, accepted.output); assert.match(accepted.output, /TEST_RUNNER_STARTED/);
});

test('unit preflight requires the complete exact Codex version output', options, async t => {
  const f = await fixture(t); const selected = await f.executable('selected-codex', "console.log('codex-cli 0.162.0\\nunexpected extra output');");
  const result = await run(f, 'unit', { BORGEE_CODEX_TEST_EXECUTABLE: selected });
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/); assert.match(result.output, /codex-cli 0\.162\.0/);
});

test('unit preflight matches normalized stdout while keeping stderr separate like the Lab fixture', options, async t => {
  const f = await fixture(t); const selected = await f.executable('selected-codex', "process.stderr.write('fixture warning\\n'); process.stdout.write('codex-cli 0.162.0\\r\\n');");
  const result = await run(f, 'unit', { BORGEE_CODEX_TEST_EXECUTABLE: selected });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /TEST_RUNNER_STARTED/);
});

test('newer Codex remains allowed for the shared native suite', options, async t => {
  const f = await fixture(t); const selected = await f.executable('newer-codex', "console.log('codex-cli 0.163.0');");
  const result = await run(f, 'codex-shared', { AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE: selected });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /TEST_RUNNER_STARTED/); assert.match(result.output, /required baseline=>=0\.162\.0/);
});

test('fixture-only suites do not probe unrelated native executables', options, async t => {
  const f = await fixture(t); await f.executable('bin/claude', "throw new Error('unexpected native probe');");
  const result = await run(f, 'opencode', { AGENT_OPENCODE_TEST_EXECUTABLE: '/missing/opencode' });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /TEST_RUNNER_STARTED/); assert.doesNotMatch(result.output, /unexpected native probe/);
});

test('Copilot version probing uses the fixture profile and excludes inherited credentials', options, async t => {
  const f = await fixture(t);
  await writeFile(f.copilot, "if (!process.env.COPILOT_HOME || process.env.COPILOT_HOME === 'operator-profile' || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN) throw new Error('Probe did not use the fixture environment'); console.log('GitHub Copilot CLI 1.0.83');\n");
  const result = await run(f, 'copilot', { COPILOT_HOME: 'operator-profile', GITHUB_TOKEN: 'fixture-token', GH_TOKEN: 'fixture-token', COPILOT_GITHUB_TOKEN: 'fixture-token' });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /TEST_RUNNER_STARTED/);
});

test('a newer reported Copilot runtime remains distinct from its package version', options, async t => {
  const f = await fixture(t); await writeFile(f.copilot, "console.log(\"GitHub Copilot CLI 1.0.90-1.\\nRun 'copilot update' to check for updates.\");\n");
  const result = await run(f, 'copilot');
  assert.equal(result.code, 0, result.output); assert.match(result.output, /package=1\.0\.83/);
  assert.match(result.output, /actual=1\.0\.90-1/); assert.match(result.output, />=1\.0\.83/); assert.match(result.output, /TEST_RUNNER_STARTED/);
});

for (const version of ['1.0.70', '1.0.83-1']) test(`a current Copilot package cannot hide an older runtime ${version}`, options, async t => {
  const f = await fixture(t); await writeFile(f.copilot, `console.log('GitHub Copilot CLI ${version}.');\n`);
  const result = await run(f, 'copilot');
  assert.notEqual(result.code, 0); assert.ok(result.output.includes(`actual=${version}`), result.output); assert.match(result.output, /package=1\.0\.83/);
  assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
});

test('package-local PATH executables take precedence over the inherited PATH', options, async t => {
  const f = await fixture(t);
  const selected = await f.executable('packages/agent-provider-claude/node_modules/.bin/claude', "console.log('2.1.128 (Claude Code)');");
  const result = await run(f, 'unit');
  assert.notEqual(result.code, 0); assert.ok(result.output.includes(selected), result.output);
  assert.match(result.output, /2\.1\.128/); assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
});

test('an enabled optional Codex binary is checked without overriding its selection', options, async t => {
  const f = await fixture(t); const selected = await f.executable('optional-codex', "console.log('codex-cli 0.100.0');");
  const result = await run(f, 'unit', { ARC_PROMPT_EDIT_TEST_EXECUTABLE: selected });
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
  assert.ok(result.output.includes(selected)); assert.match(result.output, /ARC_PROMPT_EDIT_TEST_EXECUTABLE/);
});

test('a version probe has a hard deadline before the test runner starts', options, async t => {
  const f = await fixture(t); const selected = await f.executable('hung-claude', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const started = Date.now(); const result = await run(f, 'claude', { AGENT_CLAUDE_TEST_EXECUTABLE: selected });
  assert.notEqual(result.code, 0); assert.equal(result.signal, null, result.output); assert.ok(Date.now() - started < 7500);
  assert.match(result.output, /timed out|deadline/i); assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
});

test('a native OpenCode suite rejects a different major before testing', options, async t => {
  const f = await fixture(t); const selected = await f.executable('selected-opencode', "console.log('opencode v3.0.0');");
  const result = await run(f, 'opencode-native', { AGENT_OPENCODE_TEST_EXECUTABLE: selected });
  assert.notEqual(result.code, 0); assert.match(result.output, /3\.0\.0/); assert.match(result.output, /2\.0\.25/);
  assert.doesNotMatch(result.output, /TEST_RUNNER_STARTED/);
});

test('newer OpenCode passes ordinary native tests but preserves the managed-server exact baseline', options, async t => {
  const f = await fixture(t); const selected = await f.executable('selected-opencode', "console.log('opencode v2.0.26');");
  const ordinary = await run(f, 'opencode-native', { AGENT_OPENCODE_TEST_EXECUTABLE: selected });
  assert.equal(ordinary.code, 0, ordinary.output); assert.match(ordinary.output, /TEST_RUNNER_STARTED/);
  const evidence = await run(f, 'host-package', { AGENT_OPENCODE_TEST_EXECUTABLE: selected });
  assert.notEqual(evidence.code, 0); assert.match(evidence.output, /actual=2\.0\.26/); assert.doesNotMatch(evidence.output, /TEST_RUNNER_STARTED/);
  const fixtures = await run(f, 'host-package');
  assert.equal(fixtures.code, 0, fixtures.output); assert.doesNotMatch(fixtures.output, /Native test preflight/);
});
