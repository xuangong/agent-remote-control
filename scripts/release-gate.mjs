// pnpm gate:release [--base <ref>] [--plan] [--full] [--from <tier>] [--only <tier>,...] [--serial] [--max-parallel N] [--reserve-gib N]:
// the release gate, scoped by what changed since the commit production runs (default base: the newer of the newest controller-v* and
// relay-deployed-* tags). It prints the plan and runs the tiers; tiers whose measured memory and CPU fit the machine's current state run
// at the same time (scripts/lib/gate-scheduler.mjs), `--serial` runs them one at a time. After a failure nothing new starts, the running
// tiers finish, and the log path is printed. The planning is scripts/lib/release-gate.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_LIMITS, runSchedule, withWorkers } from './lib/gate-scheduler.mjs';
import { processTreeMiB, readMachine } from './lib/machine-state.mjs';
import { describeGate, planGate, releasedBase, selectTiers } from './lib/release-gate.mjs';
import { packageFiles, readModules, workspacePackages } from './lib/test-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null; };
const { values } = parseArgs({ options: { base: { type: 'string' }, plan: { type: 'boolean' }, full: { type: 'boolean' }, from: { type: 'string' }, only: { type: 'string' }, serial: { type: 'boolean' }, 'max-parallel': { type: 'string' }, 'reserve-gib': { type: 'string' } } });

const limits = { ...DEFAULT_LIMITS };
if (values['max-parallel']) limits.maxParallel = Number(values['max-parallel']);
if (values['reserve-gib']) limits.reserveMiB = Number(values['reserve-gib']) * 1024;
if (values.serial) limits.maxParallel = 1;
if (!Number.isInteger(limits.maxParallel) || limits.maxParallel < 1 || !Number.isFinite(limits.reserveMiB)) { console.error('gate:release: --max-parallel needs a whole number of at least 1 and --reserve-gib a number.'); process.exit(1); }
const serial = limits.maxParallel === 1;

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
const live = new Set();
const stopAll = signal => { for (const child of live) try { process.kill(-child.pid, signal); } catch {} };
process.once('SIGINT', () => { stopAll('SIGINT'); process.exit(130); });
process.once('SIGTERM', () => { stopAll('SIGTERM'); process.exit(143); });
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = line => console.log(`[${stamp()}] ${line}`);
/** Runs one command with its output in the log (and on the terminal when tiers run one at a time); resolves its exit code (124 at the deadline). */
function run({ command, env }, log, deadlineMs, onSpawn) {
  return new Promise(done => {
    log.write(`$ ${command.join(' ')}\n`);
    const child = spawn(command[0], command.slice(1), { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child);
    onSpawn?.(child);
    const stop = signal => { try { process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => { log.write(`gate:release: deadline of ${deadlineMs / 1000} s exceeded\n`); stop('SIGKILL'); }, deadlineMs);
    for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', chunk => { if (serial) out.write(chunk); log.write(chunk); });
    child.once('error', () => { clearTimeout(timer); live.delete(child); done(127); });
    child.once('close', (code, signal) => { clearTimeout(timer); live.delete(child); done(code ?? (signal === 'SIGKILL' ? 124 : 1)); });
  });
}
/** The steps of a tier; tiers that support it take the granted workers. */
const stepsOf = (tier, workers) => tier.steps.map(step => ({ ...step, command: withWorkers(step.command, tier.id, workers) }));
/** Starts a tier: its steps run in order in the background. Returns `{ handle, done }`, `handle.pid` is the process now running. */
function launch(tier, { workers }) {
  const logPath = join(logDirectory, `${tier.id}.log`);
  const log = createWriteStream(logPath);
  if (serial) console.log(`\n== ${tier.id}: ${tier.why}`);
  const handle = { pid: undefined, logPath };
  const done = (async () => {
    let code = 0;
    // Smoke restarts the instance with journals on; afterwards it is stopped if it was stopped, else restarted as a normal run.
    const wasRunning = tier.id === 'smoke' && spawnSync('pnpm', ['local', 'status'], { cwd: root, stdio: 'ignore' }).status === 0;
    for (const step of stepsOf(tier, workers)) {
      code = await run(step, log, tier.deadlineMs, child => { handle.pid = child.pid; });
      if (code !== 0) break;
    }
    if (tier.id === 'smoke') await run({ command: ['pnpm', 'local', wasRunning ? 'up' : 'down'] }, log, tier.deadlineMs, child => { handle.pid = child.pid; });
    await new Promise(finish => log.end(finish));
    if (code !== 0 && !serial) {
      const tail = readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n');
      console.error(`\n== ${tier.id} failed; the end of its log:\n${tail}`);
    }
    return { code };
  })();
  return { handle, done };
}
/** The Playwright WebKit helpers are started by the system, so they are not in a test run's process tree. */
const webkitTiers = new Set(['components', 'preview-browser', 'e2e-webkit']);
const memoryOf = (pid, tier) => (pid ? processTreeMiB(pid, webkitTiers.has(tier.id) ? /ms-playwright\/webkit/ : undefined) : 0);

const machineNow = readMachine();
say(`Machine: ${(machineNow.availableMiB / 1024).toFixed(1)} GiB available, pressure ${machineNow.pressure}, load ${machineNow.load1.toFixed(1)} on ${machineNow.cores} cores. ${serial ? 'Serial run.' : `Up to ${limits.maxParallel} tiers at once, keeping ${(limits.reserveMiB / 1024).toFixed(1)} GiB free.`}`);
const started = Date.now();
const { results: finished, skipped: notStarted, observed } = await runSchedule({
  tiers, limits, readMachine, memoryOf, launch, log: say, now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
});
const logOf = id => join(logDirectory, `${id}.log`);
const results = finished.map(result => ({ ...result, seconds: Math.round((result.endedMs - result.startedMs) / 1000) }));
console.log('\nRelease gate summary');
for (const result of results) console.log(`  ${result.tier.padEnd(16)} exit ${result.code}  ${String(result.seconds).padStart(5)} s  peak ${(result.peakMiB / 1024).toFixed(1)} GiB${result.workers > 1 ? `  ${result.workers} workers` : ''}`);
for (const id of notStarted) console.log(`  ${id.padEnd(16)} not started`);
console.log(`  wall time ${Math.round((Date.now() - started) / 1000)} s; lowest available memory ${(observed.minAvailableMiB / 1024).toFixed(1)} GiB; worst pressure ${observed.worstPressure}`);
const failed = results.filter(result => result.code !== 0);
if (failed.length) { console.error(`\nFAILED at ${failed.map(result => result.tier).join(', ')}; logs: ${failed.map(result => logOf(result.tier)).join(', ')}`); process.exit(1); }
console.log(`\nPASSED; logs: ${logDirectory}`);
