// pnpm gate:release [--base <ref>] [--plan] [--full] [--from <tier>] [--only <tier>,...]: the release gate, scoped by what changed since
// the commit production runs (default base: the newer of the newest controller-v* and relay-deployed-* tags). It prints the plan, runs the tiers one at a time, and stops at the first failure
// with the log path. The planning is scripts/lib/release-gate.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { describeGate, planGate, releasedBase, selectTiers } from './lib/release-gate.mjs';
import { packageFiles, readModules, workspacePackages } from './lib/test-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null; };
const { values } = parseArgs({ options: { base: { type: 'string' }, plan: { type: 'boolean' }, full: { type: 'boolean' }, from: { type: 'string' }, only: { type: 'string' } } });

// Refuse an unknown tier name before anything is fetched or planned.
try { selectTiers({ tiers: [] }, values); } catch (error) { console.error(`gate:release: ${error.message}`); process.exit(1); }
if (!values.base && !values.full) {
  // Releases create tags on GitHub, so local tags lag; the default base needs the current list.
  const fetched = spawnSync('git', ['fetch', '--tags', 'origin'], { cwd: root, stdio: 'ignore', timeout: 60_000 });
  if (fetched.status !== 0) { console.error('gate:release: `git fetch --tags origin` failed or timed out; check the network, or pass --base <ref> to skip it.'); process.exit(1); }
}
const base = values.base ?? releasedBase(git);
if (!base) { console.error('gate:release: no controller-v* or relay-deployed-* tag to compare with; pass --base <ref> or use --full.'); process.exit(values.full ? 0 : 1); }
const baseCommit = git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
if (!baseCommit) { console.error(`gate:release: ${base} is not a commit.`); process.exit(1); }
const head = git('rev-parse', 'HEAD');
const changed = git('diff', '--name-only', baseCommit, head).split('\n').filter(Boolean);
const plan = planGate({
  changed, files: packageFiles(root), modules: readModules(root), packages: workspacePackages(root),
  flowFiles: readdirSync(join(root, 'packages/agent-e2e/flows')), force: values.full,
});
console.log(describeGate(plan, { base: `${base} (${baseCommit.slice(0, 8)})`, head: head.slice(0, 8) }));
const { run: tiers, skipped } = selectTiers(plan, values);
for (const { tier, why } of skipped) console.log(`  skipped: ${why}  ${tier}`);
if (values.plan) process.exit(0);
if (git('status', '--porcelain', '--untracked-files=no')) console.error('gate:release: uncommitted changes are built, but only committed ones choose the tiers.');

const logDirectory = join(root, '.artifacts/gate-release', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(logDirectory, { recursive: true });
let current;
const stop = signal => { try { process.kill(-current.pid, signal); } catch {} };
process.once('SIGINT', () => { stop('SIGINT'); process.exit(130); });
process.once('SIGTERM', () => { stop('SIGTERM'); process.exit(143); });
/** Runs one command with its output on the terminal and in the log; resolves its exit code (124 at the deadline). */
function run({ command, env }, log, deadlineMs) {
  return new Promise(done => {
    log.write(`$ ${command.join(' ')}\n`);
    current = spawn(command[0], command.slice(1), { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { log.write(`gate:release: deadline of ${deadlineMs / 1000} s exceeded\n`); stop('SIGKILL'); }, deadlineMs);
    for (const [stream, out] of [[current.stdout, process.stdout], [current.stderr, process.stderr]]) stream.on('data', chunk => { out.write(chunk); log.write(chunk); });
    current.once('error', () => { clearTimeout(timer); done(127); });
    current.once('close', (code, signal) => { clearTimeout(timer); done(code ?? (signal === 'SIGKILL' ? 124 : 1)); });
  });
}
const results = [];
let failed = null;
for (const tier of tiers) {
  const logPath = join(logDirectory, `${tier.id}.log`);
  const log = createWriteStream(logPath);
  console.log(`\n== ${tier.id}: ${tier.why}`);
  const started = Date.now();
  let code = 0;
  // Smoke restarts the instance with journals on; afterwards it is stopped if it was stopped, else restarted as a normal run.
  const wasRunning = tier.id === 'smoke' && spawnSync('pnpm', ['local', 'status'], { cwd: root, stdio: 'ignore' }).status === 0;
  for (const step of tier.steps) { code = await run(step, log, tier.deadlineMs); if (code !== 0) break; }
  if (tier.id === 'smoke') {
    // The instance goes back to what it was: stopped, or restarted without the journals variable.
    await run({ command: ['pnpm', 'local', wasRunning ? 'up' : 'down'] }, log, tier.deadlineMs);
  }
  await new Promise(done => log.end(done));
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ tier: tier.id, code, seconds, logPath });
  console.log(`== ${tier.id}: exit ${code} in ${seconds} s (${logPath})`);
  if (code !== 0) { failed = results.at(-1); break; }
}
console.log('\nRelease gate summary');
for (const result of results) console.log(`  ${result.tier.padEnd(16)} exit ${result.code}  ${result.seconds} s`);
if (failed) { console.error(`\nFAILED at ${failed.tier}; log: ${failed.logPath}`); process.exit(1); }
console.log(`\nPASSED; logs: ${logDirectory}`);
