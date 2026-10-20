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
const files = new Map();
function collect(target) {
  const identity = lstatSync(target);
  if (identity.isSymbolicLink()) throw new Error(`Compatibility scope contains a symbolic link: ${target}`);
  if (identity.isDirectory()) {
    for (const name of readdirSync(target).sort()) collect(resolve(target, name));
  } else if (identity.isFile()) files.set(relative(root, target).split(sep).join('/'), target);
  else throw new Error(`Compatibility scope contains a non-file: ${target}`);
}
for (const entry of scope) collect(resolve(root, entry));
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
