import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { listFiles } from './test-inventory.mjs';

const TEST_SUPPORT_LAYER = 5;
const sourceExtension = /\.(ts|tsx|mts|mjs)$/;

/** A path pattern as a regular expression: `**` crosses directories, `*` stays inside one. */
export function globToRegExp(glob) {
  const source = glob.split('**').map(part => part.split('*').map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${source}$`);
}

/** How specific a pattern is: the length of its literal prefix, then its literal characters. The most specific matching pattern decides a file's module. */
const specificity = glob => { const star = glob.indexOf('*'); return (star === -1 ? glob.length : star) * 1000 + glob.replace(/\*/g, '').length; };

/** The module of each file by most specific path pattern; a file matched equally by two modules is reported as overlapping. */
export function assignModules(files, modules) {
  const patterns = modules.flatMap(module => module.paths.map(glob => ({ module, regex: globToRegExp(glob), rank: specificity(glob) })));
  const assigned = new Map();
  const unassigned = [];
  const overlapping = [];
  for (const file of files) {
    const matches = patterns.filter(pattern => pattern.regex.test(file));
    if (matches.length === 0) { unassigned.push(file); continue; }
    const best = Math.max(...matches.map(match => match.rank));
    const winners = [...new Set(matches.filter(match => match.rank === best).map(match => match.module.name))];
    if (winners.length > 1) overlapping.push({ file, modules: winners });
    assigned.set(file, modules.find(module => module.name === winners[0]));
  }
  return { assigned, unassigned, overlapping };
}

const importPattern = /(?:\bimport|\bexport)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The module specifiers a source file imports, re-exports or dynamically imports. */
export function importsOf(text) {
  return [...text.matchAll(importPattern)].map(match => match[1] ?? match[2] ?? match[3]);
}

const isTestFile = file => /\.(test|spec)\.[cm]?[tj]sx?$|\.browser\.ts$|(^|\/)(test|e2e|test-utils)\//.test(file) || /\.(test-fixture|fixture)\.tsx?$/.test(file);

function resolveRelative(from, specifier, fileSet) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.(m?js)$/, '');
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

/** The source file behind a package subpath, through the package's `exports` map (published as `dist/<name>.js`, kept as `src/<name>.ts`). */
function subpathSource(root, dir, subpath, fileSet) {
  let exportsMap;
  try { exportsMap = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).exports ?? {}; } catch { return undefined; }
  const exact = exportsMap[`./${subpath}`];
  const wildcard = exportsMap['./*'];
  const target = exact ? (exact.import ?? exact) : wildcard && (wildcard.import ?? wildcard).replace('*', subpath);
  if (typeof target !== 'string') return undefined;
  const source = `${dir}/${target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '')}`;
  // A declared export that is not a TypeScript module (a stylesheet) has no source file to check.
  const file = ['.ts', '.tsx', '/index.ts'].map(extension => `${source}${extension}`).find(candidate => fileSet.has(candidate)) ?? null;
  return { file, wildcard: !exact };
}

function resolvePackage(root, specifier, packages, fileSet) {
  const name = Object.keys(packages).filter(key => specifier === key || specifier.startsWith(`${key}/`)).sort((a, b) => b.length - a.length)[0];
  if (!name) return undefined;
  const { dir, entry } = packages[name];
  const subpath = specifier.slice(name.length + 1);
  if (!subpath) return { name, file: `${dir}/${entry}`, subpath };
  const found = subpathSource(root, dir, subpath, fileSet);
  return { name, file: found?.file ?? undefined, subpath, declared: found !== undefined, wildcard: found?.wildcard === true };
}

/**
 * The import graph of the scanned files: for each file, the scanned files it imports, re-exports or dynamically imports,
 * by relative path or through a workspace package's entry and `exports` map. Test files take part, so a test is found
 * through the source it exercises.
 */
export function importGraph({ root, config }) {
  const globs = config.scan.map(globToRegExp);
  const files = listFiles(join(root, 'packages')).map(file => `packages/${file.split('\\').join('/')}`)
    .filter(file => sourceExtension.test(file) && !file.endsWith('.d.ts') && globs.some(glob => glob.test(file)));
  const fileSet = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const targets = new Set();
    for (const specifier of importsOf(readFileSync(join(root, file), 'utf8'))) {
      const target = specifier.startsWith('.') ? resolveRelative(file, specifier, fileSet) : resolvePackage(root, specifier, config.packages, fileSet)?.file;
      if (target && fileSet.has(target) && target !== file) targets.add(target);
    }
    graph.set(file, [...targets]);
  }
  return graph;
}

/** Finds the wire message type names the protocol declares, so tests that hand-write one can be counted. */
function wireTypeNames(root, protocolFiles) {
  const names = new Set();
  for (const file of protocolFiles) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(/\btype:\s*Type\.Literal\('([a-z][a-z0-9_]*)'\)/g)) names.add(match[1]);
  }
  return names;
}

const matchesAny = (name, patterns) => patterns.some(pattern => globToRegExp(pattern).test(name));

/** Source text without comments and string literals' contents, so a pattern is matched against code only. */
const codeOf = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

/**
 * Reports how the files under a repository follow the layer rules (section 1.2 of the target architecture) and the module map:
 * unassigned and overlapping files, imports that run up the layers, contracts that import the workspace, imports across packages
 * by path or through a wildcard export, test support used by production code, impure domain code, edges the module map forbids
 * (`edges`, `bans`), imports of a module of the same package that a module's `uses` list leaves out (`sibling`), composition
 * roots over their line budget (`roots`), and wire messages written inline in tests.
 * It changes nothing; `evaluate` compares the result with the documented exceptions.
 */
export function analyze({ root, config }) {
  const globs = config.scan.map(globToRegExp);
  const files = listFiles(join(root, 'packages')).map(file => `packages/${file.split('\\').join('/')}`)
    .filter(file => sourceExtension.test(file) && !file.endsWith('.d.ts') && globs.some(glob => glob.test(file)));
  const fileSet = new Set(files);
  const { assigned, unassigned, overlapping } = assignModules(files, config.modules);
  const violations = [];
  const record = (kind, file, imported, detail, targetModule) => violations.push({ kind, file, imported, detail, module: assigned.get(file)?.name, targetModule });
  const packageOf = file => /^packages\/[^/]+/.exec(file)?.[0];
  const packageNames = Object.fromEntries(Object.entries(config.packages).map(([name, { dir }]) => [dir, name]));
  const texts = new Map(files.map(file => [file, readFileSync(join(root, file), 'utf8')]));

  for (const file of files) {
    const module = assigned.get(file);
    if (!module) continue;
    const testFile = isTestFile(file) || module.layer === TEST_SUPPORT_LAYER;
    const text = texts.get(file);
    const specifiers = importsOf(text);
    if (!testFile) {
      for (const ban of config.bans ?? []) {
        if (!matchesAny(module.name, ban.modules)) continue;
        for (const specifier of specifiers) if (matchesAny(specifier, ban.imports ?? [])) record(ban.id, file, specifier, `${module.name} imports ${specifier} (rule ${ban.rule})`);
        const code = codeOf(text);
        for (const pattern of ban.code ?? []) if (new RegExp(pattern).test(code)) record(ban.id, file, pattern, `${module.name} uses ${pattern} (rule ${ban.rule})`);
      }
      for (const root of config.roots ?? []) {
        const lines = text.split('\n').length;
        if (file === root.file && lines > root.maxLines) record('root-too-large', file, `${lines} lines`, `${file} has ${lines} lines; a composition root stays under ${root.maxLines} (rule 10)`);
      }
    }
    for (const specifier of specifiers) {
      if (!testFile && module.layer <= 1 && specifier.startsWith('node:')) record('domain-impurity', file, specifier, `${module.name} (layer ${module.layer}) imports a Node built-in`);
      if (/\/dist(\/|$)/.test(specifier)) record('dist-import', file, specifier, 'imports a build artifact');
      let target;
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier, fileSet);
        const targetPath = resolved ?? posix.normalize(posix.join(posix.dirname(file), specifier));
        if (packageOf(targetPath) && packageOf(targetPath) !== packageOf(file)) record('cross-package-relative', file, specifier, `reaches into ${packageOf(targetPath)} by path`, assigned.get(resolved)?.name);
        target = resolved;
      } else {
        const resolved = resolvePackage(root, specifier, config.packages, fileSet);
        target = resolved?.file;
        if (resolved && resolved.subpath && !resolved.declared) record('deep-import', file, specifier, `${resolved.name} exports no such subpath`);
        else if (resolved?.wildcard) { record('deep-import', file, specifier, `${resolved.name} reaches this file only through its wildcard export`, assigned.get(target)?.name); }
        if (!testFile && module.layer === 0 && resolved && resolved.name !== packageNames[packageOf(file)]) record('contract-imports-workspace', file, specifier, `${module.name} (layer 0) imports ${resolved.name}`);
      }
      const targetModule = target && assigned.get(target);
      if (!targetModule || targetModule === module) continue;
      if (testFile) continue;
      // An edge names the rule more precisely than the layer table, so the import is reported once, under the edge.
      const forbidden = (config.edges ?? []).filter(edge => matchesAny(module.name, edge.from) && matchesAny(targetModule.name, edge.to) && !matchesAny(file, edge.exceptFiles ?? []));
      for (const edge of forbidden) record(edge.id, file, specifier, `${module.name} imports ${targetModule.name} (rule ${edge.rule})`, targetModule.name);
      if (forbidden.length > 0) continue;
      if (targetModule.layer === TEST_SUPPORT_LAYER) record('test-support-in-production', file, specifier, `${module.name} imports ${targetModule.name}`, targetModule.name);
      // A module that lists `uses` reaches the other modules of its own package only through that list (one-way feature modules).
      else if (Array.isArray(module.uses) && packageOf(target) === packageOf(file) && !module.uses.includes(targetModule.name)) {
        record('sibling', file, specifier, `${module.name} imports ${targetModule.name}, which its uses list does not name`, targetModule.name);
      }
      else if (targetModule.layer > module.layer && module.layer < 4) record('layer', file, specifier, `${module.name} (layer ${module.layer}) imports ${targetModule.name} (layer ${targetModule.layer})`, targetModule.name);
      else if (module.layer === 3 && targetModule.layer === 3 && packageOf(file) !== packageOf(target)) record('adapter-imports-adapter', file, specifier, `${module.name} imports ${targetModule.name}`, targetModule.name);
    }
  }

  const wireTypes = wireTypeNames(root, files.filter(file => config.wireModules.includes(assigned.get(file)?.name) && !isTestFile(file)));
  const wireLiterals = { files: 0, occurrences: 0, byPackage: {} };
  for (const file of files) {
    const module = assigned.get(file);
    if (!module || !isTestFile(file) || config.wireTestExempt.includes(module.name)) continue;
    const count = [...texts.get(file).matchAll(/\btype:\s*'([a-z][a-z0-9_]*)'/g)].filter(match => wireTypes.has(match[1])).length;
    if (count === 0) continue;
    wireLiterals.files += 1;
    wireLiterals.occurrences += count;
    const key = packageOf(file).slice('packages/'.length);
    wireLiterals.byPackage[key] = (wireLiterals.byPackage[key] ?? 0) + count;
  }

  const modules = {};
  for (const [file, module] of assigned) {
    const size = modules[module.name] ??= { layer: module.layer, files: 0, lines: 0, testFiles: 0 };
    if (isTestFile(file)) { size.testFiles += 1; continue; }
    size.files += 1;
    size.lines += texts.get(file).split('\n').length;
  }
  const counts = {};
  for (const violation of violations) counts[violation.kind] = (counts[violation.kind] ?? 0) + 1;
  return { files: files.length, unassigned, overlapping, violations, violationCounts: counts, wireLiterals, modules };
}

const exceptionOwner = /^M(?:[3-9]|1[0-4])$/;

/**
 * Compares a report with the documented exceptions. An exception names a rule, the importing files (`from`), what they
 * import (`to`, a module name or a specifier pattern) and the migration step that removes it (`owner`, M3 to M14), and
 * allows at most `max` occurrences. Anything beyond that is a new violation; fewer occurrences than `max` means the
 * exception must be lowered, so a fixed violation can never come back unnoticed.
 */
export function evaluate(report, exceptions = []) {
  const failures = [];
  const invalid = exceptions.filter(entry => !exceptionOwner.test(entry.owner ?? '') || !entry.reason || !Number.isInteger(entry.max) || entry.max < 1);
  for (const entry of invalid) failures.push({ kind: 'invalid-exception', detail: `exception ${JSON.stringify(entry.rule)} ${JSON.stringify(entry.from)} needs an owner step M3 to M14, a reason and a max of at least 1` });
  const used = exceptions.map(() => 0);
  for (const violation of report.violations) {
    const covers = (entry, index) => entry.rule === violation.kind && used[index] < entry.max && matchesAny(violation.file, entry.from ?? ['**'])
      && (entry.to === undefined && entry.toImport === undefined
        || entry.to !== undefined && matchesAny(violation.targetModule ?? '', entry.to)
        || entry.toImport !== undefined && matchesAny(violation.imported, entry.toImport));
    const at = exceptions.findIndex(covers);
    if (at === -1) failures.push({ kind: violation.kind, detail: `${violation.file}: ${violation.detail} (${violation.imported})` });
    else used[at] += 1;
  }
  for (const file of report.unassigned) failures.push({ kind: 'unassigned', detail: `${file} belongs to no module in architecture/modules.json` });
  for (const { file, modules } of report.overlapping) failures.push({ kind: 'overlapping', detail: `${file} belongs equally to ${modules.join(' and ')}` });
  const stale = exceptions.flatMap((entry, index) => used[index] < entry.max
    ? [{ kind: 'stale-exception', detail: `exception ${entry.rule} ${JSON.stringify(entry.from)} allows ${entry.max} but ${used[index]} remain; lower max to ${used[index]}${used[index] === 0 ? ' (or delete it)' : ''} (owner ${entry.owner})` }] : []);
  return { failures: [...failures, ...stale], allowed: used.reduce((sum, count) => sum + count, 0) };
}

export function readModuleMap(path) {
  if (!existsSync(path)) throw new Error(`No module map at ${path}.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const moduleMapDirectory = path => dirname(path);
