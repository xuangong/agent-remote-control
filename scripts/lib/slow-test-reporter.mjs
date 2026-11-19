import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTiers, realStackTiers, tierOf } from './test-tiers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const warnMs = 300;
const failMs = 1000;
const allowlistPath = join(root, 'scripts/slow-test-allowlist.json');
/** The outer deadline of one re-measurement run of a single file. */
const remeasureDeadlineMs = 120_000;

/**
 * Tests known to exceed the limit, as `{ test, reason }` where `test` is `<path from the repository root> > <full test name>` and `reason`
 * says why the test takes over a second and what would make it faster. An entry without a written reason is refused, so the run fails
 * rather than silently accepting an unexplained slow test.
 */
export function readAllowlist(path = allowlistPath) {
  if (!existsSync(path)) return new Set();
  const { tests } = JSON.parse(readFileSync(path, 'utf8'));
  for (const entry of tests) {
    if (typeof entry !== 'object' || typeof entry.test !== 'string' || typeof entry.reason !== 'string' || entry.reason.length < 40)
      throw new Error(`${path}: every entry is { test, reason } with the reason written out; refused: ${JSON.stringify(entry)}`);
  }
  return new Set(tests.map(entry => entry.test));
}

/**
 * Runs one test file again, alone and on one worker, and returns the duration of each of its tests by full name. The child run's
 * own reporter sees `ARC_SLOW_TEST_REMEASURE` and only writes the durations, so a re-measurement never re-measures again.
 */
export async function remeasureAlone({ cwd, file, configFile }) {
  const directory = mkdtempSync(join(tmpdir(), 'arc-remeasure-'));
  const output = join(directory, 'durations.json');
  try {
    const cli = join(dirname(createRequire(join(cwd, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
    const args = [cli, 'run', file, '--maxWorkers=1', '--testTimeout=10000', ...(configFile ? ['--config', configFile] : [])];
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, args, { cwd, stdio: 'ignore', env: { ...process.env, ARC_SLOW_TEST_REMEASURE: output, ARC_SLOW_TEST_DIR: '' } });
      const deadline = setTimeout(() => child.kill('SIGKILL'), remeasureDeadlineMs);
      child.once('error', error => { clearTimeout(deadline); rejectRun(error); });
      child.once('exit', () => { clearTimeout(deadline); resolveRun(); });
    });
    return existsSync(output) ? new Map(Object.entries(JSON.parse(readFileSync(output, 'utf8')))) : new Map();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Vitest reporter for the unit, contract and integration tiers, which use mock data: a test over 300 ms is listed for a look, and a
 * test over one second fails the run unless the allowlist names it.
 *
 * Timing under load: a loaded machine moves tests near the limit across it, so a test over one second is measured once more before it
 * fails the run: its file runs again alone on one worker, and the test fails only if it is over the limit both times. The retry is for
 * timing only; a test that failed its assertions is not retried here.
 *
 * Environment: ARC_SLOW_TEST_ENFORCE=0 only lists the slow tests and never fails the run. ARC_SLOW_TEST_DIR writes every test over
 * 100 ms of the run to a JSON file per package.
 */
export class SlowTestReporter {
  constructor({ enforce = process.env.ARC_SLOW_TEST_ENFORCE !== '0', remeasure = remeasureAlone, allowlist = allowlistPath } = {}) {
    this.enforce = enforce;
    this.allowlistPath = allowlist;
    this.remeasure = remeasure;
  }

  onInit(vitest) {
    this.cwd = vitest.config?.root ?? process.cwd();
    this.configFile = vitest.vite?.config?.configFile || undefined;
  }

  async onTestRunEnd(testModules) {
    const measured = [];
    const everything = [];
    for (const module of testModules) {
      const file = relative(root, module.moduleId);
      const tier = tierOf(file, module.project?.name);
      for (const test of module.children.allTests()) {
        const duration = test.diagnostic()?.duration;
        if (test.result().state === 'skipped' || duration === undefined) continue;
        const entry = { key: `${file} > ${test.fullName}`, file, moduleId: module.moduleId, name: test.fullName, tier, durationMs: Math.round(duration) };
        everything.push(entry);
        // Tests that use a real process, browser or CLI are not unit or integration tests with mock data.
        if (!realStackTiers.has(tier)) measured.push(entry);
      }
    }
    if (process.env.ARC_SLOW_TEST_REMEASURE) {
      writeFileSync(process.env.ARC_SLOW_TEST_REMEASURE, JSON.stringify(Object.fromEntries(everything.map(entry => [entry.name, entry.durationMs]))));
      return;
    }
    const allowlist = readAllowlist(this.allowlistPath);
    const total = measured.length;
    const over = limit => measured.filter(entry => entry.durationMs > limit).sort((a, b) => b.durationMs - a.durationMs);
    const warn = over(warnMs), slow = over(failMs);
    if (process.env.ARC_SLOW_TEST_DIR) {
      mkdirSync(process.env.ARC_SLOW_TEST_DIR, { recursive: true });
      // A package with a second Vitest config (the seams' transport config) writes a second report beside the first.
      const config = this.configFile ? basename(this.configFile).replace(/^vitest\.?|config\.[mc]?[jt]s$/g, '').replace(/\.$/, '') : '';
      const name = basename(process.cwd()) + (config ? `.${config}` : '');
      writeFileSync(join(process.env.ARC_SLOW_TEST_DIR, `${name}.json`), `${JSON.stringify({ package: name, tests: total,
        over300ms: warn.length, over1s: slow.length, tiers: countTiers(everything), slowest: over(100).map(({ moduleId, ...entry }) => entry) }, null, 1)}\n`);
    }
    const stale = measured.filter(entry => allowlist.has(entry.key) && entry.durationMs <= warnMs);
    if (stale.length > 0) console.warn(`Allowlisted but now under ${warnMs} ms; remove from scripts/slow-test-allowlist.json:\n${stale.map(entry => `  ${entry.durationMs} ms  ${entry.key}`).join('\n')}`);
    if (warn.length === 0) return;
    const lines = [`Slow tests (${warn.length} over ${warnMs} ms, ${slow.length} over ${failMs} ms, of ${total}); mock-data tests should take well under a second:`];
    for (const entry of warn.slice(0, 10)) lines.push(`  ${entry.durationMs} ms  ${entry.key}${allowlist.has(entry.key) ? '  (allowlisted)' : ''}`);
    if (warn.length > 10) lines.push(`  ... and ${warn.length - 10} more`);
    console.warn(lines.join('\n'));
    const unlisted = slow.filter(entry => !allowlist.has(entry.key));
    if (unlisted.length === 0 || !this.enforce) return;
    const confirmed = await this.confirm(unlisted);
    if (confirmed.length === 0) {
      console.warn(`${unlisted.length} test(s) over ${failMs} ms took less when their file ran again alone; counted as load, not as slow.`);
      return;
    }
    console.error([`${confirmed.length} test(s) took over ${failMs} ms twice, the second time with their file alone, and are not in scripts/slow-test-allowlist.json:`,
      ...confirmed.map(entry => `  ${entry.durationMs} ms, then ${entry.againMs} ms alone  ${entry.key}`),
      'Make them faster with fake timers, injected clocks or mock ports, or extract the module they exercise. Set ARC_SLOW_TEST_ENFORCE=0 to only list them.'].join('\n'));
    process.exitCode = 1;
  }

  /** The tests of `unlisted` that are over the limit again when their file runs alone; a test the second run did not measure counts as slow. */
  async confirm(unlisted) {
    const confirmed = [];
    for (const moduleId of new Set(unlisted.map(entry => entry.moduleId))) {
      let again = new Map();
      try {
        again = await this.remeasure({ cwd: this.cwd ?? process.cwd(), file: moduleId, configFile: this.configFile });
      } catch (error) {
        console.warn(`Could not measure ${moduleId} again: ${error.message}`);
      }
      for (const entry of unlisted.filter(candidate => candidate.moduleId === moduleId)) {
        const againMs = again.get(entry.name);
        if (againMs === undefined || againMs > failMs) confirmed.push({ ...entry, againMs: againMs ?? 'unmeasured' });
      }
    }
    return confirmed;
  }
}
