// Measures the test suites: tests per package and tier, tests over 300 ms and over 1 s, and source module sizes.
// Writes docs/superpowers/specs/test-metrics.json (format: version 1: vitest totals, tiers and packages; test files by kind; Playwright count; slow test files; source sizes; architecture report summary). A report-only command; it changes no test.
// Usage: pnpm test:inventory [--reports <directory of reporter JSON>] [--output <path>]
//   Without --reports it runs every package's unit suite once (several minutes) with the slow-test reporter writing to a temporary directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTestFiles, listFiles, measureSources, mergeReports, parsePlaywrightList, slowTestsByFile } from './lib/test-inventory.mjs';
import { packageManager } from './lib/package-manager.mjs';
import { analyze, readModuleMap } from './lib/arch-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const output = resolve(option('--output') ?? join(root, 'docs/superpowers/specs/test-metrics.json'));
let reportsDirectory = option('--reports');
let temporary;

if (!reportsDirectory) {
  temporary = mkdtempSync(join(tmpdir(), 'arc-inventory-'));
  reportsDirectory = temporary;
  console.log('Running every unit suite once to measure it; this takes several minutes.');
  const [command, commandArgs] = packageManager('pnpm', ['-r', '--workspace-concurrency=1', '--no-bail', 'run', 'test']);
  const result = spawnSync(command, commandArgs, {
    cwd: root, stdio: 'inherit', timeout: 1_500_000, env: { ...process.env, ARC_SLOW_TEST_DIR: temporary },
  });
  if (result.status !== 0) console.warn(`The unit run exited with status ${result.status}; the metrics cover the packages that reported.`);
}

const reports = readdirSync(reportsDirectory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(reportsDirectory, name), 'utf8')));
const files = listFiles(join(root, 'packages')).concat(listFiles(join(root, 'scripts')).map(file => `scripts/${file}`));
let playwright = { runs: 0, distinctTests: 0 };
try {
  const [command, commandArgs] = packageManager('pnpm', ['--filter', '@orchardworks/agent-remote-lab', 'exec', 'playwright', 'test', '--list']);
  playwright = parsePlaywrightList(execFileSync(command, commandArgs, { cwd: root, encoding: 'utf8', timeout: 120_000 }));
} catch (error) { console.warn(`Playwright listing failed: ${error.message}`); }

const { totals, tiers, packages } = mergeReports(reports);
const architecture = analyze({ root, config: readModuleMap(join(root, 'architecture/modules.json')) });
const metrics = {
  version: 1,
  measuredAt: new Date().toISOString().slice(0, 10),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.versions.node,
  note: 'Mock-data tiers are the Vitest tests outside the process, native and browser tiers. over300ms and over1s count those tests only.',
  vitest: { totals, tiers, packages },
  testFiles: countTestFiles(files),
  playwright,
  slowTestFiles: slowTestsByFile(reports),
  sources: measureSources(join(root, 'packages')),
  architecture: { files: architecture.files, unassigned: architecture.unassigned.length, overlapping: architecture.overlapping.length, violations: architecture.violationCounts, inlineWireMessagesInTests: architecture.wireLiterals },
};
writeFileSync(output, `${JSON.stringify(metrics, null, 1)}\n`);
console.log(`Wrote ${output}: ${totals.tests} Vitest tests, ${totals.over300ms} over 300 ms, ${totals.over1s} over 1 s.`);
if (temporary) rmSync(temporary, { recursive: true, force: true });
