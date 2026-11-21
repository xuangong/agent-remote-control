// The step after a merge into main: regenerate the files that task branches never commit, commit them alone, and check them.
// Each regeneration is { label, paths, write(): boolean (whether it changed its files), check(): { verified } | { failure } }.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentBranch } from './compatibility.mjs';

/** Why the step cannot run: not on main, a git operation in progress, or changes to tracked files it would not commit. */
export function refusal({ branch, operation, changed }) {
  if (branch !== 'main') return `pnpm postmerge runs on main after a merge; ${branch ? `this is ${branch}` : 'HEAD is detached'}.`
    + ' A task branch leaves the generated files alone (pnpm compatibility:check reports a stale digest and passes).';
  if (operation) return `Finish the ${operation} first; pnpm postmerge regenerates from a committed tree.`;
  if (changed.length) return `Commit or set aside these changes first; the regenerated files are computed from the working tree:\n${changed.map(path => `  ${path}`).join('\n')}`;
  return null;
}

const operations = { MERGE_HEAD: 'merge', CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase' };

/** Runs the step in the repository at `root` and returns its exit status. */
export function postmerge({ root, regenerations, log = console.log, error = console.error }) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (result.error) throw result.error;
    return result;
  };
  const generated = regenerations.flatMap(({ paths }) => paths);
  const operation = Object.entries(operations).find(([name]) => existsSync(resolve(root, git(['rev-parse', '--git-path', name]).stdout.trim())))?.[1];
  const changed = git(['diff', '--name-only', '-z', 'HEAD', '--']).stdout.split('\0').filter(path => path && !generated.includes(path));
  const refused = refusal({ branch: currentBranch(root), operation, changed });
  if (refused) {
    error(refused);
    return 1;
  }
  const written = regenerations.filter(regeneration => regeneration.write());
  if (written.length) {
    const title = `chore: ${written.map(({ label }) => label).join(', ')}`;
    const commit = git(['commit', '--quiet', '-m', title, '-m', 'Regenerated on main after a merge by pnpm postmerge.', '--', ...written.flatMap(({ paths }) => paths)]);
    if (commit.status !== 0) {
      error(`git commit failed:\n${commit.stderr}`);
      return 1;
    }
    log(`Committed ${git(['rev-parse', '--short', 'HEAD']).stdout.trim()} ${title}`);
  } else {
    log('Nothing to regenerate: the generated files match the tree.');
  }
  const results = regenerations.map(({ check }) => check());
  for (const { failure } of results.filter(result => result.failure)) error(`postmerge: ${failure}.`);
  if (results.some(result => result.failure)) return 1;
  log(`Verified on main: ${results.map(({ verified }) => verified).join('; ')}.`);
  return 0;
}
