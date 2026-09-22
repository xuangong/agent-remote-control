import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { packageManager } from './lib/package-manager.mjs';

const root = resolve(import.meta.dirname, '..');
const names = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const args = process.argv.slice(2);
const requested = args.find(arg => !arg.startsWith('--')) ?? names[process.platform];
if (!requested || requested !== names[process.platform] || args.some(arg => arg !== requested && !['--native', '--package'].includes(arg))) {
  throw new Error(`Usage: node scripts/test-platform.mjs [windows|macos|linux] [--native] [--package]. Run the matching profile on its native OS (${process.platform}).`);
}
const native = args.includes('--native');
const packaged = args.includes('--package');
const nativeVariable = process.platform === 'win32' ? 'AGENT_REMOTE_WINDOWS_CODEX_TEST_EXECUTABLE' : 'AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE';
if (native && !process.env[nativeVariable]) throw new Error(`--native requires ${nativeVariable}; native tests must not silently skip.`);
const reportDir = join(root, '.tmp/platform-tests', `${requested}-${Date.now()}`);
await mkdir(reportDir, { recursive: true });
const report = {
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  platform: process.platform, osRelease: release(), arch: process.arch, node: process.version,
  profile: requested, nativeRequested: native, packageRequested: packaged,
  startedAt: new Date().toISOString(), suites: [], outcome: 'running',
};
const env = { ...process.env };
// Package coverage always exercises the artifact built by this profile.
if (packaged) delete env.AGENT_HOST_PACKAGE;
// A regular profile is reproducible even when a shell retains native-test settings.
if (!native) { delete env.AGENT_REMOTE_WINDOWS_CODEX_TEST_EXECUTABLE; delete env.AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE; }
let active;
function stop() {
  if (!active?.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(active.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => active?.kill());
  else { try { process.kill(-active.pid, 'SIGKILL'); } catch {} }
}
process.once('SIGINT', () => { stop(); process.exitCode = 130; });
process.once('SIGTERM', () => { stop(); process.exitCode = 143; });
const outer = setTimeout(() => { console.error('Platform profile exceeded its 15 minute deadline.'); stop(); process.exitCode = 1; }, 900000);

async function run(name, command, commandArgs, cwd = root, deadlineMs = 180000) {
  console.log(`Platform suite: ${name}`);
  const entry = { name, outcome: 'running', elapsedMs: 0 }; report.suites.push(entry);
  const started = Date.now(); let timedOut = false;
  active = spawn(command, commandArgs, { cwd, env, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
  const deadline = setTimeout(() => { timedOut = true; stop(); }, deadlineMs);
  try {
    const code = await new Promise((done, reject) => { active.once('exit', done); active.once('error', reject); });
    entry.outcome = timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed';
    if (code !== 0 || timedOut || process.exitCode) throw new Error(`${name} failed (${entry.outcome}, exit ${code}).`);
  } catch (error) { if (entry.outcome === 'running') entry.outcome = 'failed'; throw error; }
  finally { clearTimeout(deadline); entry.elapsedMs = Date.now() - started; active = undefined; }
}

async function tests(name, pkg, files) {
  const output = join(reportDir, `${name}.json`);
  await run(name, process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files,
    '--testTimeout=30000', '--hookTimeout=15000', '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${output}`], join(root, 'packages', pkg), 300000);
  const result = JSON.parse(await readFile(output, 'utf8'));
  const entry = report.suites.at(-1);
  entry.tests = { passed: result.numPassedTests, failed: result.numFailedTests, pending: result.numPendingTests, todo: result.numTodoTests };
  if (!result.numPassedTests) { entry.outcome = 'failed'; throw new Error(`${name} did not execute any passing tests.`); }
  if (native && (name === 'native-codex' || (requested === 'windows' && name === 'services-processes'))) {
    const assertions = result.testResults.flatMap(file => file.assertionResults);
    const required = name === 'native-codex' ? assertions : assertions.filter(test => test.title === 'shares a real native Codex thread without model requests or user credentials');
    if (!required.length || required.some(test => test.status !== 'passed')) {
      entry.outcome = 'failed'; throw new Error('Requested native Codex coverage did not pass in full.');
    }
  }
}

try {
  if (native) report.nativeVersion = execFileSync(env[nativeVariable], ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  await run('build', ...packageManager('pnpm', ['--filter', '@orchardworks/agent-remote-controller...', 'run', 'build']));
  await tests('filesystem', 'agent-platform', ['src/filesystem']);
  await tests('host-storage', 'agent-host', ['src/connection-config.test.ts', 'src/controller-package.test.ts', 'src/environment.test.ts', 'src/platform/services/services.test.ts']);
  await tests('images', 'agent-remote-relay', ['src/resources/input-image-store.test.ts', 'src/transport/image-input.test.ts']);
  await tests('transport', 'codex-daemon-client', ['src/app-server-transport.test.ts']);
  const services = requested === 'windows'
    ? ['src/windows.test.ts', 'src/windows-autostart.test.ts', 'src/windows-shared.test.ts']
    : requested === 'macos' ? ['src/launchd.test.ts'] : ['src/systemd.test.ts', 'src/cli-linux.test.ts'];
  await tests('services-processes', 'agent-host', [...services, 'src/vscode-tunnel.test.ts', 'src/vscode-tunnel-supervisor.test.ts', 'src/controller-shutdown.test.ts', 'src/controller-launcher.test.ts']);
  if (native && requested !== 'windows') await tests('native-codex', 'agent-provider-codex', ['src/shared-runtime.local.test.ts']);
  if (packaged) {
    await run('build-package', process.execPath, ['scripts/build-agent-host.mjs'], root, 300000);
    await run('standalone-package', process.execPath, ['--test', '--test-timeout=180000', 'scripts/agent-host-cli.test.mjs', 'scripts/agent-host-package.test.mjs'], root, 300000);
  }
  report.outcome = 'passed';
} catch (error) { report.outcome = 'failed'; console.error(error); process.exitCode = 1; }
finally {
  clearTimeout(outer);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Platform report: ${join(reportDir, 'summary.json')}`);
}
