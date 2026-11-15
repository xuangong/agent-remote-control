import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'packages/agent-remote-lab/compatibility.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const scope = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts'];
function ignored(entry) {
  try { execFileSync('git', ['check-ignore', '-q', '--no-index', entry], { cwd: root, stdio: 'ignore' }); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
function containsFile(target) {
  const identity = lstatSync(target);
  return !identity.isDirectory() || readdirSync(target).some(name => containsFile(resolve(target, name)));
}
for (const name of readdirSync(resolve(root, 'packages')).sort()) {
  const prefix = `packages/${name}`;
  for (const entry of readdirSync(resolve(root, prefix)).sort()) {
    if (['node_modules', 'dist', '.tmp', 'coverage', 'test-results', 'playwright-report', '.wrangler', 'compatibility.json'].includes(entry)) continue;
    if (entry === '.dev.vars' || (entry.startsWith('.dev.vars.') && !entry.endsWith('.example'))) continue;
    if (entry.endsWith('.tsbuildinfo') || entry === '.DS_Store') continue;
    // Local tool state such as ignored worktrees or empty editor directories is not part of the implementation.
    if (ignored(`${prefix}/${entry}`) || !containsFile(resolve(root, prefix, entry))) continue;
    scope.push(`${prefix}/${entry}`);
  }
}
const entries = [];
function walk(target) {
  const identity = lstatSync(target);
  entries.push({ target, directory: identity.isDirectory() });
  if (identity.isDirectory()) {
    for (const name of readdirSync(target).sort()) if (name !== 'node_modules') walk(resolve(target, name));
  }
}
for (const entry of scope) walk(resolve(root, entry));
// Git-ignored files at any depth (editor files, caches) are local state, so one batched query drops them before anything is hashed.
function ignoredPaths(paths) {
  if (paths.length === 0) return new Set();
  try {
    const output = execFileSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: root, input: paths.join('\0') + '\0', maxBuffer: 1 << 28 });
    return new Set(output.toString('utf8').split('\0').filter(Boolean));
  } catch (error) { if (error.status === 1) return new Set(); throw error; }
}
const relativeName = target => relative(root, target).split(sep).join('/');
const ignoredNames = ignoredPaths(entries.map(({ target }) => relativeName(target)));
const files = new Map();
for (const { target } of entries) {
  const name = relativeName(target);
  if (ignoredNames.has(name) || [...ancestorsOf(name)].some(ancestor => ignoredNames.has(ancestor))) continue;
  const identity = lstatSync(target);
  if (identity.isSymbolicLink()) throw new Error(`Compatibility scope contains a symbolic link: ${target}`);
  if (identity.isFile()) files.set(name, target);
  else if (!identity.isDirectory()) throw new Error(`Compatibility scope contains a non-file: ${target}`);
}
function* ancestorsOf(name) {
  for (let at = name.indexOf('/'); at !== -1; at = name.indexOf('/', at + 1)) yield name.slice(0, at);
}
const hash = createHash('sha256');
for (const [name, target] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  hash.update(name); hash.update('\0'); hash.update(readFileSync(target)); hash.update('\0');
}
const digest = `sha256:${hash.digest('hex')}`;
if (process.argv.includes('--check')) {
  if (manifest.borgee.implementation.digest !== digest || JSON.stringify(manifest.borgee.implementation.scope) !== JSON.stringify(scope)) {
    throw new Error('Compatibility manifest differs from this source tree. Run pnpm compatibility:update after reviewing the source changes.');
  }
  console.log(`Compatibility verified: ${digest}`);
} else {
  manifest.borgee.baseRevision = '65143a95db212538461d5eafc49dea15988aa4e2';
  manifest.borgee.implementation = { algorithm: 'sha256', root: '../..', scope, digest };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Compatibility updated: ${digest}`);
}
