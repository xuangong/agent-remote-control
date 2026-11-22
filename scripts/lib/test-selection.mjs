// Which unit tests a change runs, by module (target architecture section 5.9): each changed file belongs to a module of
// architecture/modules.json, and the change runs that module's own test files and the seam suites the module names.
// Modules that depend on the changed one are not run; the seams and the type check of the dependent packages stand for them,
// and the full `pnpm verify` runs everything at the end of a step.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignModules } from './arch-check.mjs';
import { listFiles } from './test-inventory.mjs';

const TEST_SUPPORT_LAYER = 5;
/** A unit or integration test file a package's Vitest runs; the package's own configuration still decides what it includes. */
export const isUnitTest = file => /\.test\.[cm]?[tj]sx?$/.test(file) && !/\.local\.test\./.test(file);
const isTestFile = file => isUnitTest(file) || /\.(spec|browser)\.[cm]?[tj]sx?$/.test(file);
const packageDirectory = file => /^packages\/[^/]+/.exec(file)?.[0];
/** The seam suites live in one package, a directory per seam. */
export const SEAMS_DIRECTORY = 'packages/agent-remote-seams';
const seamOf = file => new RegExp(`^${SEAMS_DIRECTORY}/tests/(S\\d+)/`).exec(file)?.[1];

/**
 * The plan for a change: per package, the test files to run (`all` for its whole unit suite), and the seam suites.
 * - A file in a module runs the module's own test files (in every package the module spans) and the module's `seams`.
 * - Test support (a layer-5 module) under a package's `src/` is shared by unit tests the module map cannot see, so a change
 *   to its non-test files runs that package's whole suite and its seams; test support elsewhere (e2e pages, fixture
 *   packages) runs the module's own tests. A changed seam test runs its seam's suite.
 * - A package file outside every module (a manifest or a configuration) runs that package's whole suite.
 * - Documents and files outside `packages/` run nothing here.
 * `files` are all files under `packages/`, repository-relative; `modules` and `packages` come from the module map and the manifests.
 */
export function planTests({ changed, files, modules, packages }) {
  const { assigned } = assignModules([...new Set([...files, ...changed])], modules);
  const runs = new Map();
  const seams = new Set();
  const moduleNames = new Set();
  const run = directory => { let entry = runs.get(directory); if (!entry) runs.set(directory, entry = { all: false, files: new Set() }); return entry; };
  for (const file of changed) {
    const directory = packageDirectory(file);
    if (!directory || !packages[directory] || file.endsWith('.md')) continue;
    if (directory === SEAMS_DIRECTORY) {
      const seam = seamOf(file);
      if (seam) seams.add(seam); else run(directory).all = true;
      continue;
    }
    const module = assigned.get(file);
    if (!module) { run(directory).all = true; continue; }
    moduleNames.add(module.name);
    for (const seam of module.seams ?? []) seams.add(seam);
    if (module.layer === TEST_SUPPORT_LAYER && !isTestFile(file) && file.startsWith(`${directory}/src/`)) { run(directory).all = true; continue; }
    for (const candidate of files) {
      if (assigned.get(candidate) !== module || !isUnitTest(candidate)) continue;
      const owner = packageDirectory(candidate);
      if (packages[owner]) run(owner).files.add(candidate.slice(owner.length + 1));
    }
  }
  // A seam suite named by a module runs once, in the seams package, unless that package already runs whole.
  const seamRun = runs.get(SEAMS_DIRECTORY);
  const plan = [...runs].filter(([, entry]) => entry.all || entry.files.size > 0)
    .map(([directory, entry]) => ({ directory, name: packages[directory].name, script: packages[directory].script, all: entry.all, files: entry.all ? [] : [...entry.files].sort() }));
  if (seams.size && !seamRun?.all && packages[SEAMS_DIRECTORY]) {
    const seamFiles = [...seams].sort().map(seam => `tests/${seam}/`);
    const existing = plan.find(entry => entry.directory === SEAMS_DIRECTORY);
    if (existing) existing.files = [...new Set([...existing.files, ...seamFiles])].sort();
    else plan.push({ directory: SEAMS_DIRECTORY, name: packages[SEAMS_DIRECTORY].name, script: packages[SEAMS_DIRECTORY].script, all: false, files: seamFiles });
  }
  // The modules' own tests first, the seam suites last.
  const order = entry => `${entry.directory === SEAMS_DIRECTORY ? 1 : 0}${entry.directory}`;
  return { modules: [...moduleNames].sort(), seams: [...seams].sort(), runs: plan.sort((a, b) => order(a).localeCompare(order(b))) };
}

/** Every workspace package by directory, with the script that holds its unit tests (`test:unit` where a package has one). */
export function workspacePackages(root) {
  const packages = {};
  for (const file of listFiles(join(root, 'packages')).filter(file => /^[^/\\]+[/\\]package\.json$/.test(file))) {
    const directory = `packages/${file.split(/[/\\]/)[0]}`;
    const { name, scripts = {} } = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    if (scripts['test:unit'] || scripts.test) packages[directory] = { name, script: scripts['test:unit'] ? 'test:unit' : 'test' };
  }
  return packages;
}

/** All files under `packages/`, repository-relative with forward slashes. */
export function packageFiles(root) {
  return listFiles(join(root, 'packages')).map(file => `packages/${file.split('\\').join('/')}`);
}

/** The module map of a repository. */
export function readModules(root) {
  const path = join(root, 'architecture/modules.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).modules : [];
}

/** A plan in words, one line per run, for a person reading the log. */
export function describePlan(plan) {
  if (!plan.runs.length) return 'No module test changed, so no unit test runs.';
  const lines = [`Modules: ${plan.modules.join(', ') || 'none'}; seams: ${plan.seams.join(', ') || 'none'}.`];
  for (const entry of plan.runs) lines.push(`  ${entry.name}: ${entry.all ? 'the whole unit suite' : `${entry.files.length} test ${entry.files.length === 1 ? 'path' : 'paths'}`}`);
  return lines.join('\n');
}
