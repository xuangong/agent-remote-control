import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const warnMs = 300;
const failMs = 1000;
const allowlistPath = join(root, 'scripts/slow-test-allowlist.json');

// Tests that use a real process, browser or CLI are not unit or integration tests with mock data.
const exemptFile = /\.(local|browser|process)\.test\.tsx?$|\.browser\.ts$/;
const exemptProject = new Set(['process']);

/** Tests known to exceed the limit, keyed by `<path from the repository root> > <full test name>`; each waits for a fix or an extraction. */
function readAllowlist() {
  return existsSync(allowlistPath) ? new Set(JSON.parse(readFileSync(allowlistPath, 'utf8')).tests) : new Set();
}

/**
 * Vitest reporter for the unit and integration layers, which use mock data: a test over 300 ms is listed for a look, and a
 * test over one second fails the run unless the allowlist names it. Set ARC_SLOW_TEST_DIR to also write every test over
 * 100 ms of the run to a JSON file, and ARC_SLOW_TEST_ENFORCE=0 to list without failing.
 */
export class SlowTestReporter {
  onTestRunEnd(testModules) {
    const allowlist = readAllowlist();
    const measured = [];
    let total = 0;
    for (const module of testModules) {
      const file = relative(root, module.moduleId);
      if (exemptFile.test(file) || exemptProject.has(module.project?.name)) continue;
      for (const test of module.children.allTests()) {
        const duration = test.diagnostic()?.duration;
        if (test.result().state === 'skipped' || duration === undefined) continue;
        total += 1;
        measured.push({ key: `${file} > ${test.fullName}`, file, name: test.fullName, durationMs: Math.round(duration) });
      }
    }
    const over = limit => measured.filter(entry => entry.durationMs > limit).sort((a, b) => b.durationMs - a.durationMs);
    const warn = over(warnMs), slow = over(failMs);
    const unlisted = slow.filter(entry => !allowlist.has(entry.key));
    if (process.env.ARC_SLOW_TEST_DIR) {
      mkdirSync(process.env.ARC_SLOW_TEST_DIR, { recursive: true });
      const name = basename(process.cwd());
      writeFileSync(join(process.env.ARC_SLOW_TEST_DIR, `${name}.json`), `${JSON.stringify({ package: name, tests: total,
        over300ms: warn.length, over1s: slow.length, slowest: over(100) }, null, 1)}\n`);
    }
    if (warn.length === 0) return;
    const lines = [`Slow tests (${warn.length} over ${warnMs} ms, ${slow.length} over ${failMs} ms, of ${total}); mock-data tests should take well under a second:`];
    for (const entry of warn.slice(0, 10)) lines.push(`  ${entry.durationMs} ms  ${entry.key}${allowlist.has(entry.key) ? '  (allowlisted)' : ''}`);
    if (warn.length > 10) lines.push(`  ... and ${warn.length - 10} more`);
    console.warn(lines.join('\n'));
    if (unlisted.length > 0 && process.env.ARC_SLOW_TEST_ENFORCE !== '0') {
      console.error(`${unlisted.length} test(s) over ${failMs} ms are not in scripts/slow-test-allowlist.json. Make them faster with fake timers, injected clocks or mock ports, or extract the module they exercise.`);
      process.exitCode = 1;
    }
  }
}
