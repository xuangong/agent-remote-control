import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readAllowlist, SlowTestReporter } from './slow-test-reporter.mjs';

const root = new URL('../..', import.meta.url).pathname;
const fakeTest = (name, duration) => ({ fullName: name, diagnostic: () => ({ duration }), result: () => ({ state: 'passed' }) });
const fakeModule = (file, tests) => ({ moduleId: join(root, file), project: { name: 'unit' }, children: { allTests: () => tests } });
const slowModule = fakeModule('packages/a/src/x.test.ts', [fakeTest('fast', 5), fakeTest('very slow', 1500)]);

/** Runs the reporter over `modules` with console output captured, and returns the exit code it set and what it printed. */
async function report(reporter, modules) {
  const { warn, error } = console;
  const printed = [];
  console.warn = text => printed.push(text);
  console.error = text => printed.push(text);
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await reporter.onTestRunEnd(modules);
    return { exitCode: process.exitCode, printed: printed.join('\n') };
  } finally {
    console.warn = warn; console.error = error;
    process.exitCode = previous;
  }
}

test('an unlisted test over one second fails the run by default when its file is slow again alone', async () => {
  const asked = [];
  const reporter = new SlowTestReporter({ remeasure: async request => { asked.push(request.file); return new Map([['very slow', 1200]]); } });
  const { exitCode, printed } = await report(reporter, [slowModule]);
  assert.equal(exitCode, 1);
  assert.deepEqual(asked, [join(root, 'packages/a/src/x.test.ts')]);
  assert.match(printed, /1500 ms, then 1200 ms alone {2}packages\/a\/src\/x\.test\.ts > very slow/);
});

test('a test that is fast when its file runs again alone counts as load and passes', async () => {
  const { exitCode, printed } = await report(new SlowTestReporter({ remeasure: async () => new Map([['very slow', 180]]) }), [slowModule]);
  assert.equal(exitCode, 0);
  assert.match(printed, /counted as load/);
});

test('a test the second run did not measure counts as slow', async () => {
  const { exitCode } = await report(new SlowTestReporter({ remeasure: async () => new Map() }), [slowModule]);
  assert.equal(exitCode, 1);
});

test('enforcement off lists the slow test and never measures again or fails', async () => {
  let asked = 0;
  const { exitCode, printed } = await report(new SlowTestReporter({ enforce: false, remeasure: async () => { asked += 1; return new Map(); } }), [slowModule]);
  assert.equal(exitCode, 0);
  assert.equal(asked, 0);
  assert.match(printed, /1500 ms {2}packages\/a\/src\/x\.test\.ts > very slow/);
});

test('enforcement is on unless ARC_SLOW_TEST_ENFORCE is 0', () => {
  const previous = process.env.ARC_SLOW_TEST_ENFORCE;
  try {
    delete process.env.ARC_SLOW_TEST_ENFORCE;
    assert.equal(new SlowTestReporter().enforce, true);
    process.env.ARC_SLOW_TEST_ENFORCE = '0';
    assert.equal(new SlowTestReporter().enforce, false);
  } finally {
    if (previous === undefined) delete process.env.ARC_SLOW_TEST_ENFORCE; else process.env.ARC_SLOW_TEST_ENFORCE = previous;
  }
});

test('tests in the real-stack tiers are never measured against the limit', async () => {
  const transport = fakeModule('packages/a/src/x.transport.test.ts', [fakeTest('real socket', 4000)]);
  const { exitCode } = await report(new SlowTestReporter({ remeasure: async () => new Map() }), [transport]);
  assert.equal(exitCode, 0);
});

test('a re-measurement run only writes the durations of its tests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-remeasure-test-'));
  const previous = process.env.ARC_SLOW_TEST_REMEASURE;
  try {
    process.env.ARC_SLOW_TEST_REMEASURE = join(directory, 'durations.json');
    const { exitCode } = await report(new SlowTestReporter({ remeasure: async () => { throw new Error('never re-measures again'); } }), [slowModule]);
    assert.equal(exitCode, 0);
    const { readFileSync } = await import('node:fs');
    assert.deepEqual(JSON.parse(readFileSync(process.env.ARC_SLOW_TEST_REMEASURE, 'utf8')), { fast: 5, 'very slow': 1500 });
  } finally {
    if (previous === undefined) delete process.env.ARC_SLOW_TEST_REMEASURE; else process.env.ARC_SLOW_TEST_REMEASURE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an allowlist entry without a written reason is refused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-allowlist-test-'));
  try {
    const path = join(directory, 'allowlist.json');
    writeFileSync(path, JSON.stringify({ tests: ['packages/a/src/x.test.ts > very slow'] }));
    assert.throws(() => readAllowlist(path), /reason written out/);
    writeFileSync(path, JSON.stringify({ tests: [{ test: 'packages/a/src/x.test.ts > very slow', reason: 'CPU bound by the 8 MiB ceiling under test, no disk or timer.' }] }));
    assert.deepEqual([...readAllowlist(path)], ['packages/a/src/x.test.ts > very slow']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an allowlisted test that ran under 300 ms is named for removal, and one still slow is not', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-allowlist-stale-'));
  try {
    const allowlist = join(directory, 'allowlist.json');
    const reason = 'CPU bound by the ceiling under test; no timer, disk or socket.';
    writeFileSync(allowlist, JSON.stringify({ tests: [{ test: 'packages/a/src/x.test.ts > was slow', reason }, { test: 'packages/a/src/x.test.ts > very slow', reason }] }));
    const module = fakeModule('packages/a/src/x.test.ts', [fakeTest('was slow', 40), fakeTest('very slow', 1500)]);
    const { exitCode, printed } = await report(new SlowTestReporter({ allowlist, remeasure: async () => new Map() }), [module]);
    assert.equal(exitCode, 0);
    assert.match(printed, /remove from scripts\/slow-test-allowlist\.json:\n {2}40 ms {2}packages\/a\/src\/x\.test\.ts > was slow$/m);
    assert.doesNotMatch(printed.split('Slow tests')[0], /very slow/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
