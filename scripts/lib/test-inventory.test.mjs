import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { countTestFiles, listFiles, measureSources, mergeReports, parsePlaywrightList, slowTestsByFile } from './test-inventory.mjs';
import { countTiers, tierOf } from './test-tiers.mjs';
import { SlowTestReporter } from './slow-test-reporter.mjs';

function sampleTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'arc-inventory-sample-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('a test file belongs to the tier its name and Vitest project give', () => {
  assert.equal(tierOf('packages/a/src/x.test.ts', 'unit'), 'unit');
  assert.equal(tierOf('packages/a/src/x.local.test.ts', 'unit'), 'native');
  assert.equal(tierOf('packages/a/src/cli-x.test.ts', 'process'), 'process');
  assert.equal(tierOf('packages/a/e2e/x.browser.ts'), 'browser');
  assert.equal(tierOf('packages/a/tests/S1/x.integration.test.ts', 'integration'), 'integration');
  assert.equal(tierOf('packages/a/src/x.contract.test.ts'), 'contract');
});

test('tests are counted per tier with those over 300 ms and over 1 s', () => {
  const tiers = countTiers([
    { tier: 'unit', durationMs: 10 }, { tier: 'unit', durationMs: 301 }, { tier: 'unit', durationMs: 1001 }, { tier: 'process', durationMs: 5000 },
  ]);
  assert.deepEqual(tiers, { unit: { tests: 3, over300ms: 2, over1s: 1 }, process: { tests: 1, over300ms: 1, over1s: 1 } });
});

test('test files are counted by kind and source lines by package without tests', () => {
  const root = sampleTree({
    'a/src/one.ts': 'a\nb\nc\n',
    'a/src/one.test.ts': 'x\n',
    'a/src/two.local.test.ts': 'x\n',
    'a/src/types.d.ts': 'x\n',
    'a/e2e/flow.spec.ts': 'x\n',
    'a/node_modules/dependency/index.ts': 'x\n',
    'b/src/big.ts': `${'line\n'.repeat(900)}`,
  });
  try {
    const files = listFiles(root);
    assert.deepEqual(countTestFiles(files), { vitestUnit: 1, vitestContract: 0, vitestIntegration: 0, vitestTransport: 0, vitestProcess: 0, vitestWorkers: 0, vitestNative: 1, playwrightSpec: 1, browserInventory: 0, nodeTestScript: 0 });
    const sources = measureSources(root);
    assert.deepEqual(sources.packages, { a: { files: 1, lines: 3 }, b: { files: 1, lines: 900 } });
    assert.deepEqual(sources.largest.map(entry => entry.file), ['packages/b/src/big.ts', 'packages/a/src/one.ts']);
    assert.equal(sources.over800, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package reports merge into totals and per-tier counts', () => {
  const tally = { tests: 2, over300ms: 1, over1s: 0 };
  const merged = mergeReports([
    { package: 'b', tests: 2, over300ms: 1, over1s: 0, tiers: { unit: tally } },
    { package: 'a', tests: 5, over300ms: 0, over1s: 0, tiers: { unit: { tests: 5, over300ms: 0, over1s: 0 }, process: tally } },
  ]);
  assert.deepEqual(merged.totals, { tests: 7, over300ms: 1, over1s: 0 });
  assert.deepEqual(merged.tiers.unit, { tests: 7, over300ms: 1, over1s: 0 });
  assert.deepEqual(Object.keys(merged.packages), ['a', 'b']);
  assert.deepEqual(slowTestsByFile([{ slowest: [{ file: 'f.test.ts', durationMs: 400 }, { file: 'f.test.ts', durationMs: 200 }] }]), { 'f.test.ts': 1 });
});

test('a Playwright listing gives the runs of every project and the distinct tests behind them', () => {
  const output = ['Listing tests:', '  [chromium] › a.spec.ts:3:1 › opens', '  [webkit] › a.spec.ts:3:1 › opens', '  [chromium] › b.spec.ts:9:1 › closes', 'Total: 3 tests in 2 files'].join('\n');
  assert.deepEqual(parsePlaywrightList(output), { runs: 3, distinctTests: 2 });
});

test('the reporter writes per-tier counts and counts only mock-data tests against the speed rule', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-reporter-'));
  const previous = process.env.ARC_SLOW_TEST_DIR;
  process.env.ARC_SLOW_TEST_DIR = directory;
  const root = new URL('../..', import.meta.url).pathname;
  const fakeTest = (name, duration) => ({ fullName: name, diagnostic: () => ({ duration }), result: () => ({ state: 'passed' }) });
  const fakeModule = (file, project, tests) => ({ moduleId: join(root, file), project: { name: project }, children: { allTests: () => tests } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    new SlowTestReporter().onTestRunEnd([
      fakeModule('packages/a/src/x.test.ts', 'unit', [fakeTest('fast', 5), fakeTest('slow', 400), fakeTest('very slow', 1500)]),
      fakeModule('packages/a/src/cli-y.test.ts', 'process', [fakeTest('spawns a process', 4000)]),
    ]);
    const report = JSON.parse(readFileSync(join(directory, `${basename(process.cwd())}.json`), 'utf8'));
    assert.equal(report.tests, 3);
    assert.equal(report.over300ms, 2);
    assert.equal(report.over1s, 1);
    assert.deepEqual(report.tiers, { unit: { tests: 3, over300ms: 2, over1s: 1 }, process: { tests: 1, over300ms: 1, over1s: 1 } });
  } finally {
    console.warn = warn;
    if (previous === undefined) delete process.env.ARC_SLOW_TEST_DIR; else process.env.ARC_SLOW_TEST_DIR = previous;
    process.exitCode = 0;
    rmSync(directory, { recursive: true, force: true });
  }
});
