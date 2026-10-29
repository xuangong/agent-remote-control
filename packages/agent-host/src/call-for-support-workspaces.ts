import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/** A support worktree is its own git top level; a stray directory inside the repository would resolve to the worker's repository instead. */
async function assertOwnWorktree(worktree: string): Promise<void> {
  const top = await git(worktree, ['rev-parse', '--show-toplevel']).then(value => realpath(value.trim()), () => undefined);
  if (top !== await realpath(worktree)) throw new Error(`${worktree} is not a support worktree. Remove the directory and call again.`);
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
    await assertOwnWorktree(worktree);
    const head = (await git(worktree, ['rev-parse', 'HEAD']).catch(() => '')).trim();
    if (!head.startsWith(commit) && head !== commit) throw new Error(`A support worktree already exists at ${worktree} on another commit.`);
  } else {
    await mkdir(dirname(worktree), { recursive: true });
    await git(root, ['worktree', 'add', '--detach', worktree, commit]);
  }
  const target = offset ? join(worktree, offset) : worktree;
  return { root, worktree, cwd: await exists(target) ? target : worktree };
}

/**
 * Removes a supporter's worktree and its support ref; a missing one is already removed.
 * The ref goes even when the directory cannot (a worktree's own HEAD keeps its commit), and the failure is reported for a retry.
 */
export async function removeWorktree(root: string, worktree: string): Promise<void> {
  const base = join(root, '.agent-remote', 'worktrees') + sep;
  if (!resolve(worktree).startsWith(base)) throw new Error('Refusing to remove a directory outside the support worktrees.');
  let failure: unknown;
  // A removal that deleted the files but not the directory leaves an empty directory git no longer knows; only an empty one is removed.
  if (await exists(worktree)) await git(root, ['worktree', 'remove', '--force', worktree]).catch(async error => { if (!await rmdir(worktree).then(() => true, () => false)) failure = error; });
  await git(root, ['worktree', 'prune']);
  // A remote supporter's fetched commit is kept reachable by its own ref.
  const [teamId, memberId] = relative(base, resolve(worktree)).split(sep);
  if (teamId && memberId) await git(root, ['update-ref', '-d', `refs/agent-remote/support/${teamId}/${memberId}`]).catch(() => undefined);
  if (failure) throw failure;
}

const BUNDLE_LIMIT = 50 * 1024 * 1024;

/** Everything a supporter changed in its worktree since the commit, including commits and new files, as one binary patch. */
export async function collectPatch(worktree: string, commit: string): Promise<string> {
  if (!COMMIT.test(commit)) throw new Error('Invalid commit.');
  // Staging runs in the supporter's own worktree, never in the worker's repository that contains it.
  await assertOwnWorktree(worktree);
  await git(worktree, ['add', '-A']);
  return git(worktree, ['diff', '--cached', '--binary', commit], { maxBuffer: BUNDLE_LIMIT });
}

/**
 * A bundle of the commit for a remote supporter: only the commits after base when base is given, else the full history.
 * The caller removes the returned directory.
 */
export async function createBundle(cwd: string, commit: string, base?: string): Promise<{ directory: string; file: string }> {
  if (!COMMIT.test(commit) || base !== undefined && !COMMIT.test(base)) throw new Error('Invalid commit.');
  const root = await repositoryRoot(cwd);
  if (!await hasCommit(root, commit)) throw new Error(`Commit ${commit} is not in the repository at ${root}. Commit the work and call again.`);
  if (base && !await hasCommit(root, base)) throw new Error(`Base ${base} is not in the repository at ${root}.`);
  const ref = `refs/agent-remote/bundle/${randomUUID()}`, directory = await mkdtemp(join(tmpdir(), 'agent-remote-bundle-')), file = join(directory, 'support.bundle');
  try {
    await git(root, ['update-ref', ref, commit]);
    // A base equal to the commit leaves nothing to send; the full history still lets the remote start there.
    try { await git(root, ['bundle', 'create', file, base ? `${base}..${ref}` : ref]); }
    catch (error) { if (!base) throw error; await git(root, ['bundle', 'create', file, ref]); }
    if ((await stat(file)).size > BUNDLE_LIMIT) throw new Error('The bundle exceeds 50 MiB. Call with a base commit the remote repository has.');
    return { directory, file };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  finally { await git(root, ['update-ref', '-d', ref]).catch(() => undefined); }
}

/** Fetches a bundle into a repository under a ref that keeps its commit reachable for the supporter's worktree. */
export async function fetchBundle(repository: string, file: string, teamId: string, memberId: string): Promise<void> {
  worktreePath('/', teamId, memberId);
  const root = await repositoryRoot(repository);
  const heads = (await git(root, ['bundle', 'list-heads', file])).trim().split('\n').map(line => line.split(' ')[1]).filter((ref): ref is string => !!ref);
  if (heads.length !== 1) throw new Error('The support bundle must name exactly one commit.');
  try { await git(root, ['fetch', '--no-tags', file, `${heads[0]}:refs/agent-remote/support/${teamId}/${memberId}`]); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : 'git fetch failed.'} If the repository lacks the base commit, call again without a base.`); }
}
