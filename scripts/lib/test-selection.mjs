// Which unit tests a change runs, by module (target architecture section 5.9): each changed file belongs to a module of
// architecture/modules.json, and the change runs that module's own test files and the seam suites the module names.
// Modules that import the changed one directly also run the test files that reach the changed file through the import graph,
// nearest first and at most DEPENDENT_TEST_LIMIT of them; the seams, the type check and the step's full `pnpm verify` cover the rest.
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

/** The most test files of dependent modules one change runs; beyond it the nearest to the changed file run first. */
export const DEPENDENT_TEST_LIMIT = 80;
const isProductionFile = (file, module) => module.layer !== TEST_SUPPORT_LAYER && !isTestFile(file) && !/(^|\/)(test|e2e|test-utils)\//.test(file) && !/\.(test-fixture|fixture)\.tsx?$/.test(file);

/**
 * The test files of dependent modules a change reaches. A module depends on another when one of its production files imports a
 * file of it. Of those modules' unit tests, the ones that import the changed file, directly or through other files, run,
 * nearest first. `graph` maps each file to the files it imports (arch-check `importGraph`).
 * Returns the files by distance and whether the limit cut some.
 */
export function dependentTests({ changed, files, modules, graph, limit = DEPENDENT_TEST_LIMIT }) {
  const { assigned } = assignModules([...new Set([...files, ...changed])], modules);
  const importers = new Map();
  const dependents = new Map();
  for (const [file, targets] of graph) {
    const module = assigned.get(file);
    for (const target of targets) {
      (importers.get(target) ?? importers.set(target, []).get(target)).push(file);
      const targetModule = assigned.get(target);
      if (module && targetModule && module !== targetModule && isProductionFile(file, module)) (dependents.get(targetModule.name) ?? dependents.set(targetModule.name, new Set()).get(targetModule.name)).add(module.name);
    }
  }
  const nearest = new Map();
  for (const file of changed) {
    const module = assigned.get(file);
    if (!module || !graph.has(file) || !isProductionFile(file, module)) continue;
    const reached = new Map([[file, 0]]);
    for (let layer = [file]; layer.length;) {
      const next = [];
      for (const current of layer) for (const importer of importers.get(current) ?? []) if (!reached.has(importer)) { reached.set(importer, reached.get(current) + 1); next.push(importer); }
      layer = next;
    }
    for (const [candidate, distance] of reached) {
      const owner = assigned.get(candidate);
      if (!owner || !isUnitTest(candidate) || !dependents.get(module.name)?.has(owner.name)) continue;
      nearest.set(candidate, Math.min(distance, nearest.get(candidate) ?? Infinity));
    }
  }
  const ordered = [...nearest].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([file]) => file);
  return { files: ordered.slice(0, limit), capped: ordered.length > limit, reached: ordered.length };
}

/**
 * The plan for a change: per package, the test files to run (`all` for its whole unit suite), and the seam suites.
 * - A file in a module runs the module's own test files (in every package the module spans) and the module's `seams`.
 * - Test support (a layer-5 module) under a package's `src/` is shared by unit tests the module map cannot see, so a change
 *   to its non-test files runs that package's whole suite and its seams; test support elsewhere (e2e pages, fixture
 *   packages) runs the module's own tests. A changed seam test runs its seam's suite.
 * - A package file outside every module (a manifest or a configuration) runs that package's whole suite.
 * - Documents and files outside `packages/` run nothing here.
 * - With an import `graph`, the unit tests of the modules that import a changed module run too, when they reach the changed
 *   file (`dependentTests`); `dependents` reports how many and whether the limit cut some.
 * `files` are all files under `packages/`, repository-relative; `modules` and `packages` come from the module map and the manifests.
 */
export function planTests({ changed, files, modules, packages, graph, dependentLimit }) {
  const { assigned } = assignModules([...new Set([...files, ...changed])], modules);
  const runs = new Map();
  const seams = new Set();
  const flows = new Set();
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
    for (const flow of module.flows ?? []) flows.add(flow);
    if (module.layer === TEST_SUPPORT_LAYER && !isTestFile(file) && file.startsWith(`${directory}/src/`)) { run(directory).all = true; continue; }
    for (const candidate of files) {
      if (assigned.get(candidate) !== module || !isUnitTest(candidate)) continue;
      const owner = packageDirectory(candidate);
      if (packages[owner]) run(owner).files.add(candidate.slice(owner.length + 1));
    }
  }
  const dependents = graph ? dependentTests({ changed: changed.filter(file => packages[packageDirectory(file)] && !file.endsWith('.md')), files, modules, graph, limit: dependentLimit }) : { files: [], capped: false, reached: 0 };
  for (const file of dependents.files) {
    const owner = packageDirectory(file);
    if (packages[owner] && !runs.get(owner)?.all) run(owner).files.add(file.slice(owner.length + 1));
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
  const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  return { dependents: { count: dependents.files.length, reached: dependents.reached, capped: dependents.capped }, modules: [...moduleNames].sort(), seams: [...seams].sort(), flows: [...flows].sort(byNumber), runs: plan.sort((a, b) => order(a).localeCompare(order(b))) };
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
  if (plan.dependents?.count) lines.push(`Dependent modules: ${plan.dependents.count} test files reach the changed files${plan.dependents.capped ? ` (the ${plan.dependents.count} nearest of ${plan.dependents.reached}; the full verify runs the rest)` : ''}.`);
  // E2E flows never run here (section 5.9): the step's end runs them.
  if (plan.flows?.length) lines.push(`Flows these modules take part in, for the step's end: ${plan.flows.join(', ')}.`);
  return lines.join('\n');
}
