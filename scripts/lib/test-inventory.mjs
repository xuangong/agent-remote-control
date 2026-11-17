import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const skippedDirectories = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', '.git', '.worktrees']);

/** Every file under a directory, skipping dependency, build and report folders. Paths are relative to `base`. */
export function listFiles(directory, base = directory) {
  const files = [];
  let entries;
  try { entries = readdirSync(directory); } catch { return files; }
  for (const name of entries) {
    if (skippedDirectories.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...listFiles(path, base));
    else files.push(relative(base, path));
  }
  return files.sort();
}

const lineCount = path => { const text = readFileSync(path, 'utf8'); return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0); };
const isTestFile = file => /\.(test|spec)\.[cm]?[tj]sx?$|\.browser\.ts$/.test(file) || /(^|\/)(test|e2e|test-utils)\//.test(file);
const isSourceFile = file => /\.(ts|tsx|mjs)$/.test(file) && !file.endsWith('.d.ts') && !isTestFile(file);

/** Test files per kind, by name: Vitest unit, process and native files, Playwright specs, and Node `node:test` scripts. */
export function countTestFiles(files) {
  const kinds = { vitestUnit: 0, vitestProcess: 0, vitestNative: 0, playwrightSpec: 0, browserInventory: 0, nodeTestScript: 0 };
  for (const file of files) {
    if (/\.local\.test\.tsx?$/.test(file)) kinds.vitestNative += 1;
    else if (/\.process\.test\.tsx?$/.test(file)) kinds.vitestProcess += 1;
    else if (/\.test\.tsx?$/.test(file)) kinds.vitestUnit += 1;
    else if (/\.spec\.ts$/.test(file) && /(^|\/)e2e\//.test(file)) kinds.playwrightSpec += 1;
    else if (/\.browser\.ts$/.test(file)) kinds.browserInventory += 1;
    else if (/\.test\.mjs$/.test(file)) kinds.nodeTestScript += 1;
  }
  return kinds;
}

/** Source lines per package under `<package>/src`, without tests, and the largest files overall. */
export function measureSources(packagesDirectory, largestCount = 15) {
  const packages = {};
  const all = [];
  for (const name of readdirSync(packagesDirectory).sort()) {
    const sourceRoot = join(packagesDirectory, name, 'src');
    const files = listFiles(sourceRoot).filter(isSourceFile);
    if (files.length === 0) continue;
    const sized = files.map(file => ({ file: `packages/${name}/src/${file}`, lines: lineCount(join(sourceRoot, file)) }));
    packages[name] = { files: sized.length, lines: sized.reduce((sum, entry) => sum + entry.lines, 0) };
    all.push(...sized);
  }
  all.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  return { packages, largest: all.slice(0, largestCount), over800: all.filter(entry => entry.lines > 800).length };
}

/** Totals of the per-package reports the Vitest slow-test reporter writes. */
export function mergeReports(reports) {
  const packages = {};
  const tiers = {};
  const totals = { tests: 0, over300ms: 0, over1s: 0 };
  for (const report of [...reports].sort((a, b) => a.package.localeCompare(b.package))) {
    packages[report.package] = { tests: report.tests, over300ms: report.over300ms, over1s: report.over1s, tiers: report.tiers };
    totals.tests += report.tests;
    totals.over300ms += report.over300ms;
    totals.over1s += report.over1s;
    for (const [tier, tally] of Object.entries(report.tiers ?? {})) {
      const merged = tiers[tier] ??= { tests: 0, over300ms: 0, over1s: 0 };
      merged.tests += tally.tests;
      merged.over300ms += tally.over300ms;
      merged.over1s += tally.over1s;
    }
  }
  return { totals, tiers, packages };
}

/** Test count from `playwright test --list` output: every project's run, and the distinct tests behind them. */
export function parsePlaywrightList(output) {
  const titles = new Set();
  let runs = 0;
  for (const line of output.split('\n')) {
    const match = /^\s*\[[^\]]+\] › (.+)$/.exec(line);
    if (!match) continue;
    runs += 1;
    titles.add(match[1].replace(/:\d+:\d+/, ''));
  }
  return { runs, distinctTests: titles.size };
}

/** The slowest tests kept in the metrics file: the ones over 300 ms, by file, so the ratchet can see where they sit. */
export function slowTestsByFile(reports) {
  const counts = {};
  for (const report of reports) for (const test of report.slowest ?? []) if (test.durationMs > 300) counts[test.file] = (counts[test.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
