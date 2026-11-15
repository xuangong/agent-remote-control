import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'packages/agent-remote-lab/compatibility.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const fixedScope = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts'];
const skippedEntries = ['node_modules', 'dist', '.tmp', 'coverage', 'test-results', 'playwright-report', '.wrangler', 'compatibility.json'];
function skippedEntry(entry) {
  return skippedEntries.includes(entry) || entry === '.dev.vars' || (entry.startsWith('.dev.vars.') && !entry.endsWith('.example'))
    || entry.endsWith('.tsbuildinfo') || entry === '.DS_Store';
}
function git(args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean);
}
// The digest covers the files git tracks inside the scope, read from the working tree. Untracked files never count, so
// local state and half-finished files cannot change it.
const inScope = name => name.startsWith('packages/')
  ? (parts => parts.length > 2 && !skippedEntry(parts[2]) && !parts.includes('node_modules'))(name.split('/'))
  : fixedScope.some(entry => name === entry || name.startsWith(`${entry}/`));
const tracked = git(['ls-files', '-z', '--', ...fixedScope, 'packages']).filter(inScope);
const scope = [...fixedScope];
for (const entry of [...new Set(tracked.filter(name => name.startsWith('packages/')).map(name => name.split('/').slice(0, 3).join('/')))].sort()) scope.push(entry);
const files = new Map();
for (const name of tracked) {
  const target = resolve(root, name);
  let identity;
  try { identity = lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (identity.isSymbolicLink()) throw new Error(`Compatibility scope contains a symbolic link: ${target}`);
  if (!identity.isFile()) throw new Error(`Compatibility scope contains a non-file: ${target}`);
  files.set(name, target);
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
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...fixedScope, 'packages']).filter(inScope);
  if (untracked.length > 0) console.warn(`Warning: ${untracked.length} untracked file(s) in the compatibility scope are not part of the digest; git add them first:\n${untracked.map(name => `  ${name}`).join('\n')}`);
  manifest.borgee.baseRevision = '65143a95db212538461d5eafc49dea15988aa4e2';
  manifest.borgee.implementation = { algorithm: 'sha256', root: '../..', scope, digest };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Compatibility updated: ${digest}`);
}
