import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9-]{0,255}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const EXCLUDE = '.agent-remote/';

/** Runs git in a directory; its message is the error a coordinator or user reads. */
async function git(cwd: string, args: string[], options: { maxBuffer?: number } = {}): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr.slice(0, 1000)}` : '.'}`);
  }
}
const exists = (path: string) => stat(path).then(() => true, () => false);

/** The top-level directory of the repository that contains cwd. */
export async function repositoryRoot(cwd: string): Promise<string> {
  return realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
}

/** Where a supporter's worktree lives: inside the repository, so it stays within the roots the repository is allowed in. */
export function worktreePath(root: string, teamId: string, memberId: string): string {
  if (!IDENTITY.test(teamId) || !IDENTITY.test(memberId)) throw new Error('Invalid support worktree identity.');
  return join(root, '.agent-remote', 'worktrees', teamId, memberId);
}

async function excludeWorktrees(root: string): Promise<void> {
  const common = resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim());
  const file = join(common, 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes(EXCLUDE)) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${EXCLUDE}\n`);
}

async function hasCommit(root: string, commit: string): Promise<boolean> {
  return git(root, ['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false);
}

/**
 * A detached worktree at the commit for one supporter; an existing one at the same commit is reused.
 * Returns the worktree and, inside it, the directory that corresponds to cwd.
 */
export async function prepareWorktree(cwd: string, teamId: string, memberId: string, commit: string): Promise<{ root: string; worktree: string; cwd: string }> {
  if (!COMMIT.test(commit)) throw new Error('Invalid commit.');
  const root = await repositoryRoot(cwd), worktree = worktreePath(root, teamId, memberId);
  const offset = relative(root, await realpath(cwd));
  if (offset.startsWith('..')) throw new Error('The working directory is outside its repository.');
  if (!await hasCommit(root, commit)) throw new Error(`Commit ${commit} is not in the repository at ${root}. Commit the work and call again.`);
  await excludeWorktrees(root);
  if (await exists(worktree)) {
    const head = (await git(worktree, ['rev-parse', 'HEAD']).catch(() => '')).trim();
    if (!head.startsWith(commit) && head !== commit) throw new Error(`A support worktree already exists at ${worktree} on another commit.`);
  } else {
    await mkdir(dirname(worktree), { recursive: true });
    await git(root, ['worktree', 'add', '--detach', worktree, commit]);
  }
  const target = offset ? join(worktree, offset) : worktree;
  return { root, worktree, cwd: await exists(target) ? target : worktree };
}

/** Removes a supporter's worktree; a missing one is already removed. */
export async function removeWorktree(root: string, worktree: string): Promise<void> {
  const base = join(root, '.agent-remote', 'worktrees') + sep;
  if (!resolve(worktree).startsWith(base)) throw new Error('Refusing to remove a directory outside the support worktrees.');
  if (await exists(worktree)) await git(root, ['worktree', 'remove', '--force', worktree]);
  await git(root, ['worktree', 'prune']);
}
