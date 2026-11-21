// The implementation digest of the compatibility manifest: what it covers, when a stale one fails, and how two manifests merge.
// The digest hashes every tracked source file, so any edit changes it and two branches always carry two values. Task branches
// therefore never update it: it is regenerated and checked on main after a merge (`pnpm postmerge`), and before a release.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const manifestPath = 'packages/agent-relay-node/compatibility.json';
const baseRevision = '65143a95db212538461d5eafc49dea15988aa4e2';
const fixedScope = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts'];
const skippedEntries = ['node_modules', 'dist', '.tmp', 'coverage', 'test-results', 'playwright-report', '.wrangler', 'compatibility.json'];
function skippedEntry(entry) {
  return skippedEntries.includes(entry) || entry === '.dev.vars' || (entry.startsWith('.dev.vars.') && !entry.endsWith('.example'))
    || entry.endsWith('.tsbuildinfo') || entry === '.DS_Store';
}
function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean);
}
const inScope = name => name.startsWith('packages/')
  ? (parts => parts.length > 2 && !skippedEntry(parts[2]) && !parts.includes('node_modules'))(name.split('/'))
  : fixedScope.some(entry => name === entry || name.startsWith(`${entry}/`));

/**
 * The implementation block for the source tree at `root`: the files git tracks inside the scope, read from the working tree.
 * Untracked files never count, so local state and half-finished files cannot change it.
 */
export function implementationOf(root) {
  const tracked = git(root, ['ls-files', '-z', '--', ...fixedScope, 'packages']).filter(inScope);
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
  return { algorithm: 'sha256', root: '../..', scope, digest: `sha256:${hash.digest('hex')}` };
}

/** The untracked files inside the scope, which the digest leaves out until they are added. */
export function untrackedInScope(root) {
  return git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...fixedScope, 'packages']).filter(inScope);
}

/** Whether the manifest's digest and scope are those of `implementation`. */
export function isCurrent(manifest, implementation) {
  return manifest.borgee?.implementation?.digest === implementation.digest
    && JSON.stringify(manifest.borgee?.implementation?.scope) === JSON.stringify(implementation.scope);
}

/** The manifest with `implementation` in place of its own; the hand-written parts stay as they are. */
export function withImplementation(manifest, implementation) {
  return { ...manifest, borgee: { ...manifest.borgee, baseRevision, implementation } };
}

export const serialize = manifest => `${JSON.stringify(manifest, null, 2)}\n`;

/** The branch checked out at `root`, or null for a detached HEAD (a release tag, a deploy worktree, a rebase in progress). */
export function currentBranch(root) {
  const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Whether a stale digest fails the check. It does on main, on a detached HEAD (release tags and deploy worktrees), in GitHub
 * Actions and with --strict. On any other branch, a task branch, a stale digest is expected: it is reported and passes.
 */
export function staleDigestFails({ branch, strict = false, env = {} }) {
  return strict || env.GITHUB_ACTIONS === 'true' || branch === null || branch === 'main';
}

/**
 * The git configuration of the manifest's merge driver (`merge=arc-compatibility` in .gitattributes). Git runs it at the top of
 * the work tree; a checkout from before the driver existed merges the file as plain text.
 */
export const mergeDriver = {
  'merge.arc-compatibility.name': 'compatibility manifest: hand-written parts merged, digest regenerated on main',
  'merge.arc-compatibility.driver': 'if [ -f scripts/compatibility-merge.mjs ]; then node scripts/compatibility-merge.mjs %O %A %B %P; '
    + 'else git merge-file -L ours -L base -L theirs %A %O %B; fi',
};

/** `git merge-file` over three texts: the merged text, with conflict markers when `conflicts` is above 0. */
function mergeFile(ours, base, theirs) {
  const directory = mkdtempSync(join(tmpdir(), 'arc-compatibility-merge-'));
  try {
    const paths = ['ours', 'base', 'theirs'].map(name => join(directory, name));
    [ours, base, theirs].forEach((text, index) => writeFileSync(paths[index], text));
    const result = spawnSync('git', ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', ...paths], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (result.error) throw result.error;
    // The exit status is the number of conflicts, at most 127; anything else is an error.
    if (result.status === null || result.status > 127) throw new Error(`git merge-file failed: ${result.stderr.trim()}`);
    return { text: result.stdout, conflicts: result.status };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Merges three versions of the manifest as git's merge driver does. The implementation block is taken from `ours` on every
 * side, since the merged tree has a digest of its own that only a regeneration gives; the hand-written rest (protocol version,
 * providers) merges like any text, so only a real conflict there is reported. A side that is not JSON merges as plain text.
 */
export function mergeManifests({ base, ours, theirs }) {
  const parse = text => { if (!text.trim()) return null; try { return JSON.parse(text); } catch { return undefined; } };
  const [baseManifest, ourManifest, theirManifest] = [base, ours, theirs].map(parse);
  if ([baseManifest, ourManifest, theirManifest].includes(undefined)) return { ...mergeFile(ours, base, theirs), keptImplementation: false };
  const implementation = ourManifest?.borgee?.implementation ?? theirManifest?.borgee?.implementation;
  const normalized = (manifest, text) => manifest?.borgee && implementation ? serialize({ ...manifest, borgee: { ...manifest.borgee, implementation } }) : text;
  const keptImplementation = JSON.stringify(theirManifest?.borgee?.implementation) !== JSON.stringify(implementation);
  return { ...mergeFile(normalized(ourManifest, ours), normalized(baseManifest, base), normalized(theirManifest, theirs)), keptImplementation };
}
